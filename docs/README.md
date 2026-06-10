# Gasless — integration docs

This directory documents the gasless transaction relayer system so other projects can integrate with it. The system has two pieces:

- **`gasless/contract/`** — the `GaslessDelegate` Solidity contract used on EVM chains. Users delegate their EOA to this contract via EIP-7702; the contract verifies user-signed EIP-712 batches and runs them in two zones (must-succeed fee ops, then atomic group of user intent).
- **`gasless/backend/`** — the NestJS relayer service. Supports both EVM (EIP-7702 type-4 broadcast) and Solana (operator co-signs as fee payer on VersionedTransactions). Estimates fees in the user's chosen fee token (via Rango — which wraps Jupiter on Solana), builds the signable payload, broadcasts after the user signs, and tracks status.
- **`gasless/chains/`** — shared config: `chains.json` lists every supported chain (BSC, Base, Arbitrum, Solana mainnet/devnet) and the operator-accepted fee tokens per chain; `deployed.json` records the deployed `GaslessDelegate` address per EVM chain.

| Doc | When to read |
|-----|--------------|
| [architecture.md](architecture.md) | Understanding the system before integrating. Components, data flow, who-signs-what. Covers both the EVM (EIP-7702 delegate) path and the Solana (native fee-payer) path. |
| [api-reference.md](api-reference.md) | Reference for every EVM HTTP endpoint, request/response shapes, error codes. |
| [integration-guide.md](integration-guide.md) | Step-by-step code (ethers v6) showing the full EVM flow from a client app: estimate → create → user signs → submit → poll. |
| [solana.md](solana.md) | Solana-specific reference: how it differs from EVM (no delegation contract, native multi-sig fee-payer model), endpoint shapes, full integration sample using @solana/web3.js. |
| [error-codes.md](error-codes.md) | Full numeric error registry, when each fires, suggested client handling. |

## Contract docs

Lower-level Solidity-side rationale lives in [../contract/docs/](../contract/docs/) — the EIP-712 hashing recipe, the must-succeed / atomic-group split, and the permissionless-submission model.
