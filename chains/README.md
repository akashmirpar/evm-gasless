# gasless/chains

Single source of truth for the supported chains. Read by both the Foundry deploy script and the NestJS backend.

## `chains.json`

| Field | Meaning |
|-------|---------|
| `chainId` | EVM chain id. |
| `name` | Lowercase short name. Used in env var prefixes (e.g. `BSC_*`). |
| `displayName` | Human-readable. |
| `nativeSymbol`, `nativeDecimals` | Native gas token (BNB, ETH). |
| `rangoChainName` | Chain name expected by the Rango Exchange API. |
| `defaultRpcs` | Free public RPCs, tried in order. Override at runtime by setting `<envRpcVar>` (comma-separated list) — those run first, defaults are appended as fallbacks. |
| `tokens` | Canonical fee tokens (USDT, USDC) on this chain. Address + decimals. |
| `envRpcVar` | Name of the env var for runtime RPC overrides. |

## Deployed contract addresses

Written by the deploy script (`gasless/contract/script/Deploy.s.sol`) to `gasless/chains/deployed.json` after each chain deploy. The backend reads this file to learn the delegation contract address for each chain.

`deployed.json` is generated (not hand-edited). Commit it; treat it as the canonical record.
