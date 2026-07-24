# Gasless Relayer — Integration Guide

This document covers everything an integrator needs to wire the gasless backend into a wallet or dApp. Two transaction families are supported through the same shape of endpoints: **EVM** — any EIP-7702 chain (BSC, Base, Arbitrum live today, more on request) — and **Solana** (mainnet, devnet).

The goal: a user with **only** the asset they want to transact in — no native gas token — can sign one approval and have an operator pay all network fees. The operator collects a small spread in the user's preferred token as a fee.

This guide assumes Node.js / TypeScript on the integrator side. The same flow applies to any language that can sign EIP-712 + EIP-7702 for EVM and ed25519 for Solana.

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Endpoint reference](#endpoint-reference)
3. [Fee model](#fee-model)
   1. [Fee modes — `bps` vs `fixed`](#fee-modes--bps-vs-fixed)
   2. [Per-token profit (`fixed` mode)](#per-token-profit-fixed-mode)
   3. [No-loss ceiling](#no-loss-ceiling)
   4. [Fiat fields on the estimate response](#fiat-fields-on-the-estimate-response)
4. [Solana integration](#solana-integration)
   1. [The flow end-to-end](#solana-flow-end-to-end)
   2. [Bridge intents — what we handle for you](#bridge-intents--what-we-handle-for-you)
   3. [Overriding the SOL prefund](#overriding-the-sol-prefund)
   4. [Code sample](#solana-code-sample)
   5. [Signing format](#solana-signing-format)
   6. [Address Lookup Tables](#solana-address-lookup-tables)
   7. [Size fallback — single tx vs Jito bundle](#size-fallback--single-tx-vs-jito-bundle)
5. [EVM integration](#evm-integration)
   1. [The flow end-to-end](#evm-flow-end-to-end)
   2. [Code sample](#evm-code-sample)
   3. [EIP-712 + EIP-7702 details](#evm-eip-712-and-eip-7702-details)
6. [Status polling](#status-polling)
7. [Error codes](#error-codes)
8. [Rollout notes for existing integrations](#rollout-notes-for-existing-integrations)

---

## Architecture overview

The gasless backend exposes four HTTP endpoints per family. The shape is parallel:

| Endpoint | Purpose |
| --- | --- |
| `POST /gasless/<family>/transactions/estimate` | "How much will this cost?" — returns the fee in the user's chosen token, quoted via Rango/Jupiter when necessary. |
| `POST /gasless/<family>/transactions` | "Build me the transaction to sign." Returns unsigned bytes plus a `requestId`. |
| `POST /gasless/<family>/transactions/:requestId/submit` | "Here's the user's signature." Verifies, persists, returns the request status. |
| `GET /gasless/<family>/transactions/:requestId` | "What happened?" — current status + tx hash + failure reason. |

**EVM** omits the family segment — its paths are `POST /gasless/transactions/estimate`, `POST /gasless/transactions`, `POST /gasless/transactions/:requestId/submit`, `GET /gasless/transactions/:requestId`. **Solana** uses the `solana` segment: `POST /gasless/solana/transactions/estimate`, etc. Every route requires an `x-api-key` header (integrator API key); missing/invalid keys return `60001`/`60002`/`60003`.

## Supported chains

| chainId | Family | Network | Native | Default-accepted fee tokens |
| --- | --- | --- | --- | --- |
| 56 | evm | BSC | BNB | USDT |
| 8453 | evm | Base | ETH | USDT |
| 42161 | evm | Arbitrum One | ETH | USDT |
| -100 | solana | Solana mainnet | SOL | USDC, xTSLA, xNVDA, xAAPL |
| -102 | solana | Solana devnet | SOL | USDC (test only) |

> **Note:** the `GaslessDelegate` contract is only deployed where `deployed.json` has an entry (currently BSC `56` and Arbitrum `42161`). A create on a listed-but-undeployed chain (e.g. Base) returns `20003 CHAIN_NO_DEPLOYED_CONTRACT`.

Solana cluster IDs are negative integers because Solana doesn't natively have a numeric chain ID — the negative space is a Pluton-side convention so the same `chainId` parameter can route both families.

Add or change a chain by editing the `chains:` section of `backend/config.yaml` (chain id, name, `rpcUrls`, accepted fee tokens, Solana `tokens`). The deployed `GaslessDelegate` address per EVM chain lives in the generated `gasless/chains/deployed.json` (written by `contract/script/deploy.sh`). The backend reads both at boot.

Backend internals (you don't need to know these to integrate, but useful for debugging):

- **Operator wallet** signs transactions as the network fee payer. We hold one operator per family per cluster.
- **Treasury** receives the user's fee payment. Configurable per cluster (defaults to the operator pubkey).
- **Relayer** is a cron-driven worker that broadcasts queued transactions, polls receipts, and transitions a per-request state machine: `PENDING → BROADCASTING → BROADCASTED → MINED_SUCCESS | MINED_FAILED | FAILED_PERMANENT`.

---

## Endpoint reference

### `POST /gasless/<family>/transactions/estimate`

Request:

```json
{
  "chainId": -100,
  "userAddress": "G2KhTWRh61PRj8W6mFeCLKTdcNj3NFVrmaQLbwJY557p",
  "feeTokenAddress": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "instructions": [/* see family-specific section */]
}
```

For EVM, the body uses `operations: [{ chainId, to, value, data }]` instead of `instructions`.

Response:

```json
{
  "feeTokenAddress": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "feeAmount": "11129",
  "acceptedFeeToken": true,
  "swapRoute": null,
  "estimatedSolCost": "12500"
}
```

- `feeAmount` is in the fee token's base units (8 decimals for xTSLA → `11129` = 0.00011129 xTSLA).
- `acceptedFeeToken: true` means we'll accept the token directly — no Rango swap is involved.
- `swapRoute` is populated when the fee token is unsupported and a Rango swap will be appended; the route ID lets you audit which Jupiter route was quoted.

### `POST /gasless/<family>/transactions`

Same body as `estimate` plus optional fields on Solana:

- `mode?: 'single' | 'bundled'` — broadcast mode (both `estimate` and this endpoint accept it). `single` = classic single tx; `bundled` = Jito atomic bundle for intents that overshoot 1232B. Omit to let the backend choose (defaults to `single`, auto-promoted to `bundled` on wire-size overshoot). **The legacy aliases `g1`/`g2` were removed — a request with `mode: 'g1'` or `'g2'` now returns `400`.**
- `addressLookupTables?: string[]` — ALT pubkeys from your routing provider's V0 response
- `userSolPrefundLamports?: string` — absolute override for the SOL prefund (see [Overriding the SOL prefund](#overriding-the-sol-prefund))
- `userSolPrefundExtraLamports?: string` — additive top-up on the auto-sized prefund

Returns the unsigned transaction and bookkeeping:

```json
{
  "requestId": "1decaa2b-191d-48bd-a809-07efa0b0764d",
  "chainId": -100,
  "feePayer": "B8qN5BCQS4Q7rqPoH2tTCWzbvS48B3sdUagwSbZS1NNe",
  "unsignedTransactionBase64": "AgAAA...",
  "recentBlockhash": "DvR4...",
  "lastValidBlockHeight": 318450123,
  "feeAmount": "11129",
  "feeTokenAddress": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "expiresAtSeconds": 1781280000
}
```

EVM response shape differs — see `EVM integration` below.

### `POST /gasless/<family>/transactions/:requestId/submit`

Solana:

```json
{ "userSignature": "<base58 ed25519 signature, 64 bytes>" }
```

EVM:

```json
{
  "signature": "0x...",
  "authorization": {
    "chainId": 56,
    "address": "0x7AF705BEA2Aa1F1cB4ffB18cbB94B26Bba343a87",
    "nonce": "42",
    "signature": "0x..."
  }
}
```

Returns `{ requestId, status }` where `status` is the FSM state. **On Solana, submit performs a balance recheck** against the user's actual on-chain fee-token balance — if the user has moved tokens out between estimate and submit, this returns `40009 GASLESS_INSUFFICIENT_FEE_BALANCE` and no broadcast happens (no operator funds spent).

### `GET /gasless/<family>/transactions/:requestId`

```json
{
  "requestId": "1decaa2b-191d-48bd-a809-07efa0b0764d",
  "status": "MINED_SUCCESS",
  "chainId": -100,
  "txHash": "5S6dFffZ8rdCuCVCxFUp1U8EcxQy4Xqy9eXmaF3EwQp1hCwmA3yRxnsGQthWaF4Qts1g6xQJBS3Asoho7XkUGG7j",
  "retryTimes": 0,
  "failureReason": null,
  "createdAt": "2026-06-13T07:32:00Z",
  "updatedAt": "2026-06-13T07:32:17Z"
}
```

`txHash` is the Solana signature for `-100` / `-102` chains and the EVM tx hash otherwise. `failureReason` is populated when the request reaches `MINED_FAILED` or `FAILED_PERMANENT`.

---

## Fee model

The `/estimate` response tells you exactly what the user will pay. How that number is computed is an operator choice via `GASLESS_FEE_MODE` (default `bps`). Both modes apply to EVM and Solana.

### Fee modes — `bps` vs `fixed`

| Mode | How the fee is sized | Price feed |
| --- | --- | --- |
| `bps` (default) | `fee = rawNetworkCost × (1 + GASLESS_BASE_FEE_MARKUP_PERCENT/100)` (default markup 15%). Byte-identical to the prior flat-markup behaviour. | Not used — operates even when prices are unavailable. |
| `fixed` | `fee = (rawNetworkCost priced into the fee token) + a per-token profit`. Applies to directly-accepted and native fee tokens. | Required — fails closed if no fresh price (see below). |

The **swap path** (an arbitrary non-accepted fee token that must be converted) always stays on the markup + min-floor sizing described in the family-specific sections, regardless of mode.

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
- **Ballpark cost** (mainnet, SOL=$150): a light Solana USDC transfer costs the operator ~30,000 lamports (~$0.0045); a Jupiter swap or Rango bridge is ~5-20× that. EVM cost tracks base+priority gas.
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

## Solana integration

### Solana flow end-to-end

Given a user with **zero SOL** who wants to bridge 0.0005 xTSLA → USDT@BSC:

1. Your wallet receives the user's intent.
2. Call your routing provider (Rango, Jupiter aggregator, etc.) to build the bridge transaction. The provider returns a serialized V0 message + a list of Address Lookup Table pubkeys.
3. Parse the serialized message into individual instructions; resolve ALT references so the account list is complete. **Forward the original ALT pubkey list verbatim** to the gasless backend.
4. Call `POST /gasless/solana/transactions/estimate` to size the fee.
5. Call `POST /gasless/solana/transactions` to build the signable transaction.
6. Have the user sign the message bytes (ed25519 over the serialized message).
7. Call `POST /gasless/solana/transactions/:requestId/submit` with the signature.
8. Poll `GET /gasless/solana/transactions/:requestId` until terminal.

### Bridge intents — what we handle for you

When the user's intent comes from a routing provider, the instruction list almost always contains one or more `CreateAssociatedTokenAccountIdempotent` instructions. Routing providers default the **payer slot** on those instructions to the user's pubkey — which is wrong for gasless because the user has zero SOL. Without intervention, simulation aborts:

```
Transfer: insufficient lamports 0, need 2039280
```

**The gasless backend handles this transparently.** When you POST to `/gasless/solana/transactions`, we size the SOL the user's intent needs and inject a `SystemProgram.transfer` from the operator to the user immediately before your instructions execute. By the time the bridge tries to charge the user for rent, the user's wallet has the funds.

How that amount is sized depends on the operator's `GASLESS_PREFUND_SIZING` (see the backend's [Solana architecture › Prefund sizing](./solana-architecture.md#prefund-sizing)):
- **`simulate` (default):** we *simulate* your intent with and without a prefund. If the user self-covers, no prefund is sent at all; otherwise the prefund is the measured SOL consumption, floored at the scan value — simulation only ever raises the prefund above the scan (covering non-ATA SOL costs like bridge native fees), never lowers it below.
- **`scan` (fallback):** we scan your `instructions` for ATA-program Create / CreateIdempotent where the payer slot equals your `userAddress`, at 2,039,280 lamports each. Used automatically when simulation is unavailable.

Either way it's transparent to you; the difference is only in accuracy.

**You do NOT need to:**

- Rewrite the payer slot on routing-provider instructions
- Dedupe instructions that became byte-identical after a rewrite
- Pre-fund users with SOL out-of-band
- Filter out ATA-create instructions before submitting

**You DO need to:**

- Forward the routing provider's instruction list verbatim, including user-as-payer slots.
- Forward the `addressLookupTables` array. Without it, the transaction will not fit under Solana's 1232-byte wire size limit for any non-trivial bridge.

The backend logs the prefund decision per request:

```
[SolanaBatchBuilderService] prefunding user G2KhTWRh… with 4078560 lamports (2 ATA-create(s))
```

### Overriding the SOL prefund

When the user's intent includes SOL costs that aren't ATA rent — e.g. a **LayerZero OFT messaging fee** (~0.01 SOL) on USDT0 routes, or any bridge that charges a protocol fee in SOL — the **`scan`-mode** auto-scan undershoots (it only sees ATA-creates), simulation reverts with `insufficient lamports`, and the operator eats the envelope fee with nothing collected. (Under `GASLESS_PREFUND_SIZING=simulate` this is measured automatically — the overrides below are only needed in `scan` mode, or to force an exact amount.)

Two optional fields on `POST /gasless/solana/transactions` let you adjust:

| Field | Behavior |
| --- | --- |
| `userSolPrefundLamports` | **Absolute override.** When set, the backend skips auto-sizing (scan or simulate) entirely and prefunds exactly this amount. Use when you know the precise SOL total the user will need (e.g. you got the nativeFee from a `quoteSend()` call on the LayerZero OFT contract and counted ATA rents yourself). |
| `userSolPrefundExtraLamports` | **Additive top-up.** Added on top of the backend's auto-sized amount. Use when the auto-scan covers most of what's needed (ATA rents) and you want a buffer for one known native fee (e.g. `+10_000_000` for a LayerZero route). |

The two are **mutually exclusive** — setting both returns `40001 GASLESS_INVALID_REQUEST`. Both values are stringified lamport amounts.

Example for a Rango route that goes through USDT0 (LayerZero OFT, ~$1.50 native fee):

```json
{
  "chainId": -100,
  "userAddress": "G2KhTWRh…",
  "feeTokenAddress": "EPjFW…",
  "instructions": [/* parsed Rango response */],
  "addressLookupTables": ["…"],
  "userSolPrefundExtraLamports": "10000000"
}
```

Backend log distinguishes the source:

```
prefunding user G2KhTWRh… with 14078560 lamports (2 ATA-create(s) + caller-supplied extra 10000000)
prefunding user G2KhTWRh… with 12000000 lamports (caller-supplied absolute 12000000)
prefunding user G2KhTWRh… with 4078560 lamports (2 ATA-create(s))
```

**Per-bridge guidance** (confirmed with Rango 2026-06):

| Bridge | Pattern | Recommended override |
| --- | --- | --- |
| **USDT0 (LayerZero OFT)** | `nativeFee` field deducted from user SOL via CPI, ~0.01 SOL per request, exact amount fresh from `quoteSend()` at create time. | `userSolPrefundExtraLamports: "10000000"` (or pull the exact value from `quoteSend` and use absolute) |
| All other Rango bridges (Wormhole, GasZip, AllBridge, Mayan, Circle/CCTP, Relay, TeleSwap, ChainFlip, SwftDecentralize, Titan, Jupiter swap-only) | No user-SOL spend beyond ATA rent | No override needed |

**Edge case NOT covered:** PDAs designated as ATA rent payers. Rango confirmed they don't do this; flag if observed.

### Solana code sample

```ts
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BASE_URL = 'https://gasless.your-host.tld';

interface Estimate {
  feeTokenAddress: string;
  feeAmount: string;
  acceptedFeeToken: boolean;
  swapRoute: null | { inputToken: string; outputToken: string; outputAmount: string };
  estimatedSolCost: string;
}

interface Created {
  requestId: string;
  chainId: number;
  feePayer: string;
  unsignedTransactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  feeAmount: string;
  feeTokenAddress: string;
  expiresAtSeconds: number;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} ${res.status}: ${text}`);
  }
  return res.json();
}

async function relayBridge(opts: {
  userAddress: string;                            // base58
  feeTokenMint: string;                           // base58
  instructions: SerializedSolanaInstruction[];    // parsed Rango response
  addressLookupTables: string[];                  // ALT pubkeys from Rango response
  userSecretKey: Uint8Array;                      // 64-byte ed25519 secret
  userSolPrefundExtraLamports?: string;           // set for LayerZero/USDT0 routes
}): Promise<string> {
  const chainId = -100;

  const estimate = await postJson<Estimate>(`${BASE_URL}/gasless/solana/transactions/estimate`, {
    chainId,
    userAddress: opts.userAddress,
    feeTokenAddress: opts.feeTokenMint,
    instructions: opts.instructions,
  });
  console.log(`will pay ${estimate.feeAmount} of ${estimate.feeTokenAddress}`);

  const created = await postJson<Created>(`${BASE_URL}/gasless/solana/transactions`, {
    chainId,
    userAddress: opts.userAddress,
    feeTokenAddress: opts.feeTokenMint,
    instructions: opts.instructions,
    addressLookupTables: opts.addressLookupTables,
    ...(opts.userSolPrefundExtraLamports ? { userSolPrefundExtraLamports: opts.userSolPrefundExtraLamports } : {}),
  });

  const userSig = signSolanaMessage(opts.userSecretKey, created.unsignedTransactionBase64);

  const submitted = await postJson<{ requestId: string; status: string }>(
    `${BASE_URL}/gasless/solana/transactions/${created.requestId}/submit`,
    { userSignature: userSig },
  );
  console.log(`submitted ${submitted.requestId} -> ${submitted.status}`);

  return created.requestId;
}

function signSolanaMessage(secretKey: Uint8Array, txBase64: string): string {
  const buf = Buffer.from(txBase64, 'base64');
  const numSigs = buf[0];
  const msgStart = 1 + numSigs * 64;
  const messageBytes = new Uint8Array(buf.slice(msgStart));
  const sig = nacl.sign.detached(messageBytes, secretKey);
  return bs58.encode(sig);
}

interface SerializedSolanaInstruction {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;  // base58
}
```

### Solana signing format

The `unsignedTransactionBase64` from `POST /transactions` is a serialized `VersionedTransaction` with empty signature slots. To sign:

1. Base64-decode to bytes.
2. The first byte is `numSignatures`. Skip `1 + numSignatures * 64` bytes — those are the empty signature placeholders. The remainder is the **message** (the bytes that get signed).
3. Run `nacl.sign.detached(messageBytes, userSecretKey)` to produce a 64-byte signature.
4. Base58-encode the signature and send it as `userSignature`.

The backend re-derives the same message bytes from its stored copy of the unsigned transaction and verifies the signature with `nacl.sign.detached.verify` against the user's pubkey. A mismatch returns `40005 GASLESS_INVALID_SIGNATURE`.

The operator's signature is added by the backend during broadcast — you never see it.

### Solana Address Lookup Tables

Solana V0 transactions can reference accounts via Address Lookup Tables (ALTs). Routing providers (Jupiter, Rango bridges) ship their swap/bridge responses against well-known ALTs to fit under the 1232-byte wire limit. When you parse a `serializedMessage` from a Rango response, you need to:

1. Decode the message envelope.
2. Extract the `addressTableLookups` array — these are the ALT pubkey references.
3. Resolve them (via `getAddressLookupTable` on a Solana RPC) to expand instruction account lists into actual pubkeys, so you can describe each instruction in the wire format `{ programId, keys: [{pubkey, isSigner, isWritable}], data }`.
4. **Keep the ALT pubkey list** (the base58 keys, not the resolved contents). Pass this array as `addressLookupTables` to `POST /transactions`.

If you forget step 4, the backend has to inline every referenced account at full 32-byte cost and you'll hit `40008 GASLESS_TX_TOO_LARGE` on anything but trivial intents.

### Solana browser-wallet signing (Phantom, Solflare, Backpack)

Browser wallets expose a signing API at `window.solana.signTransaction(tx)` that takes a `VersionedTransaction` instance and returns the same instance with the user's signature filled in. The flow:

```ts
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const tx = VersionedTransaction.deserialize(
  Buffer.from(created.unsignedTransactionBase64, 'base64'),
);
// Phantom/Solflare/Backpack — same interface
const signed = await window.solana.signTransaction(tx);

// Find the user's signature slot
const userPubkey = new PublicKey(userAddress);
const slot = signed.message.staticAccountKeys.findIndex((k) => k.equals(userPubkey));
const userSig = bs58.encode(signed.signatures[slot]);

await postJson(`${BASE_URL}/gasless/solana/transactions/${created.requestId}/submit`, {
  userSignature: userSig,
});
```

The wallet handles the ed25519 signature internally. You only need to extract the resulting signature from the slot matching the user's pubkey.

### Solana swap-fee path size limits — when it fits, when it doesn't

The swap-fee path appends Rango/Jupiter swap instructions on top of the user's intent. Solana's 1232-byte wire limit means **two swaps in one transaction usually don't fit**. Practical guidance:

| User intent | Fee path | Result |
|---|---|---|
| Simple SPL transfer (1-2 instructions) | Swap-fee (non-accepted token) | ✓ Fits — works |
| Simple SPL transfer | Direct-accepted fee (USDC, xTSLA, …) | ✓ Trivially fits |
| Same-chain SPL swap via Jupiter | Swap-fee | ✗ Two swaps + ALTs almost never fit → `40008 GASLESS_TX_TOO_LARGE` |
| Same-chain SPL swap via Jupiter | Direct-accepted fee | ✓ Works (one swap + direct fee) |
| Cross-chain bridge (Solana → BSC etc.) | Swap-fee | ✗ Bridge + Jupiter fee-swap + ALTs → 40008 |
| Cross-chain bridge | Direct-accepted fee | ✓ Works (bridge + one TransferChecked) |

**Practical rule:** if the user's intent is "a simple SPL/SOL transfer" the swap-fee path works in any fee token. If the user's intent already contains a swap or bridge, **insist on a directly-accepted fee token** (USDC is the safest default on Solana mainnet).

When you hit `40008`, the response body's `message` field lists the four options that actually help — switching to a directly-accepted fee token is almost always the right one.

### Size fallback — single tx vs Jito bundle

When the swap-fee transaction (a Jupiter swap plus the user's intent) overflows Solana's 1232-byte limit in single-tx mode, the request **auto-falls-back to a 2-transaction Jito bundle** instead of hard-failing:

- an **operator-signed SOL-prefund** tx, plus
- the **user-signed** `[swap + intent + Jito tip]` tx.

Both land **all-or-nothing** as a bundle. The prefund tx is signed server-side and never sent to you.

**The user still signs exactly ONE transaction.** From the integrator's perspective the flow is unchanged — you collect a single Solana signature whether the request is served as a single tx or as the fallback bundle. The estimate/create response's `mode` field (`single` | `bundled`) tells you which path was chosen; the user-signable transaction is always the one returned in `unsignedTransactionBase64`. (A future two-signature path for intents that overflow even without the operator prefund is planned but not implemented — see the fee-model card.)

> **Planned, not implemented:** a future two-signature path — splitting the swap from the intent for intents that overflow even without the prefund — is on the roadmap but **not built**. Integrators collect exactly one Solana signature today.

### Solana unresolved scenarios and use conditions

Two configurations exceed Solana's 1232-byte wire limit for reasons intrinsic to the tx format, not to our backend. Neither is a bug we can fix without changes to Rango's route selection or a protocol change to Solana. Use conditions below are what actually works reliably today (verified 2026-07-08 e2e).

**1. Combined swap-fee + swap-intent.** User pays fee in a non-accepted token *and* the intent itself is a same-chain or cross-chain swap. Rango returns a swap message for the intent, and the backend appends a separate Rango swap for the fee — two swap prologues, two ALT sets, two CU budgets. Even after all our dedupe and ALT compression, this combination overshoots ~1232 bytes.

- **Fails with:** `40008 GASLESS_TX_TOO_LARGE` at `POST /transactions` (create step), before any signature is collected. No funds are spent.
- **Workarounds (in order of preference):**
  - Switch the fee to a directly-accepted token (add to `GASLESS_ACCEPTED_FEE_TOKENS` — e.g. add USDC or the xStock the user already holds). This is the recommended fix — it takes the fee-side swap out of the tx entirely.
  - Pay the fee in native SOL (`feeTokenAddress = 11111111111111111111111111111111`). One SystemProgram.transfer is ~150 bytes vs ~300–500 for a swap.
  - Split the user's intent into two separate gasless txs.
- **Use condition (works):** either the intent OR the fee involves a swap, not both.

**2. Heavier xStock (xTSLA/xAAPL/xNVDA) amounts through the Mayan bridge.** For a direct-accepted xStock fee + xStock→USDT@BSC bridge intent, Rango's route selection depends on the bridge amount. At small amounts (~0.008 xTSLA and below) Rango often picks Relay (~800-byte serialized msg) — the whole gasless tx lands under 1232 bytes. At larger amounts (~0.02 xTSLA and above) Rango's route optimizer prefers Mayan and larger routes that already consume ~1050+ bytes; adding our fee prelude pushes total wire size past 1232.

- **Fails with:** `40008 GASLESS_TX_TOO_LARGE` at create, same as case (1). No funds spent.
- **Route selection is not deterministic** — the same amount can pick Relay this minute and Mayan next minute depending on liquidity. So even a "known-good" amount can occasionally fail. The safe operating band is where Rango consistently picks the shorter route.
- **Use conditions (works):**
  - Bridge amount ≤ ~0.008 xTSLA (≈ $3.20 at $400 xTSLA) — verified reliable.
  - Same guidance for xAAPL/xNVDA at proportionally-scaled amounts (~$3–4 USD equivalent).
- **Use conditions (fails):** bridge amount ≥ ~0.02 xTSLA (≈ $8+). Wallet team's attempts 1–2 on 2026-07-08 at ≥ 0.02 xTSLA hit this. Documented as a Rango route-selection intrinsic, not a backend bug.
- **Workarounds:**
  - Split large amounts into multiple sub-0.008 xTSLA bridges (each its own gasless tx).
  - Fall back to a non-gasless flow (user signs and pays their own SOL fee) for large bridges — no 1232-byte limit applies to the user's own fee-paying tx because it doesn't carry our fee prelude.

**Not on this list = works.** Direct-accepted-fee + simple SPL/SOL transfer, direct-accepted-fee + same-chain Jupiter swap, direct-accepted-fee + small-amount bridge, swap-fee + simple transfer — all verified working. The two rows above are the *only* known configurations that hit the wire limit as of 2026-07-08.

### Solana fee-token behavior — what's accepted directly vs swapped

The accepted-fee-token list is configured per-cluster via `GASLESS_ACCEPTED_FEE_TOKENS` env var. The default on Solana mainnet (`chainId: -100`) is:

```
GASLESS_ACCEPTED_FEE_TOKENS=56:USDT,8453:USDT,42161:USDT,-100:USDC,-100:xTSLA,-100:xNVDA,-100:xAAPL
```

**Three fee paths exist on Solana:**

| Path | When | What we do |
| --- | --- | --- |
| Native SOL fee | `feeTokenAddress` = `11111111111111111111111111111111` (or omitted) | One `SystemProgram.transfer` from user to treasury — cheapest tx; user needs SOL in their wallet beyond what the bridge consumes |
| Direct-accepted SPL fee | `feeTokenAddress` ∈ accepted list (USDC, xTSLA, etc.) | `TransferChecked` of fee token from user's ATA to operator's treasury ATA. No swap, no Rango call. |
| Swap fee | `feeTokenAddress` is NOT in accepted list | Rango/Jupiter quote → swap instructions appended that convert user's token → accepted token → treasury. Adds ~200k CU + ~3 instructions. |

For the swap path, sub-$0.10 fees historically returned `30002 NO_ROUTE` from Jupiter because DEX pool minimums kicked in. The backend now enforces `SOLANA_MIN_FEE_LAMPORTS` (default 666_666 ≈ $0.10 worth of SOL) ONLY on the swap-fee path; the native + direct-SPL paths use the actual cost without a floor.

If you support fee-tokens with thin DEX pools (long-tail SPLs), raise the floor toward `3_333_333` (~$0.50) via env. If you only support liquid pairs, lower toward `333_333` (~$0.05).

### Solana gotchas (read once before integrating)

- **Atomicity is whole-tx.** If your last user instruction reverts, the fee transfer reverts too — operator gets nothing. Solana has no EVM-style "must-succeed zone preserves the fee" primitive; that requires the EIP-7702 self-call trick which has no analogue here. Build user intents that succeed under realistic state.
- **Blockhash is the freshness primitive, not a per-user nonce.** Don't cache backend responses across users or across long delays. If the user takes more than ~45-60s to sign, throw away the `requestId` and call `/transactions` again (the default `GASLESS_CREATE_TTL_SECONDS=90` already enforces this).
- **Solana addresses are case-sensitive base58.** Don't `.toLowerCase()` them anywhere — `addressFactory` already routes Solana chain IDs to `SolanaAddress` which preserves case.
- **The submit endpoint re-verifies user fee-token balance** (added 2026-06-30). If the user moved tokens out of their wallet between signing and submitting, you'll get `40009 GASLESS_INSUFFICIENT_FEE_BALANCE` and no operator funds will be spent. Re-quote via `/estimate` and try again.

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

### EVM fee-token behavior — accept any ERC-20 or native (RIN-113)

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

The old per-EVM-chain `tokens: {SYMBOL: {address, decimals}}` map is gone. Decimals now come from RPC on-first-sight and are cached. Solana chains still use the old shape (whitelist-drop for Solana is a follow-up card).

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

**Polling cadence:** every 2-5 seconds is fine. Cross-chain bridges (Solana → BSC, BSC → Solana) typically resolve in 15-60 seconds. Intra-chain swaps in 5-15 seconds.

**Polling timeout:** 10-15 minutes is a reasonable upper bound. Beyond that the request is stuck for a reason worth investigating manually (chain congestion, RPC outage, etc.). The backend will eventually transition stuck requests to `FAILED_PERMANENT` after exhausting its own retry budget.

**Sample poller:**

```ts
async function pollUntilTerminal(requestId: string, family: 'evm' | 'solana'): Promise<{ status: string; txHash: string | null; failureReason: string | null }> {
  const TERMINAL = new Set(['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT']);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/gasless/${family}/transactions/${requestId}`);
    const data = await res.json();
    if (TERMINAL.has(data.status)) return data;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`timeout polling ${requestId}`);
}
```

---

## Error codes

The backend uses stable numeric error codes. Each one is family-agnostic; the same code on EVM and Solana means the same thing.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `20001` | 400 | Chain not supported |
| `20002` | 502/503 | RPC unreachable or contract call reverted at RPC (also returned when a delegated EOA's `GaslessDelegate.nonce()` read fails — retry with backoff) |
| `20003` | 503 | No deployed delegate contract for the chain |
| `20004` | 400 | Fee token not found in chain config — **EVM: retired for per-request use** (the token whitelist was dropped; any address is accepted, with unaccepted tokens routed through swap-fee-path). Still fires on Solana for unrecognized mints, and on EVM only for chain-level misconfiguration (fires at boot, not per request) |
| `20005` | 502 | Chain gas estimation failed |
| `30001` | 502 | Rango request failed |
| `30002` | 422 | Rango has no route for the requested swap |
| `30003` | 502 | Rango returned an invalid response |
| `40001` | 400 | Invalid request body (also returned when `userSolPrefundLamports` + `userSolPrefundExtraLamports` are both set) |
| `40002` | 422 | Fee token not accepted and no swap route available |
| `40003` | 404 | Request ID not found |
| `40004` | 410 | Request expired (the create→submit TTL passed before signature arrived; default TTL is 90 seconds) |
| `40005` | 400 | Invalid signature |
| `40006` | 400 | Invalid EIP-7702 authorization (mismatched address/chainId/signature OR `authorization.nonce` does not match the user's current EOA `eth_getTransactionCount` at submit time — fetch via `provider.getTransactionCount(userAddress, 'latest')` immediately before signing to avoid races) |
| `40007` | 409 | Request was already submitted |
| `40008` | 422 | Solana transaction exceeds 1232-byte wire limit |
| `40009` | 422 | User's fee-token balance is below the quoted fee at submit time (user moved tokens out between estimate and submit). For native-fee-token flows, the balance check requires `feeAmount + sum(op.value)`, so watch out for ops that transfer native value out of the same batch |
| `40010` | 400 | Fee-token address does not respond to a standard `ERC20.decimals()` call — either not a contract or not ERC-20-compliant. Pass either the native sentinel (`0xeeee…eeee`) or a valid ERC-20 address |
| `50001` | 502 | Generic broadcast failure (legacy — Solana now uses 50005) |
| `50002` | 504 | Transaction not mined within the relayer's wait window |
| `50003` | 502 | Transaction mined but reverted on-chain |
| `50004` | 500 | Relayer exhausted retries and gave up |
| `50005` | 502 | Solana broadcast rejected (includes program logs) |
| `80001` | 503 | Health check failed (internal use; should not appear in client responses) |
| `90001` | 400 | System validation error (DTO/class-validator failure with field-level details) |
| `90002` | 404 | System resource not found (generic; prefer the 4xx-domain codes above when applicable) |
| `90003` | 409 | Illegal FSM transition — the row's status does not permit the requested action (typically operator-side bug; integrators should not retry, surface the original request to support) |
| `90004` | 409 | Concurrent FSM transition — two workers raced on the same row; the loser sees this. Retry is safe |
| `90099` | 500 | Generic system error (something we didn't classify) |

Important: when you hit `50005` on Solana, the response body includes the actual Solana program logs in `failureReason`. Parse those — they tell you exactly what failed at the protocol level.

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

Same shape for Solana `50005` rejections — the `causes` array carries `{transactionMessage, logs, computedSignature?}` for the rejected broadcast.

---

## Rollout notes for existing integrations

If your wallet currently runs `RewriteAtaPayer` and `DedupeByteIdentical` on Rango's bridge instructions before submitting to the gasless backend, **you should remove those passes** after we deploy commit `db53d81` or later.

**Why:** the backend now does its own pre-funding pass that puts SOL into the user's wallet at the exact moment bridge instructions try to charge them for ATA rent. Your rewrite was solving the same problem from the other end (redirecting rent to the operator), and the dedup was a band-aid for the rewrite collapsing distinct instructions into byte-identical pairs.

**Rollout order:**

- Backend deploys first (already done — on `master` at `db53d81` or later, current `3602b3b`). With your existing rewrite still running, the prefund SOL just sits unused in the user wallet. Wasteful but not broken. Approximate leak: `count(ATA-creates) × 0.00204 SOL` per request that exercises this path.
- Remove your rewrite + dedup from your wallet codebase. After this, the prefund SOL flows through to ATA rents exactly as intended. Operator-side cost is identical to today.
- **Don't remove your passes if the backend isn't on `db53d81` or later.** Without our prefund, you'd see the original "insufficient lamports 0, need 2039280" failure again.

You can verify the deployed backend by checking the broadcaster logs for the new prefund line (`[SolanaBatchBuilderService] prefunding user … with N lamports …`).

**Behavior change 2026-06-30 — fees on bridges with ATA-creates are now higher (the correct amount):**

Until this date the backend silently absorbed the ATA-rent cost of every `CreateAssociatedTokenAccount` inside the user's intent — ~$0.30 per ATA at $150 SOL. After the M1 audit fix, the rent cost is now included in `feeAmount` returned by `/estimate`. **Concrete effect: bridges that create 2 routing ATAs now quote ~$0.60 more in fee than they did yesterday.** Native SOL transfers and simple SPL transfers without ATA-creates are unaffected.

If your wallet shows a fee preview to the user that was cached from a prior `/estimate` response, that cached value is now wrong — re-quote when the user opens the bridge screen. If you always call `/estimate` live, you'll just see the higher (correct) number on the next call.

Operator-side impact: stops the silent subsidy. At 100 bridges/day this was costing ~$60/day or ~$22k/year of operator SOL evaporating into routing-intermediate ATAs.

**Special-case routes that need an override:**

For Rango routes that go through **USDT0 / LayerZero OFT** (the only currently known case), forward the LayerZero `nativeFee` you can extract from Rango's route metadata as `userSolPrefundExtraLamports: "10000000"` (or a precise value from `quoteSend()`). See [Overriding the SOL prefund](#overriding-the-sol-prefund) for details.

After the rollout, run `test:sell-xtsla` or your equivalent end-to-end test to confirm. The new flow has been verified with successful broadcasts including:

- `5S6dFffZ8rdCuCVCxFUp1U8EcxQy4Xqy9eXmaF3EwQp1hCwmA3yRxnsGQthWaF4Qts1g6xQJBS3Asoho7XkUGG7j` (sell xTSLA → BSC USDT, full bridge round-trip, ~17 seconds)
- `2LxwjV6sTPvRzshTeZx149Dum8FAbrc8dbLxeFU8n11k5P89qwtX7t8ofo1ednsmcboQcvzLFyF1MkB2tKEz5yHs` (xTSLA fee-token path)
- `3JkMa1cVtA3Axk6L5CcktFRxFxJ2EEuA6stYa1HA8uZJ4BwcTr9yiqTxFKsvYFapambHh8Bj8KM3ZHDB7tTgQ8qX` (treasury ATA pre-create, one-time operator setup)

If you hit a failure mode after rollout, the relevant flow tags in the backend logs are:

- `prefunding user …` — confirms the prefund pass ran, how many ATAs it covered, and whether a caller-supplied override was applied
- `solana broadcast rejected: …` — the real Solana RPC rejection with program logs attached
- `terminal: …` — the request was classified as non-retryable (simulation error, blockhash expiry, etc.)

For anything else, hit us with the `requestId` and we'll debug from the backend side.

---

## Operator configuration (for backend operators only)

This section is for whoever runs the gasless backend, not integrators. Integrators can skip it.

### Required env vars

| Var | What it sets |
| --- | --- |
| `DATABASE_POSTGRES_*` | Postgres connection (host/port/user/password/database). Required at boot. |
| `REDIS_*` | Redis for create→submit cache. `REDIS_DEFAULT_TTL_SECONDS=300` is overall cache cap; per-stash TTL governed by `GASLESS_CREATE_TTL_SECONDS=90`. |
| `OPERATOR_MNEMONIC` (+ optional `OPERATOR_MNEMONIC_INDEX`, default `0`) | **Primary** operator seed — one BIP-39 mnemonic derives BOTH the EVM operator (`m/44'/60'/0'/0/{index}`, becomes the type-4 `from`) and the Solana fee-payer (`m/44'/501'/{index}'/0'`). Fails fast at boot if unset in production. |
| `OPERATOR_PRIVATE_KEY` / `SOLANA_OPERATOR_PRIVATE_KEY` / `SOLANA_OPERATOR_MNEMONIC` (+`SOLANA_OPERATOR_ACCOUNT_INDEX`) | Legacy per-chain fallbacks, used only when `OPERATOR_MNEMONIC` is unset. |
| `GASLESS_TREASURY_ADDRESS` | EVM address that receives user fees. If unset, falls back to operator pubkey with a startup warning — fine in dev, **NOT** for production. |
| `GASLESS_SOLANA_TREASURY_ADDRESS` | Solana base58 pubkey receiving fees. Defaults to operator pubkey (same warning applies). |
| `ANKR_API_KEY` | RPC provider key, interpolated into each chain's keyed endpoint in `config.yaml` (`${ANKR_API_KEY}`). Unset → the keyed endpoint is dropped and the keyless public fallbacks are used. RPC endpoints themselves live in `config.yaml` (`chains[].rpcUrls`); there are no `*_RPC_URLS` env overrides. |
| `RANGO_API_URL`, `RANGO_API_KEY` | Rango Basic API credentials. |

### Tuning knobs

| Var | Default | What it does |
| --- | --- | --- |
| `GASLESS_BASE_FEE_MARKUP_PERCENT` | `15` | Operator margin on top of raw gas cost. |
| `GASLESS_DEFAULT_GAS_UNITS` | `1500000` | Fallback gas units when EVM estimation fails. |
| `GASLESS_TX_GAS_LIMIT` | `2000000` | Hard cap on the type-4 envelope. |
| `GASLESS_RANGO_SLIPPAGE` | `0.5` | One-side slippage (%) sent to Rango for fee-token swaps. The backend applies 2× this as a buffer on the inverse-quote pattern. |
| `GASLESS_CREATE_TTL_SECONDS` | `90` | Window between `/transactions` and `/submit`. Tighter = less race exposure; looser = more forgiving of slow mobile-wallet flows. |
| `GASLESS_PREFUND_SIZING` | `simulate` | How the Solana user-SOL prefund is sized: `simulate` (default — measure the exact SOL via a with/without-prefund simulation, floored at the scan; fixes 0-SOL swap-fee estimates and catches non-ATA native fees; logs scan-vs-sim-vs-applied) or `scan` (static ATA-create scan — the automatic fallback when simulation is unavailable and an emergency opt-out). See [Solana architecture › Prefund sizing](./solana-architecture.md#prefund-sizing). |
| `GASLESS_MAX_PREFUND_LAMPORTS` | `50000000` | Hard ceiling on operator→user SOL prefund per tx. Caller overrides **and** the `simulate`-measured value are rejected (`40001`) when they exceed this. |
| `GASLESS_EXPOSE_ERROR_CAUSES` | `false` | When `true`, echoes the `causes[]` diagnostics (program logs, aggregator responses) in HTTP error responses. Off by default — a fingerprinting surface; the full detail always goes to the server logs regardless. Turn on only for dev/debug. Field-level validation causes (`90001`) are always returned. |
| `SOLANA_DEFAULT_PRIORITY_MICROLAMPORTS_PER_CU` | `1000` | Default priority fee. Raise during congestion. |
| `SOLANA_SOL_USD_PRICE`, `SOLANA_FEE_TOKEN_USD_PRICE` | unset | Required to enable the price-cross fallback when Rango is unavailable on swap-fee path. Backend refuses fallback math without both set (prevents silent operator subsidy). |
| `SOLANA_MIN_FEE_LAMPORTS` | `666666` (≈$0.10) | Minimum fee on the swap-fee path only. Curve: $0.005 → fails routinely; $0.03 → minute-to-minute variance; $0.10 → always works for mainstream pairs; $0.50+ → works for thin meme pools. |
| `RELAYER_CRON` / `RELAYER_SOLANA_CRON` | `*/5 * * * * *` | Cron cadence for the EVM / Solana relayer ticks (every 5s). |
| `RELAYER_MAX_RETRIES` | `6` | Max retry-budget per row (per-row column snapshots on insert). |

### Treasury ATA pre-creation (Solana)

When a user pays in an SPL fee token whose operator-side treasury ATA does not yet exist, the auto-fee-prelude `CreateAssociatedTokenAccount` adds ~80 bytes to the message. That can push complex bridges over Solana's 1232-byte limit. The fix is one-time per fee-token mint: send 0 (or any) units of the SPL to the operator's treasury address, which creates the ATA. After that, the prelude skips the create and uses ~80 fewer bytes per request.

Mints already pre-created on the production operator:

| Token | Mint | Treasury ATA |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `7uxjAsPKfLFUD3q1xFhjfBgvgvT2YJ9nRbU7XdWU9Wst` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `BWsjbkc2QKPoncKYu3CeQGbBuSn2W9PF7CYv4BhhccmC` |
| xTSLA | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | `9AANNpBCxRnWbUg1adNPEfqcNje4xY2SwEZrrm1VrgLG` |
| xNVDA | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | `HkDSNvDA7ecpRFUrmvVXQgJ4vutmF1gZT2ApegT7KkNH` |
| xAAPL | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | `BV81ypMMo49gun8tbBAikego7sxbfdqMJuxxsPBC4frt` |

Pre-create tx: [`3JkMa1cVtA3Axk6L5CcktFRxFxJ2EEuA6stYa1HA8uZJ4BwcTr9yiqTxFKsvYFapambHh8Bj8KM3ZHDB7tTgQ8qX`](https://solscan.io/tx/3JkMa1cVtA3Axk6L5CcktFRxFxJ2EEuA6stYa1HA8uZJ4BwcTr9yiqTxFKsvYFapambHh8Bj8KM3ZHDB7tTgQ8qX). Repeat the same one-shot for any new accepted-SPL fee token before announcing it as accepted.
