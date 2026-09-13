# Gasless — integration docs

This directory documents the gasless transaction relayer so other projects can integrate with it. The system has three pieces:

- **`contract/`** — the `GaslessDelegate` Solidity contract. Users delegate their EOA to it via EIP-7702; it verifies user-signed EIP-712 batches and runs them in two zones (must-succeed fee ops, then the atomic group of user intent). Deployed via CREATE2 with a frozen salt, so it sits at the same address on every chain.
- **`backend/`** — the NestJS relayer service. Estimates fees in the user's chosen fee token (via Rango when a swap is needed), builds the signable payload, broadcasts the EIP-7702 type-4 transaction after the user signs, and tracks status.
- **`chains/`** — `deployed.json` records the deployed `GaslessDelegate` address per chain. The chain registry itself (RPC endpoints, accepted fee tokens) is the `chains:` section of `backend/config.yaml`.

| Doc | When to read |
|-----|--------------|
| [architecture.md](architecture.md) | Understanding the system before integrating. Components, data flow, who-signs-what. |
| [api-reference.md](api-reference.md) | Reference for every HTTP endpoint, request/response shapes, error codes. |
| [integration-guide.md](integration-guide.md) | Step-by-step integration: endpoints, code sample, signing format, status polling, error codes. Start here. |
| [error-codes.md](error-codes.md) | Full numeric error registry, when each fires, suggested client handling. |
| [state-machine-and-scheduler.md](state-machine-and-scheduler.md) | Internal design spec for the FSM + cron-scheduler abstraction the relayer runs on. |
| [secrets-and-config-convention.md](secrets-and-config-convention.md) | How config.yaml, the secret file, and deploy-time overrides fit together. |

## Contract docs

Lower-level Solidity-side rationale lives in [../contract/docs/](../contract/docs/) — the EIP-712 hashing recipe, the must-succeed / atomic-group split, and the permissionless-submission model.
