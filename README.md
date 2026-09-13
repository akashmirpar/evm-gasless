# evm-gasless

Gasless transactions for any EIP-7702 chain. A user holding only an ERC-20 — no ETH, no BNB — signs once, and an operator pays the gas and executes their intent. The user pays the operator a small fee in the token they already have.

Live on **BSC**, **Base** and **Arbitrum**. Any EIP-7702-capable chain can be added by config.

## How it works

1. The user delegates their EOA to `GaslessDelegate` with an **EIP-7702 authorization** — their address keeps its balances and history, but gains the contract's execution logic.
2. They sign an **EIP-712 batch**: a fee transfer to the operator's treasury, then their own operations as an atomic group.
3. The operator submits the **type-4 transaction** and pays the gas. The batch runs in two zones: the fee ops must succeed; the user's intent is isolated in a self-call, so if it reverts the fee still settles and the nonce still advances.
4. If the user's fee token isn't one the operator accepts directly, the fee leg becomes an approve + on-chain swap (routed via Rango) into one that is — same transaction, same signature.

The delegate is deployed via **CREATE2 with a frozen salt**, so it sits at one identical address on every chain.

## Repository layout

```
contract/   GaslessDelegate.sol (Foundry) — EIP-712 batch verification, must-succeed / atomic zones, CREATE2 deploy
backend/    NestJS relayer — fee estimation, batch building, EIP-7702 broadcast, crash-safe status machine
chains/     deployed.json — the delegate address per chain
docs/       integration guide, API reference, architecture, error codes
```

## Quick start

```sh
# backend
cd backend
cp .env.example .env            # fill in the operator seed, treasury, RPC key
npm install
npm run migration:run
npm run seed:admin -- --name root
npm run start:dev               # http://localhost:3100  (swagger at /swagger)

# contract
cd contract
forge test
```

## Integrating

Four endpoints, all under `/gasless/transactions`:

| | |
|---|---|
| `POST …/estimate` | fee quote in the user's chosen token |
| `POST …` | build the batch → EIP-712 typed data to sign + `requestId` |
| `POST …/:requestId/submit` | user's signature + EIP-7702 authorization → broadcast |
| `GET …/:requestId` | status, tx hash, failure reason |

Start with [docs/integration-guide.md](docs/integration-guide.md). Full shapes are in [docs/api-reference.md](docs/api-reference.md).

## Docs

- [Architecture](docs/architecture.md) — components, data flow, who signs what
- [Integration guide](docs/integration-guide.md) — end-to-end with a TypeScript sample
- [API reference](docs/api-reference.md)
- [Error codes](docs/error-codes.md)
- [State machine & scheduler](docs/state-machine-and-scheduler.md) — how the relayer stays crash-safe
- [Contract docs](contract/docs/) — EIP-712 hashing, the atomic-group design, permissionless submission

## Safety properties

- **Sign once, persist, then broadcast.** The signed transaction is stored before it is sent; a retry re-sends the same bytes and never re-signs with a new nonce.
- **No double-charge.** The batch nonce lives in the delegate; a replayed signature reverts.
- **Bounded retries.** A request that keeps failing backs off and terminates instead of looping.
- **No-loss ceiling.** The operator refuses quotes where the fee could not cover the network cost.
