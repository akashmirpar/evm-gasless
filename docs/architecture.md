# Architecture

## What the system does in one paragraph

A user wants to execute arbitrary EVM operations from their own EOA but doesn't want to pay native gas. They have some ERC-20 (say USDT) they'd rather pay the fee with. They (a) sign an **EIP-7702 authorization** delegating their EOA to the `GaslessDelegate` contract, and (b) sign an **EIP-712 batch** that includes both the fee payment (to a treasury, optionally via a Rango swap if the fee token isn't directly accepted) and their actual intent ops. An operator picks up the signed batch over HTTP, broadcasts a type-4 transaction (the user's EOA running `GaslessDelegate.executeBatch`), and pays the gas. The treasury receives the fee in the accepted token. The user got their ops executed without holding native gas tokens.

## Components

```
 ┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
 │  Client app /    │     │  Gasless backend    │     │  Chain               │
 │  Wallet UI       │     │  (NestJS)           │     │  (BSC/Base/Arbitrum) │
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
| Shared chain config | [`gasless/chains/`](../chains/) | `chains.json` (per-chain RPC defaults, tokens, names) and `deployed.json` (per-chain delegate contract address — written by the deploy script). |

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

`executeBatch` has **no admin gate**. Anyone holding the user's signed batch can submit it and pay gas. They can't profit by redirecting the fee, because the user's signature locks the treasury recipient. The operator wallet configured in the backend (`OPERATOR_PRIVATE_KEY`) is just whoever pays gas — the contract has no notion of them.

This matters for integration: if a third party wants to provide a redundant submitter (failover relayer, MEV-resistant inclusion service, etc.), they can do it without any contract change. They just need the signed batch.

## Data flow, step by step

1. **Client → backend `POST /gasless/transactions/estimate`** — client describes (chainId, userAddress, feeTokenAddress, list of user ops). Backend quotes a fee in the user's fee token. Stateless — nothing is persisted yet.
2. **Client → backend `POST /gasless/transactions`** — client confirms it wants to proceed. Backend:
   - Re-runs the fee estimate.
   - Builds the batch: prepends `[transfer]` or `[approve, swap]` to the user's ops.
   - Reads the user EOA's `nonce()` from chain (`max` across configured RPCs).
   - Returns `{ requestId, delegateContractAddress, operations, atomicGroupStart, nonce, digest, expiresAtSeconds }`.
   - Stashes the prepared batch in Redis with a TTL (default 300s).
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
| Redis | Prepared-batch stash between `POST /transactions` and `POST /:id/submit`. | `GASLESS_CREATE_TTL_SECONDS`, default 300s. |
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
