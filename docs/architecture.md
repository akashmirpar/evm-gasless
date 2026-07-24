# Architecture

The system supports two transaction families, with structurally similar API shape but very different underlying primitives. Any EIP-7702-capable EVM chain can be added by deploying `GaslessDelegate` and adding a `chains:` entry to `backend/config.yaml` — BSC, Base, and Arbitrum are configured today:

- **EVM** (any EIP-7702 chain; BSC, Base, Arbitrum today) — uses EIP-7702 to delegate the user's EOA to a `GaslessDelegate` Solidity contract; the user signs an EIP-712 batch; the operator submits a type-4 transaction.
- **Solana** — uses Solana's native multi-sig: the operator is the transaction's fee payer (covers SOL); the user co-signs as authority over their own token accounts. No delegation contract.

Most of this doc is written EVM-first because that's the more involved path. The Solana-specific bits are flagged in the relevant sections, and [solana-architecture.md](solana-architecture.md) is the dedicated Solana reference.

## What the system does in one paragraph

A user wants to execute arbitrary EVM operations from their own EOA but doesn't want to pay native gas. They have some ERC-20 (say USDT) they'd rather pay the fee with. They (a) sign an **EIP-7702 authorization** delegating their EOA to the `GaslessDelegate` contract, and (b) sign an **EIP-712 batch** that includes both the fee payment (to a treasury, optionally via a Rango swap if the fee token isn't directly accepted) and their actual intent ops. An operator picks up the signed batch over HTTP, broadcasts a type-4 transaction (the user's EOA running `GaslessDelegate.executeBatch`), and pays the gas. The treasury receives the fee in the accepted token. The user got their ops executed without holding native gas tokens.

## Components (EVM)

```
 ┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
 │  Client app /    │     │  Gasless backend    │     │  Chain               │
 │  Wallet UI       │     │  (NestJS)           │     │  (any EVM chain)     │
 │                  │     │                     │     │                      │
 │  - holds user PK │     │  - quotes fee       │     │  - GaslessDelegate   │
 │  - signs EIP-712 │ ──► │  - builds batch     │ ──► │    deployed (used    │
 │  - signs EIP-7702│     │  - signs operator  │     │    via EIP-7702      │
 │    auth          │     │    tx, broadcasts   │     │    delegation)       │
 │  - polls status  │     │  - tracks lifecycle │     │  - Rango router      │
 └──────────────────┘     └─────────────────────┘     └──────────────────────┘
            │                       │                         │
            │                       │                         │
            └───── HTTP REST ───────┘                         │
                                    │                         │
                                    └────── ethers v6 ────────┘
                                          (type-4 tx)
```

| Piece | Lives in | What it owns |
|-------|----------|--------------|
| Solidity contract (`GaslessDelegate`) | [`gasless/contract/`](../contract/) | EIP-7702 delegate target. Verifies EIP-712 batch signatures bound to the EOA itself. Splits each batch into must-succeed zone + atomic group. |
| Backend service | [`gasless/backend/`](../backend/) | HTTP API, fee estimation, Rango swap construction, Redis-stashed prepared batches, Postgres-tracked submitted transactions, relayer poller. |
| Shared chain config | [`gasless/chains/`](../chains/) | the `chains:` section of `backend/config.yaml` (per-chain RPC endpoints, tokens, names) and `chains/deployed.json` (per-chain delegate contract address — written by the deploy script). |

## The two zones (and why)

`executeBatch(ops, atomicGroupStart, batchNonce, signature)` divides `ops` at `atomicGroupStart`:

- **Must-succeed zone** `ops[0..atomicGroupStart-1]`: fee payment. Whole-tx revert if any fails. The operator only gets paid if these succeed.
- **Atomic group** `ops[atomicGroupStart..]`: user intent. Isolated via self-call. If anything in this group fails, **only the group** reverts; the must-succeed zone (fee) and the nonce increment survive. So the operator is reimbursed for gas even when the user's intent doesn't fit.

Two examples of what the must-succeed zone looks like:

| User pays fee in… | Must-succeed zone ops | atomicGroupStart |
|-------------------|------------------------|------------------|
| A token the operator accepts (USDT) | `[ERC20.transfer(treasury, fee)]` | 1 |
| A token the operator doesn't accept (e.g. CAKE) | `[ERC20.approve(rango, fee), rango.swap(CAKE→USDT, recipient=treasury)]` | 2 |

The user signs whichever shape applies. The signature commits to every byte of every op (and to `atomicGroupStart` itself), so a submitter can't redirect any payment or move the boundary — see [../contract/docs/eip712-batch-hashing.md](../contract/docs/eip712-batch-hashing.md).

## Submission is permissionless

`executeBatch` has **no admin gate**. Anyone holding the user's signed batch can submit it and pay gas. They can't profit by redirecting the fee, because the user's signature locks the treasury recipient. The operator wallet configured in the backend (`OPERATOR_MNEMONIC`) is just whoever pays gas — the contract has no notion of them.

This matters for integration: if a third party wants to provide a redundant submitter (failover relayer, MEV-resistant inclusion service, etc.), they can do it without any contract change. They just need the signed batch.

## Data flow, step by step

1. **Client → backend `POST /gasless/transactions/estimate`** — client describes (chainId, userAddress, feeTokenAddress, list of user ops). Backend quotes a fee in the user's fee token. Stateless — nothing is persisted yet.
2. **Client → backend `POST /gasless/transactions`** — client confirms it wants to proceed. Backend:
   - Re-runs the fee estimate.
   - Builds the batch: prepends `[transfer]` or `[approve, swap]` to the user's ops.
   - Reads the user EOA's `nonce()` from chain (`max` across configured RPCs).
   - Returns `{ requestId, delegateContractAddress, operations, atomicGroupStart, nonce, digest, expiresAtSeconds }`.
   - Stashes the prepared batch in Redis with a TTL (default 90s).
3. **Client signs locally**:
   - **EIP-712 signature** over `(operations, atomicGroupStart, nonce)` with `domain = { name: "GaslessDelegate", version: "1", chainId, verifyingContract: userAddress }`.
   - **EIP-7702 authorization tuple** over `(chainId, delegateContractAddress, EOA's tx count)` using the same EOA key.
4. **Client → backend `POST /gasless/transactions/:requestId/submit`** — sends both signatures. Backend verifies the EIP-712 signature recovers to `userAddress`, validates the authorization shape, persists a `transaction_request` row in `PENDING`, drops the Redis stash. Returns `{ requestId, status: 'PENDING' }`.
5. **Backend relayer poller** picks up the row every few seconds. Builds and signs the type-4 transaction (using the operator wallet), broadcasts via the chain's RPCs, transitions the row through the FSM:
   ```
   PENDING ─►BROADCASTING ─►BROADCASTED ─►MINED_SUCCESS | MINED_FAILED
                                            └► (or FAILED_PERMANENT after retries)
   ```
6. **Client → backend `GET /gasless/transactions/:requestId`** — polls for status. Once terminal, response includes `txHash` and (if failed) `failureReason`.

## Trust assumptions

| Party | What they must trust |
|-------|----------------------|
| **User** | The fee path encoded into the batch they sign (the UI must display the prepared `operations` honestly). Nothing about the operator's identity — the signature locks the treasury. |
| **Operator** | The user's own private key (otherwise the signature won't verify). Rango's swap router for cross-token fee payments. |
| **Third-party submitter** | Nothing — they can submit any signed batch and the contract enforces correctness. |

The signature is a bearer token until the nonce is consumed: anyone holding the signed bytes can submit them. Users mitigate by signing only when ready to execute and by advancing the nonce (via a no-op batch) if they need to invalidate.

## State

| Location | Purpose | TTL |
|----------|---------|-----|
| Redis | Prepared-batch stash between `POST /transactions` and `POST /:id/submit`. | `GASLESS_CREATE_TTL_SECONDS`, default 90s. |
| Postgres `transaction_request` | Submitted requests, FSM status, retry counters, tx hash. | Permanent until manually pruned. |
| Postgres `transition_log` | Append-only audit log of every status transition. Debug-only; never read by business logic. | Permanent. |
| On-chain `GaslessDelegate.nonce` | Per-EOA nonce stored in the delegated EOA's storage. Increments on every successful `executeBatch` (whether atomic group succeeded or not). | On-chain forever. |

## Where things can fail (and how the system reacts)

| Failure | Where surfaced | Recovery |
|---------|----------------|----------|
| User signed wrong nonce | Tx reverts on chain with `InvalidNonce` → row reaches `MINED_FAILED` | Client must call `POST /gasless/transactions` again to read a fresh nonce, then re-sign. |
| User has insufficient fee-token balance | Must-succeed zone reverts → whole tx reverts → row reaches `MINED_FAILED`, nonce **not** consumed | Client should top up the user's fee token balance and retry. |
| User's intent op reverts | Atomic group reverts, must-succeed zone stands → row reaches `MINED_SUCCESS` from the relayer's POV (tx mined OK), with `atomicSucceeded=false` event on chain | The treasury was paid (operator made whole), but the user got no intent execution. Client should inspect the `AtomicReverted` event and possibly retry with adjusted ops. |
| All RPCs unreachable | Relayer can't broadcast, retries with exponential backoff | After `RELAYER_MAX_RETRIES` (default 6), row transitions to `FAILED_PERMANENT`. Operator action required. |
| Rango returns no route | `POST /estimate` or `POST /transactions` returns `GASLESS_FEE_TOKEN_NOT_ACCEPTED_AND_NO_ROUTE` | Client must choose a different fee token. |
| Redis TTL elapsed before submit | `POST /:id/submit` returns `GASLESS_REQUEST_EXPIRED` | Client must restart from `POST /transactions`. |

See [error-codes.md](error-codes.md) for the full code registry.

## Solana — what changes

Solana's transaction model already has a native multi-signer primitive, so EIP-7702 isn't needed and there's no delegate contract on chain. The high-level structure is the same — estimate → create → user signs → submit → poll — but the implementation differs in three important ways.

### No delegation, two signers instead

| | EVM | Solana |
|-|-----|--------|
| **User's role in the broadcast tx** | User's EOA *is* the `from`, via EIP-7702 delegation. Operator is just the tx sender (pays gas). | User co-signs as the *authority* over their own token accounts. Operator is the `feePayer` and the sole gas payer. |
| **Signatures the user provides** | EIP-712 batch signature + EIP-7702 authorization tuple | Single ed25519 signature over the message bytes |
| **What the backend signs** | Type-4 envelope (`from = operator`, `to = user EOA`, includes auth list) | Same `VersionedTransaction`, signed in the feePayer slot |
| **Where the user's nonce lives** | EOA storage at `GaslessDelegate.nonce()` | None — Solana uses recent blockhash as the freshness token |

### No must-succeed/atomic split

Solana transactions are atomic by nature — any instruction failure rolls back the whole tx, including the fee transfer. So the EVM split (must-succeed zone + atomic-group zone) has no Solana equivalent: if the user's intent instructions fail, the operator's broadcast gas is wasted and the user is not charged. There's no "operator gets paid even when the intent fails" semantic on Solana.

This is a real economic difference. If you're integrating both networks, expect a higher failure-cost on Solana from the operator's POV — guarding against bad inputs via `simulateTransaction` before charging the user is the typical mitigation, and the backend does this for sizing the compute-unit limit anyway.

### Different freshness model

EVM relies on `GaslessDelegate.nonce()`. Solana relies on a `recentBlockhash` baked into the `MessageV0`. Each blockhash is valid for ~150 slots (~60 seconds). The backend reads the latest blockhash during `POST /gasless/solana/transactions` and bakes it into the message; the user must submit + the relayer must broadcast within that window. If the request sits in Redis until the blockhash expires, broadcast will fail with `BlockhashNotFound`.

So the Redis TTL effectively *also* needs to be inside the blockhash validity window — much tighter than EVM where a stale nonce just means re-quote. Practical limit: 30-45s between `POST /transactions` and `POST /:id/submit` on Solana.

### Fee pricing — same Rango client

Solana uses the same `RangoClient.quote()` to convert SOL → user's fee token. Rango wraps Jupiter on Solana, so the quote is a real on-chain swap quote, not a cross-table lookup. The flow is identical to EVM:

1. Estimate the SOL cost of the user's instructions via `simulateTransaction` (sizes the compute unit limit).
2. `gasUnits × priorityFee + baseFee` = SOL cost in lamports, plus the markup.
3. `rango.quote({ from: SOL, to: feeToken, amount: lamports })` → fee in the user's token's smallest unit.

If Rango is unreachable the request fails closed (no hardcoded USD-price fallback — that would risk silently under-quoting the fee).

### Persistence

Solana requests live in their own `solana_transaction_request` table, with a parallel FSM (`PENDING → BROADCASTING → BROADCASTED → MINED_SUCCESS|MINED_FAILED|FAILED_PERMANENT`). The relayer poller (`SolanaRelayerJob`) is a sibling of the EVM poller — same shape, separate cron registration. The two pollers never race because they read different tables and the operator's Solana keypair and EVM key are different artifacts.

See [solana-architecture.md](solana-architecture.md) and [integration-guide.md](integration-guide.md) for the API shapes, env vars, and an end-to-end integration sample.
