# Gasless Relayer — Integration Guide

This document covers everything an integrator needs to wire the gasless backend into a wallet or dApp. It targets any EIP-7702 EVM chain — BSC, Base and Arbitrum are live today; more can be added by config.

The goal: a user with **only** the asset they want to transact in — no native gas token — can sign one approval and have an operator pay all network fees. The operator collects a small spread in the user's preferred token as a fee.

This guide assumes Node.js / TypeScript on the integrator side. The same flow applies to any language that can sign EIP-712 + EIP-7702.

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Supported chains](#supported-chains)
3. [Endpoint reference](#endpoint-reference)
4. [Fee model](#fee-model)
   1. [Fee modes — `bps` vs `fixed`](#fee-modes--bps-vs-fixed)
   2. [Per-token profit (`fixed` mode)](#per-token-profit-fixed-mode)
   3. [No-loss ceiling](#no-loss-ceiling)
   4. [Fiat fields on the estimate response](#fiat-fields-on-the-estimate-response)
5. [EVM integration](#evm-integration)
   1. [The flow end-to-end](#evm-flow-end-to-end)
   2. [Code sample](#evm-code-sample)
   3. [Fee-token behavior](#evm-fee-token-behavior--accept-any-erc-20-or-native)
   4. [EIP-712 + EIP-7702 details](#evm-eip-712-and-eip-7702-details)
6. [Status polling](#status-polling)
7. [Error codes](#error-codes)
8. [Operator configuration](#operator-configuration-for-backend-operators-only)

---

## Architecture overview

The gasless backend exposes four HTTP endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /gasless/transactions/estimate` | "How much will this cost?" — returns the fee in the user's chosen token, quoted via Rango when a swap is needed. |
| `POST /gasless/transactions` | "Build me the transaction to sign." Returns the EIP-712 digest to sign plus a `requestId`. |
| `POST /gasless/transactions/:requestId/submit` | "Here's the user's signature and EIP-7702 authorization." Verifies, persists, returns the request status. |
| `GET /gasless/transactions/:requestId` | "What happened?" — current status + tx hash + failure reason. |

Every route requires an `x-api-key` header (integrator API key); missing/invalid keys return `60001`/`60002`/`60003`.

Backend internals (you don't need to know these to integrate, but useful for debugging):

- **Operator wallet** signs the EIP-7702 type-4 transaction as the network fee payer.
- **Treasury** receives the user's fee payment. Defaults to the operator address.
- **Relayer** is a cron-driven worker that broadcasts queued transactions, polls receipts, and transitions a per-request state machine: `PENDING → BROADCASTING → BROADCASTED → MINED_SUCCESS | MINED_FAILED | FAILED_PERMANENT`.

---

## Supported chains

| `chainId` | Network | Native | Default-accepted fee token |
| --- | --- | --- | --- |
| `56` | BSC | BNB | USDT |
| `8453` | Base | ETH | USDT |
| `42161` | Arbitrum One | ETH | USDT |

> **Note:** the `GaslessDelegate` contract is only deployed where `chains/deployed.json` has an entry. A create on a listed-but-undeployed chain returns `20003 CHAIN_NO_DEPLOYED_CONTRACT`.

Add or change a chain by editing the `chains:` section of `backend/config.yaml` (chain id, name, `rpcUrls`, accepted fee tokens). The deployed `GaslessDelegate` address per chain lives in `chains/deployed.json` (written by `contract/script/deploy.sh`); since the contract deploys via CREATE2 with a frozen salt, it lands at the same address on every chain. The backend reads both at boot.

---

## Endpoint reference

Full request/response shapes for every endpoint, the response envelope, and per-field notes live in [api-reference.md](api-reference.md). The short version:

- **`estimate`** takes `{ chainId, userAddress, feeTokenAddress, operations[] }` and returns `feeAmount` in the fee token's base units, whether the token is accepted directly (`acceptedFeeToken`) or will be swapped (`swapRoute`), plus fiat fields.
- **`create`** takes the same body and returns `requestId`, `delegateContractAddress`, the EIP-712 `typedData` to sign, `batchNonce`, and `expiresAtSeconds`.
- **`submit`** takes `{ signature, authorization: { chainId, address, nonce, signature } }` — the user's EIP-712 signature over the batch and their signed EIP-7702 authorization for the delegate.
- **`status`** returns `{ requestId, status, chainId, txHash, retryTimes, failureReason, createdAt, updatedAt }`.

`operations` is the user's intent: `[{ chainId, to, value, data }]`, `value` in wei as an integer string, `data` as `0x`-prefixed hex.

---

## Fee model

The `/estimate` response tells you exactly what the user will pay. How that number is computed is an operator choice via `GASLESS_FEE_MODE` (default `bps`).

### Fee modes — `bps` vs `fixed`

| Mode | How the fee is sized | Price feed |
| --- | --- | --- |
| `bps` (default) | `fee = rawNetworkCost × (1 + GASLESS_BASE_FEE_MARKUP_PERCENT/100)` (default markup 15%). Byte-identical to the prior flat-markup behaviour. | Not used — operates even when prices are unavailable. |
| `fixed` | `fee = (rawNetworkCost priced into the fee token) + a per-token profit`. Applies to directly-accepted and native fee tokens. | Required — fails closed if no fresh price (see below). |

The **swap path** (an arbitrary non-accepted fee token that must be converted) always stays on the markup sizing described in the fee-token section below, regardless of mode.

**Price feed:** a scheduled job pulls the full Rango `/basic/meta` token list every `GASLESS_PRICE_REFRESH_CRON` (default `*/5 * * * *`) and once on boot, storing every priced token in a single Redis blob. A blob older than `GASLESS_PRICE_MAX_AGE_SECONDS` (default 900s) is unusable and the backend **fails closed** with `40014 GASLESS_PRICE_UNAVAILABLE` rather than risk under-charging. Conversion always rounds up so the operator never under-charges. When the feed is unavailable, an operator can switch `GASLESS_FEE_MODE=bps` as a stopgap (bps mode needs no feed).

### Per-token profit (`fixed` mode)

In `fixed` mode the operator's profit per fee token is configured via:

```
GASLESS_FEE_PROFIT=<chainId>:<TOKEN_or_addr>:<amount>,...
```

- `amount` is in **human units** (not base units).
- The token is matched by address or symbol, **case-insensitive**.
- The profit is added on top of the priced network cost for accepted and native fee tokens.

### Operator economics (internal — not in public docs)

This detail is deliberately kept out of the public docs (it's business-internal). The user-facing docs only say the fee covers 'network cost + a small service fee, fixed at quote time'.

- **Margin**: `GASLESS_BASE_FEE_MARKUP_PERCENT` (default 15%) in `bps` mode; per-token profit in `fixed` mode.
- **Ballpark cost**: tracks base + priority gas on the target chain; a fee-token swap adds the DEX call to the same transaction.
- **Overshoot/surplus**: if actual on-chain cost exceeds the quote, the operator absorbs it (user never charged more); if it's under, the operator keeps the surplus. The estimate is intentionally conservative.
- **No-loss ceiling** (below) is what guarantees the operator can't settle at a loss when priority fees spike.

### No-loss ceiling

An optional guard (`GASLESS_NO_LOSS_CHECK`, default off) protects the operator against a priority-fee auction spike leaving them out of pocket. When on, the backend **refuses the quote** (`40015 GASLESS_FEE_BELOW_MAX_NETWORK_COST`, HTTP 422) whenever the settlement amount is worth less than `simulatedCost × (1 + GASLESS_PRIORITY_HEADROOM_BPS)` (default `3000` = 30%), priced into the token the treasury settles in.

**Operator foot-gun:** in `bps` mode with the no-loss check on, keep `GASLESS_BASE_FEE_MARKUP_PERCENT` ≥ the headroom percentage, or the guard rejects most quotes. The backend fires a boot warning when markup < headroom.

### Fiat fields on the estimate response

Estimate responses include best-effort `feeUsd` and `estimatedNativeCostUsd` (decimal strings) so a UI can show the user a fiat value:

```json
{
  "feeTokenAddress": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "feeAmount": "11129",
  "acceptedFeeToken": true,
  "swapRoute": null,
  "feeUsd": "0.0489",
  "estimatedNativeCostUsd": "0.0425"
}
```

Both fields are **best-effort**: they are omitted (never an error) when a price for the relevant token is missing from the feed.

---

## EVM integration

### EVM flow end-to-end

Given a user with **zero native gas** (no BNB, no ETH) who wants to swap and bridge through one or more operations:

1. Your wallet receives the user's intent as a list of `{ to, value, data }` operations.
2. Call `POST /gasless/transactions/estimate` to size the fee.
3. Call `POST /gasless/transactions` to build the signable EIP-712 batch.
4. Have the user sign the typed-data digest (`signTypedData`).
5. Have the user sign an EIP-7702 authorization for the `GaslessDelegate` contract (`authorize`).
6. Submit both signatures to `POST /gasless/transactions/:requestId/submit`.
7. Poll `GET /gasless/transactions/:requestId` until terminal.

### EVM code sample

```ts
import { Wallet, JsonRpcProvider, TypedDataEncoder, Signature, getBytes } from 'ethers';

const BASE_URL = 'https://gasless.your-host.tld';

interface EvmCreated {
  requestId: string;
  chainId: number;
  delegateContractAddress: string;
  nonce: string;
  atomicGroupStart: number;
  operations: { to: string; value: string; data: string }[];
  digest: string;
  expiresAtSeconds: number;
}

async function relayEvm(opts: {
  chainId: number;
  rpcUrl: string;
  userWallet: Wallet;
  feeTokenAddress: string;
  operations: { to: string; value: string; data: string }[];
}): Promise<string> {
  const userAddress = await opts.userWallet.getAddress();

  const estimate = await postJson<any>(`${BASE_URL}/gasless/transactions/estimate`, {
    chainId: opts.chainId,
    userAddress,
    feeTokenAddress: opts.feeTokenAddress,
    operations: opts.operations.map((o) => ({ chainId: opts.chainId, ...o })),
  });

  const created = await postJson<EvmCreated>(`${BASE_URL}/gasless/transactions`, {
    chainId: opts.chainId,
    userAddress,
    feeTokenAddress: opts.feeTokenAddress,
    operations: opts.operations.map((o) => ({ chainId: opts.chainId, ...o })),
  });

  const provider = new JsonRpcProvider(opts.rpcUrl);

  const sig712 = await signBatch(opts.userWallet, created);
  const eoaNonce = await provider.getTransactionCount(userAddress);
  const auth = await signAuth(opts.userWallet, created.delegateContractAddress, BigInt(eoaNonce), created.chainId);

  const submitted = await postJson<any>(
    `${BASE_URL}/gasless/transactions/${created.requestId}/submit`,
    {
      signature: sig712,
      authorization: {
        chainId: created.chainId,
        address: created.delegateContractAddress,
        nonce: auth.nonce,
        signature: auth.signature,
      },
    },
  );

  return created.requestId;
}

async function signBatch(wallet: Wallet, prep: EvmCreated): Promise<string> {
  const domain = {
    name: 'GaslessDelegate',
    version: '1',
    chainId: prep.chainId,
    verifyingContract: prep.delegateContractAddress,
  };
  const types = {
    Batch: [
      { name: 'nonce', type: 'uint256' },
      { name: 'operations', type: 'Operation[]' },
    ],
    Operation: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  };
  const value = {
    nonce: BigInt(prep.nonce),
    operations: prep.operations.map((o) => ({
      to: o.to,
      value: BigInt(o.value),
      data: o.data,
    })),
  };
  const computed = TypedDataEncoder.hash(domain, types, value);
  if (computed.toLowerCase() === prep.digest.toLowerCase()) {
    return wallet.signTypedData(domain, types, value);
  }
  const sig = wallet.signingKey.sign(getBytes(prep.digest));
  return Signature.from(sig).serialized;
}

async function signAuth(wallet: Wallet, delegate: string, nonce: bigint, chainId: number) {
  const auth = await (wallet as any).authorize({ address: delegate, nonce, chainId });
  return {
    signature: Signature.from(auth.signature).serialized,
    nonce: nonce.toString(),
  };
}
```

### EVM fee-token behavior — accept any ERC-20 or native

The EVM fee-token whitelist has been dropped. The backend accepts **any** `feeTokenAddress` the caller passes — no chain-side pre-approval or config update required to add a new token. Three paths, chosen automatically per request:

**1. Direct-accept (fee token is on the chain's `acceptedFeeTokens` list)**

`config.yaml` per-chain fields (under `chains:`):
- `acceptedFeeTokens: [addr...]` — treated as "already valuable to the operator" and collected via a plain `ERC20.transfer(user → treasury)` op prepended to the batch. No Rango swap.
- `mainFeeToken: addr` — the single token everything unaccepted gets swapped INTO. **Must** be one of `acceptedFeeTokens` (self-consistency: the swap target is itself acceptable).

Current per-chain config: only USDT is direct-accepted on BSC (`0x55d3…7955`), Base (`0xfde4…9bb2`), and Arbitrum (`0xfd08…cbb9`). Change requires a config edit + backend restart; no code change.

**2. Native fee (`feeTokenAddress = 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`)**

Industry-standard native-token sentinel (1inch, Rango, Paraswap all recognize it). Recognized case-insensitively. Backend prepends a Rango-routed **native → mainFeeToken** swap to the batch that pulls the fee out of the user's EOA via `msg.value` and settles the mainFeeToken output to the treasury.

Balance check: `getBalance(user)` ≥ `feeAmount + sum(op.value)`. Ops that transfer native value in the same batch add to the required balance.

**3. Any arbitrary ERC-20 (not in `acceptedFeeTokens`)**

Same swap-fee-path as native, but with an ERC-20 input:
- Decimals fetched on-chain via `ERC20.decimals()`, cached in Redis for 24h. A revert / non-uint8 response returns `40010 FEE_TOKEN_UNREADABLE`.
- Batch prelude: `approve(router, feeAmount)` + swap call. Rango picks the DEX/router.
- Rango-NO_ROUTE returns `30002` (the 20004 error is retired for this flow).
- `amountOutMin` on the swap ensures adverse price moves revert the whole batch atomically — the operator absorbs the failed-tx gas cost, the user pays nothing. Bounded per-attempt loss.

**Estimator math (inverse-quote-with-slippage-padding)**

For swap-fee paths we need to know how much of the user's token to charge to receive a target amount of `mainFeeToken`. Rango's `/basic/quote` is exact-in only, so:

1. Compute the native gas cost with 15% markup → convert to `mainFeeToken` via forward quote (native → mainFeeToken).
2. Inverse quote: `mainFeeToken → user's fee token`, amount = the target. Rango returns "how much user token that target is worth at mid-price".
3. Scale up by `2 × slippage` (default 1% × 2 = 2%). Rounds up to the next base unit.
4. Charge the user the scaled amount; the actual on-chain swap uses `amountOutMin` = the target so adverse moves revert atomically.

Heuristic assumes `quote(A→B)` and `quote(B→A)` are near-reciprocal. Holds for deep pairs (USDT ↔ ETH, USDT ↔ major ERC-20s), diverges for illiquid ones — but the 15% base markup + 2× slippage swallows most drift.

**What breaks (documented, not fixed)**

- **Fee-on-transfer tokens** (e.g., SafeMoon-style): input arrives at router less than nominal → `amountOutMin` fails → batch reverts atomically. Operator eats failed-tx gas. Graceful.
- **USDT-style transferFrom blacklists**: if the operator or treasury is blacklisted on a token, swap reverts. Bounded per-token failure; other tokens unaffected.
- **Rebasing / silent-true `transferFrom` tokens**: same class as blacklists — router swap fails, batch reverts. No fund loss.

**Removed fields from the `chains:` registry for EVM chains** (upgraders take note):

The old per-chain `tokens: {SYMBOL: {address, decimals}}` map is gone. Decimals now come from RPC on-first-sight and are cached.

### EVM EIP-712 and EIP-7702 details

**EIP-712 batch signature** — the user signs typed-data with the domain `GaslessDelegate v1` and a `Batch` type containing a nonce + a list of operations. The signature authorizes the operator to execute these operations on the user's behalf. The backend verifies against the user's EOA address.

**EIP-7702 authorization** — the user signs a separate authorization for their EOA to temporarily "become" the `GaslessDelegate` contract for the duration of the transaction. This is the key primitive enabling gasless: the operator wraps the EIP-712 signature in a type-4 transaction envelope where:

- `from` = operator (pays gas)
- The transaction includes an authorization list with the user's EIP-7702 signature
- The user's EOA delegates to `GaslessDelegate`, which calls back into itself with the EIP-712 batch

Both signatures are required. The `nonce` for the authorization is the user's current EOA tx count from the chain — fetch it via `eth_getTransactionCount` immediately before signing to avoid races.

The `GaslessDelegate` contract addresses per chain are recorded in the backend's `deployed.json` (chain metadata lives in `backend/config.yaml`); read them from there.

---

## Status polling

The request state machine:

```
PENDING → BROADCASTING → BROADCASTED → MINED_SUCCESS | MINED_FAILED
   ↘                       ↘                          ↘ FAILED_PERMANENT
```

Terminal statuses: `MINED_SUCCESS`, `MINED_FAILED`, `FAILED_PERMANENT`.

**Polling cadence:** every 2-5 seconds is fine. Cross-chain bridges typically resolve in 15-60 seconds. Intra-chain swaps in 5-15 seconds.

**Polling timeout:** 10-15 minutes is a reasonable upper bound. Beyond that the request is stuck for a reason worth investigating manually (chain congestion, RPC outage, etc.). The backend will eventually transition stuck requests to `FAILED_PERMANENT` after exhausting its own retry budget.

**Sample poller:**

```ts
async function pollUntilTerminal(requestId: string): Promise<{ status: string; txHash: string | null; failureReason: string | null }> {
  const TERMINAL = new Set(['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT']);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/gasless/transactions/${requestId}`);
    const data = await res.json();
    if (TERMINAL.has(data.status)) return data;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`timeout polling ${requestId}`);
}
```

---

## Error codes

The backend uses stable numeric error codes.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `20001` | 400 | Chain not supported |
| `20002` | 502/503 | RPC unreachable or contract call reverted at RPC (also returned when a delegated EOA's `GaslessDelegate.nonce()` read fails — retry with backoff) |
| `20003` | 503 | No deployed delegate contract for the chain |
| `20004` | 400 | Fee token not found in chain config — retired for per-request use (the token whitelist was dropped; any address is accepted, with unaccepted tokens routed through the swap-fee path). |
| `20005` | 502 | Chain gas estimation failed |
| `30001` | 502 | Rango request failed |
| `30002` | 422 | Rango has no route for the requested swap |
| `30003` | 502 | Rango returned an invalid response |
| `40001` | 400 | Invalid request body |
| `40002` | 422 | Fee token not accepted and no swap route available |
| `40003` | 404 | Request ID not found |
| `40004` | 410 | Request expired (the create→submit TTL passed before signature arrived; default TTL is 90 seconds) |
| `40005` | 400 | Invalid signature |
| `40006` | 400 | Invalid EIP-7702 authorization (mismatched address/chainId/signature OR `authorization.nonce` does not match the user's current EOA `eth_getTransactionCount` at submit time — fetch via `provider.getTransactionCount(userAddress, 'latest')` immediately before signing to avoid races) |
| `40007` | 409 | Request was already submitted |
| `40009` | 422 | User's fee-token balance is below the quoted fee at submit time (user moved tokens out between estimate and submit). For native-fee-token flows, the balance check requires `feeAmount + sum(op.value)`, so watch out for ops that transfer native value out of the same batch |
| `40010` | 400 | Fee-token address does not respond to a standard `ERC20.decimals()` call — either not a contract or not ERC-20-compliant. Pass either the native sentinel (`0xeeee…eeee`) or a valid ERC-20 address |
| `50001` | 502 | Broadcast failure |
| `50002` | 504 | Transaction not mined within the relayer's wait window |
| `50003` | 502 | Transaction mined but reverted on-chain |
| `50004` | 500 | Relayer exhausted retries and gave up |
| `80001` | 503 | Health check failed (internal use; should not appear in client responses) |
| `90001` | 400 | System validation error (DTO/class-validator failure with field-level details) |
| `90002` | 404 | System resource not found (generic; prefer the 4xx-domain codes above when applicable) |
| `90003` | 409 | Illegal FSM transition — the row's status does not permit the requested action (typically operator-side bug; integrators should not retry, surface the original request to support) |
| `90004` | 409 | Concurrent FSM transition — two workers raced on the same row; the loser sees this. Retry is safe |
| `90099` | 500 | Generic system error (something we didn't classify) |


### Error response shape — `causes[]` chain

Every error response carries the typed code + message. When the underlying exception had a `causes[]` chain (RPC attempts, mint addresses, Rango payloads, validator-side logs), those are now serialized into the response body as an array. RPC URLs in the cause objects are sanitized — API keys after the last path segment, `?apiKey=`/`?key=`/`?auth=`/`?token=` query params, and Bearer tokens are replaced with `<redacted>` before persistence and before serving.

```json
{
  "success": false,
  "error": {
    "code": 20002,
    "message": "All RPCs failed for chain 56 (tried 2 URL(s))",
    "causes": [
      { "url": "https://bsc-rpc.publicnode.com", "error": "fetch failed" },
      { "url": "https://1rpc.io", "error": "timeout 30000ms exceeded" }
    ]
  }
}
```


---

## Operator configuration (for backend operators only)

This section is for whoever runs the gasless backend, not integrators. Integrators can skip it.

### Required env vars

| Var | What it sets |
| --- | --- |
| `DATABASE_POSTGRES_*` | Postgres connection (host/port/user/password/database). Required at boot. |
| `REDIS_*` | Redis for create→submit cache. `REDIS_DEFAULT_TTL_SECONDS=300` is overall cache cap; per-stash TTL governed by `GASLESS_CREATE_TTL_SECONDS=90`. |
| `OPERATOR_MNEMONIC` (+ optional `OPERATOR_MNEMONIC_INDEX`, default `0`) | **Primary** operator seed — a BIP-39 mnemonic; the operator is derived at `m/44'/60'/0'/0/{index}`. |
| `OPERATOR_PRIVATE_KEY` | Fallback raw operator key, used only when `OPERATOR_MNEMONIC` is unset. |
| `GASLESS_TREASURY_ADDRESS` | EVM address that receives user fees. Unset → every accepted-fee request throws (the address is used directly in the transfer, no fallback). Required in production. |
| `ANKR_API_KEY` | RPC provider key, interpolated into each chain's keyed endpoint in `config.yaml` (`${ANKR_API_KEY}`). Unset → the keyed endpoint is dropped and the keyless public fallbacks are used. RPC endpoints themselves live in `config.yaml` (`chains[].rpcUrls`). To override them at deploy time without a rebuild, set `CHAINS_<NAME>_RPC_URLS` or `CHAINS_<chainId>_RPC_URLS` (comma-separated), e.g. `CHAINS_BSC_RPC_URLS` / `CHAINS_56_RPC_URLS`. The pre-RIN-135 `<CHAIN>_RPC_URLS` form is no longer read (the loader warns if one is still set). |
| `RANGO_API_URL`, `RANGO_API_KEY` | Rango Basic API credentials. |

### Tuning knobs

| Var | Default | What it does |
| --- | --- | --- |
| `GASLESS_BASE_FEE_MARKUP_PERCENT` | `15` | Operator margin on top of raw gas cost. |
| `GASLESS_DEFAULT_GAS_UNITS` | `1500000` | Fallback gas units when EVM estimation fails. |
| `GASLESS_TX_GAS_LIMIT` | `2000000` | Hard cap on the type-4 envelope. |
| `GASLESS_RANGO_SLIPPAGE` | `0.5` | One-side slippage (%) sent to Rango for fee-token swaps. The backend applies 2× this as a buffer on the inverse-quote pattern. |
| `GASLESS_CREATE_TTL_SECONDS` | `90` | Window between `/transactions` and `/submit`. Tighter = less race exposure; looser = more forgiving of slow mobile-wallet flows. |
| `GASLESS_EXPOSE_ERROR_CAUSES` | `false` | When `true`, echoes the `causes[]` diagnostics (RPC attempts, aggregator responses) in HTTP error responses. Off by default — a fingerprinting surface; the full detail always goes to the server logs regardless. Turn on only for dev/debug. Field-level validation causes (`90001`) are always returned. |
| `RELAYER_CRON` | `*/5 * * * * *` | Cron cadence for the relayer tick (every 5s). |
| `RELAYER_MAX_RETRIES` | `6` | Max retry-budget per row (per-row column snapshots on insert). |
