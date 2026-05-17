# Gasless — integration docs

This directory documents the gasless transaction relayer system so other projects can integrate with it. The system has two pieces:

- **`gasless/contract/`** — the `GaslessDelegate` Solidity contract. Users delegate their EOA to this contract via EIP-7702; the contract verifies user-signed EIP-712 batches and runs them in two zones (must-succeed fee ops, then atomic group of user intent).
- **`gasless/backend/`** — the NestJS relayer service. Estimates fees in the user's chosen fee token (with optional Rango swap), builds the signable batch, broadcasts the type-4 transaction after the user signs, and tracks status.

| Doc | When to read |
|-----|--------------|
| [architecture.md](architecture.md) | Understanding the system before integrating. Components, data flow, who-signs-what. |
| [api-reference.md](api-reference.md) | Reference for every HTTP endpoint, request/response shapes, error codes. |
| [integration-guide.md](integration-guide.md) | Step-by-step code (ethers v6) showing the full flow from a client app: estimate → create → user signs → submit → poll. |
| [error-codes.md](error-codes.md) | Full numeric error registry, when each fires, suggested client handling. |

## Contract docs

Lower-level Solidity-side rationale lives in [../contract/docs/](../contract/docs/) — the EIP-712 hashing recipe, the must-succeed / atomic-group split, and the permissionless-submission model.
