# evm-gasless

Gasless transactions for any EIP-7702 chain. A user holding only an ERC-20 signs once; an operator pays the gas, executes the user's intent, and is paid a small fee in the token the user already holds.

Live on BSC, Base and Arbitrum. Any EIP-7702-capable chain can be added by configuration.

## Where to start

| If you want to | Read |
| --- | --- |
| Wire a wallet or dApp to the relayer | [Integration guide](integration-guide.md) |
| Look up a request or response field | [API reference](api-reference.md) |
| Understand what an error code means and what to do | [Error codes](error-codes.md) |
| Understand the system before integrating | [Architecture](architecture.md) |
| Understand the on-chain contract | [Contract architecture](contract/architecture.md) |

## Endpoints

The API is served at `https://gasless-api.paytopedia.top`. Every route requires an integrator key on the `x-api-key` header.

| | |
| --- | --- |
| `POST /gasless/transactions/estimate` | Fee quote in the user's chosen token |
| `POST /gasless/transactions` | Build the batch: EIP-712 typed data to sign, plus a `requestId` |
| `POST /gasless/transactions/:requestId/submit` | The user's signature and EIP-7702 authorization; the relayer broadcasts |
| `GET /gasless/transactions/:requestId` | Status, transaction hash, failure reason |

The OpenAPI document is at [/swagger](https://gasless-api.paytopedia.top/swagger).

## How a transaction works

1. The user delegates their EOA to `GaslessDelegate` with an EIP-7702 authorization. The address keeps its balances and history and gains the contract's execution logic.
2. They sign an EIP-712 batch: a fee transfer to the operator's treasury, then their own operations as an atomic group.
3. The operator submits the type-4 transaction and pays the gas. The fee operations must succeed; the user's intent runs in an isolated self-call, so if it reverts the fee still settles and the nonce still advances.
4. If the user's fee token is not one the operator accepts directly, the fee leg becomes an approve and an on-chain swap into one that is — same transaction, same signature.

The delegate contract is deployed with CREATE2 from a frozen salt, so it has one address on every chain: `0x2e80ca7db998b5e77B7714C5Ca71FEC26699b8fe`.
