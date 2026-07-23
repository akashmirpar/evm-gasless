# API reference

Base URL: whatever your backend deployment exposes. Default in development: `http://localhost:3578`. The OpenAPI/Swagger view is at `/swagger`.

This doc covers the **EVM** endpoints (`/gasless/transactions/*`). For Solana support (`/gasless/solana/transactions/*`), see [solana.md](solana.md) — the shape is different enough that polymorphism would have been more confusing than helpful.

## Response envelope

Every response — success or failure — is wrapped:

```jsonc
// success
{ "success": true, "data": <endpoint-specific payload> }

// failure
{ "success": false, "error": { "code": <number>, "message": <string>, "causes"?: [...] } }
```

`code` is the numeric error code from [error-codes.md](error-codes.md). HTTP status matches the error's `httpCode` (400, 404, 409, 410, 422, 500, 502, 503).

## Common request fields

Multiple endpoints share these fields:

| Field | Type | Notes |
|-------|------|-------|
| `chainId` | `number` | EVM chain id. Must be a chain configured in `config.yaml` (the `chains:` section). |
| `userAddress` | `string` | The end-user's EOA. The delegated EOA that runs `GaslessDelegate`. Normalized to lowercase by the backend; clients can pass either case or with/without `0x`. |
| `feeTokenAddress` | `string` | ERC-20 the user wants to pay the fee in. Either an address in the chain's `tokens` list in `config.yaml`, or `0xEeeeeEEee…eEEEE` for native (`NATIVE_TOKEN_SENTINEL`). |
| `operations` | `UserOp[]` | The user's intent ops (atomic group). Each op: `{ chainId, to, value, data }`. `value` is a non-negative integer string (wei). `data` is `0x`-prefixed hex (can be `"0x"` for empty). |

## `POST /gasless/transactions/estimate`

Stateless. Returns a fee quote in the user's chosen fee token.

**Request body**

```json
{
  "chainId": 56,
  "userAddress": "0xUser…",
  "feeTokenAddress": "0xToken…",
  "operations": [
    { "chainId": 56, "to": "0xRecipient…", "value": "0", "data": "0x…" }
  ]
}
```

**Success response (`201 Created` — Nest's default for POST)**

```json
{
  "success": true,
  "data": {
    "feeTokenAddress": "0x…",
    "feeAmount": "1500000",
    "acceptedFeeToken": true,
    "swapRoute": null
  }
}
```

- `feeAmount` is the fee in the user's fee token, as a wei string.
- `acceptedFeeToken: true` means the operator accepts this token directly; the backend will build a single `ERC20.transfer` to treasury.
- `acceptedFeeToken: false` means a swap is required; `swapRoute` describes the inferred conversion:
  ```json
  "swapRoute": {
    "inputToken": "0xUnsupported…",
    "outputToken": "0xAccepted…",
    "outputAmount": "1500000"
  }
  ```

Likely error codes: `CHAIN_NOT_SUPPORTED (20001)`, `CHAIN_TOKEN_NOT_FOUND (20004)`, `GASLESS_FEE_TOKEN_NOT_ACCEPTED_AND_NO_ROUTE (40002)`, `RANGO_REQUEST_FAILED (30001)`, `RANGO_NO_ROUTE (30002)`.

## `POST /gasless/transactions`

Builds the signable batch and stashes it in Redis. The user has up to `GASLESS_CREATE_TTL_SECONDS` to submit before the request expires.

**Request body** — identical shape to `/estimate`.

**Success response (`201 Created`)**

```json
{
  "success": true,
  "data": {
    "requestId": "9b3a…uuid",
    "delegateContractAddress": "0x7AF705BEA2Aa1F1cB4ffB18cbB94B26Bba343a87",
    "chainId": 56,
    "nonce": "10",
    "atomicGroupStart": 1,
    "operations": [
      { "to": "0xFeeToken…", "value": "0", "data": "0xa9059cbb…" },
      { "to": "0xRecipient…", "value": "0", "data": "0x…" }
    ],
    "digest": "0xabc…32-byte hex",
    "expiresAtSeconds": 1715600000
  }
}
```

- `delegateContractAddress` — what the user signs the EIP-7702 authorization tuple against. Different per chain.
- `nonce` — the user EOA's current `nonce()` value on `GaslessDelegate`. The user signs this exact value in the EIP-712 batch.
- `atomicGroupStart` — index where the atomic group begins inside `operations`.
- `operations` — what the user must include in the signed batch, in exact order. Op fields are lowercase canonical.
- `digest` — convenience: the EIP-712 hash the client should produce. Compute the same digest locally and compare as a sanity check.
- `expiresAtSeconds` — Unix seconds when the Redis stash will be dropped.

Likely error codes: same as `/estimate`, plus `CHAIN_NO_DEPLOYED_CONTRACT (20003)` if the chain has no delegate address in `deployed.json`.

## `POST /gasless/transactions/:requestId/submit`

User signs the prepared batch + an EIP-7702 authorization, then sends both. Backend verifies and persists.

**Request body**

```json
{
  "signature": "0x…130-char EIP-712 sig…",
  "authorization": {
    "chainId": 56,
    "address": "0xDelegateContract…",
    "nonce": "<EOA's transaction count, as a decimal string>",
    "signature": "0x…130-char EIP-7702 auth sig…"
  }
}
```

The two signatures are independent:
1. **`signature`** — produced by `eth_signTypedData_v4` (or `wallet.signTypedData()` in ethers v6) over the `Batch` struct using the domain returned from `/transactions`. Must recover to `userAddress`.
2. **`authorization.signature`** — produced by `wallet.authorize({ address, nonce, chainId })` in ethers v6. The `address` field MUST equal `delegateContractAddress` from `/transactions`, and `chainId` MUST match.

**Success response (`201 Created`)**

```json
{ "success": true, "data": { "requestId": "9b3a…uuid", "status": "0" } }
```

The numeric `status` is `0` for `PENDING`. Poll the GET endpoint for terminal status.

Likely error codes: `GASLESS_REQUEST_EXPIRED (40004)`, `GASLESS_INVALID_SIGNATURE (40005)`, `GASLESS_INVALID_AUTHORIZATION (40006)`, `GASLESS_REQUEST_ALREADY_SUBMITTED (40007)`.

## `GET /gasless/transactions/:requestId`

Read the current status of a submitted request.

**Success response (`200 OK`)**

```json
{
  "success": true,
  "data": {
    "requestId": "9b3a…uuid",
    "status": "MINED_SUCCESS",
    "chainId": 56,
    "txHash": "0xabc…",
    "retryTimes": 0,
    "failureReason": null,
    "createdAt": "2026-05-14T17:00:00.000Z",
    "updatedAt": "2026-05-14T17:00:45.000Z"
  }
}
```

Status values:

| Value | Meaning |
|-------|---------|
| `PENDING` | Submitted; waiting for the relayer poller to broadcast. |
| `BROADCASTING` | Relayer is mid-broadcast (transient, rare to observe). |
| `BROADCASTED` | Broadcast succeeded, tx hash recorded, waiting for receipt. |
| `MINED_SUCCESS` | Tx mined with `receipt.status === 1`. Whole batch ran (atomic group may still have reverted — check on-chain events). |
| `MINED_FAILED` | Tx mined with `receipt.status === 0`. Whole tx reverted (must-succeed zone failed, or wrong nonce, or bad signature). `failureReason` may include detail. |
| `FAILED_PERMANENT` | Relayer exhausted retries before getting a receipt. Operator-side investigation needed. |

Likely error codes: `GASLESS_REQUEST_NOT_FOUND (40003)`.

## `GET /health`

Standard Terminus check. Returns `200 OK` when the database is reachable, `503 Service Unavailable` otherwise.

## Conventions and gotchas

- **Numeric token amounts are always wei strings, never decimals.** `"1500000"` for 1.5 USDT at 6 decimals.
- **Empty calldata is `"0x"`, not `""` or `null`.**
- **Native fee payment:** pass `0xEeeeeEEee…eEEEE` as `feeTokenAddress`. The backend treats this as the chain's native token.
- **Idempotency:** `POST /gasless/transactions` always returns a new `requestId` even for identical inputs — every call costs one cached stash. Submit is idempotent on `requestId` via a `409 GASLESS_REQUEST_ALREADY_SUBMITTED` if you call it twice.
- **The signature must match the prepared `operations` byte-for-byte, including byte case in addresses.** The backend canonicalizes everything to lowercase before signing-hash computation. If your wallet preserves checksum case, the resulting digest will still match because EIP-712 hashes addresses as 20-byte values, not strings.
