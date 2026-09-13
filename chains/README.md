# gasless/chains

## Chain registry

The supported-chain registry lives in `backend/config.yaml` under the `chains:`
section (single source of truth, read by both the NestJS backend and the Foundry
deploy/verify scripts via a small js-yaml bridge).

| Field | Meaning |
|-------|---------|
| `chainId` | EVM chain id. |
| `name` | Lowercase short name. |
| `displayName` | Human-readable. |
| `nativeSymbol`, `nativeDecimals` | Native gas token (BNB, ETH, SOL). |
| `rangoChainName` | Chain name expected by the Rango Exchange API. |
| `rpcUrls` | RPC endpoints tried in order. The first entry is the keyed provider endpoint (`${ANKR_API_KEY}` interpolated from the secret file); the rest are keyless public fallbacks. |
| `acceptedFeeTokens`, `mainFeeToken` | EVM fee-path config. |

## Deployed contract addresses

`deployed.json` is written by the deploy script (`gasless/contract/script/deploy.sh`)
to `gasless/chains/deployed.json` after each chain deploy, keyed by chainId. The
backend reads it to learn the delegate contract address per chain.

`deployed.json` is generated (not hand-edited). Commit it; treat it as the
canonical record.
