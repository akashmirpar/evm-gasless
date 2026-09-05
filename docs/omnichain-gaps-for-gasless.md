# omnichain (@getomnichain/omnichain@0.2.0) — gaps for the gasless service

What gasless needs from omnichain to become a **pure** omnichain consumer (all
chain connectivity + broadcast through `Chain`), and what 0.2.0 does **not**
provide today. For each gap: whether it's reachable via the raw escape hatch
(`EvmChain.getProvider()` / `SolanaChain.getConnection()`) or entirely absent,
and a suggested API. This is a hand-off list for the omnichain team; gasless
does **not** need any of it to ship the current upgrade (package swap + new
Solana id) — it's what's required for the deeper "connect only via omnichain"
migration later.

Reference consumers already on omnichain: `depositron`, `rango-intents`.

---

## What 0.2.0 already covers (no gap)

- EVM: `getProvider()`, `suggestGas(priority)`, `getBalance`, `getTransactionStatus`,
  `getChainTipHeight`, `validateAddress`, `validateTokenIdentifier`, `nativeToken`.
- Solana: `getConnection()`, `suggestPriorityFeeMicroLamports(priority)`
  (samples `getRecentPrioritizationFees`), `estimateAndApplyCu` (simulate +
  CU right-size), `refreshBlockhash`, `isBlockhashExpiredError`,
  `isSimulationError`, `resolveTokenProgramId` (SPL vs Token-2022),
  `resolveMintDecimals`, `getTransactionStatus`, `getChainTipHeight`,
  `buildNativeTransferInstruction`, `buildSplTransferInstructions`.

Most of gasless's Solana fee/simulation/priority logic maps onto these.

---

## Gaps — first-class API missing

### EVM

1. **Broadcast an externally-signed raw transaction.**
   - Need: submit a transaction gasless already signed itself (operator-signed,
     often EIP-7702 type-4) and get a tx hash — `chain.broadcastRawTransaction(signedHex)`.
   - 0.2.0: only `createTransferUnsignedTransaction` (builds a transfer). No raw
     broadcast on `Chain`. Reachable today only via `getProvider().broadcastTransaction()`.

2. **EIP-7702 support (the big one).** gasless is a 7702 gasless relayer:
   - type-4 transactions with an `authorizationList`,
   - the `GaslessDelegate.executeBatch(ops, atomicGroupStart, batchNonce, signature)`
     delegate call,
   - delegation-status detection: reading `getCode(userAddress)` and matching the
     `0xef0100<delegateAddress>` indicator.
   - 0.2.0: no 7702 concept anywhere — no authorization struct/signing, no
     delegate-call helper, no delegation-status check. Entirely gasless-side today.
   - Suggested: an opt-in 7702 extension (authorization builder + type-4
     broadcast + `getDelegation(address)`), or accept this stays consumer-side.

3. **Nonce accessor** — `getTransactionCount(address, 'pending')` for the operator.
   Absent on `Chain`; via `getProvider()` only.

4. **Mined receipt with block number** — gasless records the mined `blockNumber`
   and success/revert. Confirm `EvmTransactionStatus` exposes `blockNumber`; if it
   only carries a success/pending enum, gasless still needs
   `getProvider().getTransactionReceipt()`.

5. **Multi-endpoint RPC fallback.** `EvmChainInit.rpcUrl` is a single URL; gasless
   (and prod resilience) want an ordered list with automatic failover. Today gasless
   races/falls back across several endpoints. Suggested: `rpcUrls: string[]` with
   built-in failover, or document constructing one `EvmChain` per endpoint.

### Solana

6. **Broadcast an externally-signed raw transaction** with options
   (`sendRawTransaction(serialized, { skipPreflight, maxRetries })`). gasless
   broadcasts a tx already signed by user + operator. Absent on `Chain`; via
   `getConnection()` only.

7. **Jito bundle submission.** Bundled mode posts an atomic bundle (operator
   prefund tx + user tx + tip) to the Jito block-engine and polls inclusion.
   0.2.0: no Jito. Entirely gasless-side.

8. **Address Lookup Table (ALT) support.** gasless attaches an operator-owned ALT
   to collapse static accounts under the 1232-byte wire limit. Confirm
   `createInstructionsUnsignedTransaction` accepts `addressLookupTableAccounts`;
   if not, it's a gap for the bundled/large-intent path.

9. **SOL prefunding primitive.** Operator atomically funds a SOL-less user's
   rent/ATA-create/fees. gasless sizes this by simulation. This is gasless policy;
   omnichain would only need to not get in the way (raw instruction + broadcast,
   which #6 covers).

10. **Arbitrary account-info / ATA-existence read.** gasless checks treasury-ATA
    existence and raw mint accounts. `resolveTokenProgramId`/`resolveMintDecimals`
    cover part; a generic `getAccountInfo(pubkey)` (or `ataExists(owner, mint)`)
    would remove the remaining `getConnection()` drops.

11. **Signature-status batch** — `getSignatureStatuses([...])`. `getTransactionStatus`
    covers single-tx; batch polling is via `getConnection()` only.

### Cross-cutting

12. **The unifying gap is "broadcast + track a transaction the consumer signed."**
    omnichain today owns the whole build→sign→send path for its own transfers.
    gasless signs its own transactions (7702, user+operator, Jito bundles) and
    needs omnichain to (a) hand over a provider/connection — which it does — and
    (b) offer first-class `broadcastRawTransaction` + status tracking so consumers
    don't drop to the raw client. (a) already unblocks gasless; (b) is what makes
    "only via omnichain" literally true.

---

## Packaging / interop issues (affect every CJS consumer)

- **ESM-only** (`"type": "module"`, no CJS build). CommonJS consumers (gasless,
  NestJS `tsc`→CJS) load it only via Node ≥ 20.19 `require(esm)`. A future publish
  introducing top-level `await` anywhere would break `require()` with no consumer
  change. Suggested: ship a CJS build (dual `exports`), or document + enforce the
  Node floor and no-TLA constraint.
- **Bundles its own `class-validator` / `class-transformer`.** A consumer on a
  different `class-validator` major ends up with two installed copies; decorators
  and the validator agree only because they share `global` metadata storage. If
  that coincidence ever breaks, `@AddressField` validation silently no-ops.
  Suggested: make `class-validator`/`class-transformer` **peer** dependencies.
- **`AddressField`/`IsAddress` dropped the native-token sentinel short-circuit**
  that the previous (vendored) version had — the case-insensitive `0xee…ee`
  sentinel is now subjected to EIP-55 checksum validation and a mixed-case
  sentinel is rejected. gasless is restoring this on its side; upstream may want
  the native branch back.
- **`NATIVE_TOKEN_SENTINEL` is not exported.** Consumers that recognize the native
  sentinel must keep a private copy in lockstep with the package's internal
  `EvmAddress` behavior. Suggested: export it.
- **`decimal.js` is a required peer install** but not declared as a `peerDependency`
  (README tells consumers to `npm install … decimal.js`). Suggested: declare it.
