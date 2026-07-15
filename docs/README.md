# Gasless — integration docs

This directory documents the gasless transaction relayer system so other projects can integrate with it. The system has two pieces:

- **`gasless/contract/`** — the `GaslessDelegate` Solidity contract used on EVM chains. Users delegate their EOA to this contract via EIP-7702; the contract verifies user-signed EIP-712 batches and runs them in two zones (must-succeed fee ops, then atomic group of user intent).
- **`gasless/backend/`** — the NestJS relayer service. Supports both EVM (EIP-7702 type-4 broadcast) and Solana (operator co-signs as fee payer on VersionedTransactions). Estimates fees in the user's chosen fee token (via Rango — which wraps Jupiter on Solana), builds the signable payload, broadcasts after the user signs, and tracks status.
- **`gasless/chains/`** — shared config: `chains.json` lists the configured chains (BSC, Base, Arbitrum, Solana mainnet/devnet — any EIP-7702 EVM chain can be added) and the operator-accepted fee tokens per chain; `deployed.json` records the deployed `GaslessDelegate` address per EVM chain.

| Doc | When to read |
|-----|--------------|
| [architecture.md](architecture.md) | Understanding the system before integrating. Components, data flow, who-signs-what. Covers both the EVM (EIP-7702 delegate) path and the Solana (native fee-payer) path. |
| [api-reference.md](api-reference.md) | Reference for every HTTP endpoint, request/response shapes, error codes. |
| [integration-guide.md](integration-guide.md) | **Unified** step-by-step integration for EVM and Solana: architecture overview, endpoints, code samples for both families, signing format, status polling, error codes, rollout notes. Start here. |
| [error-codes.md](error-codes.md) | Full numeric error registry, when each fires, suggested client handling. |
| [state-machine-and-scheduler.md](state-machine-and-scheduler.md) | Internal design spec for the FSM + cron-scheduler abstraction used by both relayer jobs. Read if porting the relayer pattern to another language or refactoring the scheduler. |

## Contract docs

Lower-level Solidity-side rationale lives in [../contract/docs/](../contract/docs/) — the EIP-712 hashing recipe, the must-succeed / atomic-group split, and the permissionless-submission model.
