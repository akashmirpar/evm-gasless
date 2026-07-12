# gasless/backend

NestJS service that accepts user-defined EVM operations, returns a signable EIP-712 batch (with treasury fee built in, either as a direct transfer or as an approve + Rango swap when the user's fee token isn't accepted), and broadcasts an EIP-7702 type-4 transaction on the user's behalf.

## Layout

```
src/
├── common/                conventions infra (errors, base entities, address, utils)
├── core/
│   ├── chain_config/      reads gasless/chains/chains.json + deployed.json + env overrides
│   ├── context/           IContext / RequestContext / SystemContext + transitionStatus()
│   ├── database/          TypeORM data source + migrations
│   ├── fsm/               StateMachine<S, A>, transitionStatus()
│   ├── health/            /health
│   └── rpc/               RPC fallback wrapper
└── modules/
    ├── rango/             abstract RangoClient + HTTP impl + MockRangoClient (test)
    ├── relayer/           TransactionRequest entity, FSM, EVM executor, poller job
    └── gasless/           HTTP endpoints + fee estimator + batch builder
```

## Authentication

Every route under `/gasless/*` requires an integrator API key on the `x-api-key` header. Every route under `/admin/*` requires an admin key on the `x-admin-key` header. Keys are UUIDs. Both surfaces share a per-IP failed-auth budget (5 hits / 1 s window) so a bad-key flood cannot amplify into one DB lookup per request.

Keys are stored plaintext with a unique index. On successful lookup, the row is cached in Redis for 5 minutes; mutations invalidate the cache immediately.

### First-run bootstrap

Right after `migration:run` you have zero admins and no way in. The included CLI mints exactly one:

```sh
npm run seed:admin -- --name root
```

It refuses to run if any active admin already exists. The plaintext key is printed once — store it. Use it against `POST /admin/admins` to create additional admins, or `POST /admin/api-keys` to mint integrator keys.

Deactivating the last active admin with a key is refused (409 / `ADMIN_CANNOT_DEACTIVATE_LAST_ADMIN`) — this is what keeps operators from locking themselves out.

### Admin endpoints

- `GET /admin/admins`, `POST /admin/admins`, `PATCH /admin/admins/:id/active`, `POST /admin/admins/:id/rotate-key`, `DELETE /admin/admins/:id`
- `GET /admin/api-keys`, `POST /admin/api-keys`, `PATCH /admin/api-keys/:id`, `PATCH /admin/api-keys/:id/active`, `DELETE /admin/api-keys/:id`

Every mutation writes an `api_key_audit` or `admin_audit` row in the same transaction, tagged with the actor's admin id, IP, and user-agent.

## Endpoints

All responses are wrapped in `{ "success": true, "data": <…> }` (or `{ "success": false, "error": { code, message, causes? } }` on failure).

### `POST /gasless/transactions/estimate`

Returns the fee in the user's fee token. **Stateless** — does not persist anything.

Request:
```json
{
  "chainId": 56,
  "userAddress": "0xUser…",
  "feeTokenAddress": "0xToken…",
  "operations": [
    { "chainId": 56, "to": "0x…", "value": "0", "data": "0x…" }
  ]
}
```

Response:
```json
{
  "feeTokenAddress": "0x…",
  "feeAmount": "1500000",
  "acceptedFeeToken": true,
  "swapRoute": null
}
```

If `acceptedFeeToken` is `false`, `swapRoute` is populated with the Rango leg used to convert the user's fee token into the operator's accepted token.

### `POST /gasless/transactions`

Builds the full operation list the user needs to sign. The list is stashed in Redis with a TTL (`GASLESS_CREATE_TTL_SECONDS`, default 300s); the user has that long to come back and submit.

Returns:
- `requestId` — opaque id used in the submit/status endpoints.
- `delegateContractAddress` — address of `GaslessDelegate` on this chain. The user signs an EIP-7702 authorization tuple pointing to this address.
- `nonce`, `atomicGroupStart`, `operations`, `digest` — everything needed for the user to sign the EIP-712 batch.
- `expiresAtSeconds` — unix timestamp when the Redis stash expires.

The shape of `operations` depends on the fee path:
- **Accepted fee token**: `operations[0]` is a direct `ERC20.transfer(treasury, amount)` call on the user's fee token. `atomicGroupStart = 1`. The rest are the user's intent ops.
- **Unsupported fee token**: `operations[0]` is `ERC20.approve(rangoRouter, amount)`, `operations[1]` is the Rango swap calldata with the treasury as `recipient`. `atomicGroupStart = 2`. The rest are the user's intent ops.

### `POST /gasless/transactions/:requestId/submit`

The user signs the EIP-712 digest with their EOA private key and an EIP-7702 authorization tuple binding their EOA to `delegateContractAddress`. Both go here:

```json
{
  "signature": "0x…65-byte EIP-712 sig…",
  "authorization": {
    "chainId": 56,
    "address": "0xDelegateContract…",
    "nonce": "<eoa transaction count>",
    "signature": "0x…65-byte EIP-7702 sig…"
  }
}
```

On success the service:
- Verifies the EIP-712 signature recovers to `userAddress`.
- Verifies the authorization shape matches the chain/contract committed to during create.
- Persists a `transaction_request` row in `PENDING`.
- Drops the Redis stash.

The relayer poller picks the row up, broadcasts the type-4 tx via ethers v6, and transitions the FSM through `BROADCASTING → BROADCASTED → MINED_SUCCESS | MINED_FAILED`.

### `GET /gasless/transactions/:requestId`

Returns the current status:

```json
{
  "requestId": "uuid",
  "status": "PENDING | BROADCASTING | BROADCASTED | MINED_SUCCESS | MINED_FAILED | FAILED_PERMANENT",
  "chainId": 56,
  "txHash": "0x…",
  "retryTimes": 0,
  "failureReason": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

## Status FSM

```
PENDING ─START_BROADCAST─▶ BROADCASTING ─BROADCAST_SUCCEEDED─▶ BROADCASTED
                                │                                  │
                                │ BROADCAST_FAILED                 ├─MARK_MINED_SUCCESS─▶ MINED_SUCCESS
                                ▼                                  └─MARK_MINED_FAILED──▶ MINED_FAILED
                              PENDING (retry)

PENDING / BROADCASTING / BROADCASTED ─GIVE_UP─▶ FAILED_PERMANENT
```

`PENDING ↔ BROADCASTING` round-trips on transient broadcast failures — the row's `retryTimes` bumps and `nextRetryTime` is set per a deterministic exponential backoff. After `RELAYER_MAX_RETRIES` (default 6), the row transitions to `FAILED_PERMANENT` and stays there for operator inspection.

Receipt fetching happens once the row is in `BROADCASTED` — the poller re-selects rows whose `nextRetryTime` has elapsed and either:
- finds a receipt and transitions to `MINED_SUCCESS` / `MINED_FAILED`, or
- finds nothing yet and bumps `nextRetryTime` for the next tick.

Every transition writes a row to `transition_log` in the same transaction; status mutation goes exclusively through `transitionStatus()` ([src/core/fsm/transition_status.ts](src/core/fsm/transition_status.ts)).

## Permissionless submission

The on-chain contract treats `executeBatch` as permissionless (any address can submit a signed batch — see [../contract/docs/architecture.md](../contract/docs/architecture.md)). The backend's submitter wallet (`OPERATOR_PRIVATE_KEY`) is just whoever pays the gas and receives the treasury payment in the must-succeed zone. There is no on-chain trust placed in the operator.

## Configuration

See [.env.example](.env.example). The most important groups:

- `OPERATOR_PRIVATE_KEY` + `GASLESS_TREASURY_ADDRESS` — operator identity. The treasury is what `ops[0]` pays into in the accepted-token case (and the recipient passed to Rango in the unsupported-token case).
- `GASLESS_ACCEPTED_FEE_TOKENS` — comma-separated list of `chainId:SYMBOL` or `0xtoken` entries. Tokens matching any entry on a given chain are treated as directly accepted (no swap). Everything else triggers the Rango path.
- `<CHAIN>_RPC_URLS` — comma-separated overrides per chain. The defaults in [../chains/chains.json](../chains/chains.json) are appended as fallbacks. RPC failure cascades through the list until one succeeds.
- `RELAYER_CRON` / `RELAYER_MAX_RETRIES` / `RELAYER_RETRY_*_MS` — tune poll frequency, retry cap, backoff.

## Development

```sh
npm install

# 1. Create the shared external network once (pgadmin / other tools join the same).
docker network create back_net_${DEV_NAME:-local} 2>/dev/null || true

# 2. Bring up postgres + redis from docker-compose.dev.yml.
docker compose -f docker-compose.dev.yml up -d

# 3. Apply migrations and start the app.
npm run build && npm run migration:run
npm run start:dev
# swagger at http://localhost:3100/swagger
```

`docker-compose.dev.yml` uses `${DEV_NAME}` to namespace containers/volumes so multiple devs (or multiple branches) can share one host. It attaches both services to the **external** network `back_net_${DEV_NAME}`, so pgadmin (or any other tool running in another compose project) can reach the database by joining the same network.

## Testing

```sh
# unit / service tests (in-process)
npm test

# end-to-end against a real chain — requires funded test wallets in .env
# (E2E_USER_PRIVATE_KEY, E2E_OPERATOR_PRIVATE_KEY, E2E_CHAIN_ID,
#  E2E_TREASURY_ADDRESS, E2E_SUPPORTED_FEE_TOKEN, E2E_UNSUPPORTED_FEE_TOKEN,
#  E2E_DELEGATE_CONTRACT_ADDRESS, E2E_RPC_URL).
# The suite covers both the accepted-fee-token and the unsupported-fee-token
# (Rango-swap) paths end-to-end: estimate → create → user signs → submit →
# poll status → assert MINED_SUCCESS and treasury balance change on chain.
npm run test:e2e
```

If `E2E_USER_PRIVATE_KEY` and `E2E_OPERATOR_PRIVATE_KEY` aren't set, the e2e suite is skipped automatically.
