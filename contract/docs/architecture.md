# Architecture

## Roles

| Role | Responsibility |
|------|----------------|
| **Delegator (user)** | Owns the EOA. Authorizes this contract as their EIP-7702 delegate. Signs each batch off-chain with one EIP-712 signature. Pays gas only at delegation time; not for individual batches. |
| **Submitter** | Any address. Calls [`executeBatch`](../src/GaslessDelegate.sol#L58) with the user's signed batch and pays the gas. There is no allowlist or designated relayer — the operator running the gasless service is *typically* the submitter (they collect the must-succeed-zone payment in `ops[0]` to recoup gas), but the contract does not enforce or know about that role. |
| **Treasury** | Recipient of the user's fee payment. The contract does not encode any treasury address; whatever the user signs in the must-succeed zone is what runs. |

## Why permissionless submission is safe

The user's EIP-712 signature commits to the **entire** operation list and the `atomicGroupStart` boundary — every recipient, every value, every byte of calldata, and the placement of each op in must-succeed vs. atomic zones. Any modification by a submitter changes the digest and the signature stops recovering to `address(this)`, so the call reverts with `InvalidSignature`. This is exercised by [`test_revert_invalidSignature_tamperedOps`](../test/GaslessDelegate.t.sol#L213), [`test_revert_invalidSignature_tamperedAtomicGroupStart`](../test/GaslessDelegate.t.sol#L226), and the permissionless path itself by [`test_anyoneCanSubmit`](../test/GaslessDelegate.t.sol#L99).

So a third-party submitter has only two options: forward the batch as-signed (treasury gets the user's intended amount, submitter only pays gas) or refuse to submit. They cannot redirect payment, change amounts, insert/remove/reorder operations, or move the atomic boundary. There is no profitable frontrunning attack — racing to be the submitter only earns the gas bill.

## High-level flow

```
       off-chain                            on-chain
┌──────────────────────┐         ┌──────────────────────────────┐
│ user builds batch:   │         │ anyone → executeBatch(...)   │
│   - must-succeed     │ EIP-712 │   ├─ verify nonce            │
│     zone (fee ops)   │ digest  │   ├─ verify atomicGroupStart │
│   - atomic group     │────────▶│   ├─ verify signature        │
│ user signs digest    │         │   ├─ ++nonce                 │
│ → 65-byte sig + auth │         │   ├─ run ops[0..agStart) raw │
└──────────────────────┘         │   └─ try ops[agStart..) atom │
                                 └──────────────────────────────┘
```

The user's EOA, after EIP-7702 delegation, runs this contract's code on calls to itself. State (`nonce`) lives in the EOA's storage, so each delegated EOA has its own independent nonce sequence.

## Why an EIP-7702 delegate, not a meta-tx forwarder?

A traditional gasless setup uses a forwarder contract that re-calls the user's wallet on their behalf. That requires the user's wallet to support some kind of "execute on behalf" hook, which most EOAs don't have.

EIP-7702 lets an EOA temporarily install contract code at its own address. After delegation:

- `msg.sender` for the inner calls is the EOA itself, not a forwarder.
- The user's existing token balances, allowances, and on-chain identity are reused directly — no proxy address, no migration.
- The signature scheme is bound to the EOA via the EIP-712 domain separator (`verifyingContract = address(this) = the EOA`), so a signature for one user's EOA cannot be replayed against another's even though they run identical code. This is exercised in [`test_signatureCannotCrossEOAs`](../test/GaslessDelegate.t.sol#L283).

## State

Single storage slot:

```solidity
uint256 public nonce;
```

Lives in the delegated EOA's storage. Incremented exactly once per successful `executeBatch` entry, before any external call. See [execution-model.md](execution-model.md) for why the increment happens *before* the must-succeed zone runs.

## Trust assumptions

- **No trusted submitter.** Anyone can submit a signed batch. Censorship is therefore not a single party's problem — if one operator declines to submit, the user (or anyone else) can.
- **Signatures are bearer tokens until consumed.** Once the user signs nonce N, *anyone holding a copy of the signed batch* can submit it until nonce N is consumed. The user treats signing as a commitment to execute, signs only when ready, and uses short-lived nonces if they need to invalidate (sign a no-op batch with the current nonce to advance it).
- **Must-succeed-zone contents are the user's responsibility.** The contract does not validate *who* `ops[0..atomicGroupStart-1]` pays or *what* they call — it only enforces that they all succeed. The user must inspect the batch they sign. Off-chain UI / SDK is responsible for showing the user the fee path (direct treasury transfer vs. approve + swap) before they sign.

## Errors and events

| Symbol | Meaning |
|--------|---------|
| `EmptyBatch` | `ops.length == 0`. |
| `InvalidAtomicGroupStart(atomicGroupStart, opsLength)` | `atomicGroupStart > ops.length`. The boundary index points past the end of the array. |
| `InvalidNonce(expected, provided)` | `batchNonce` does not match the EOA's current nonce. Surfaces both replay attempts and out-of-order submissions. |
| `InvalidSignature` | `ECDSA.recover(digest, sig)` did not return `address(this)`. Indicates wrong key, tampered ops, tampered `atomicGroupStart`, wrong nonce binding, or wrong domain. |
| `OnlySelf` | External caller tried to invoke `_executeAtomic` directly. It is only reachable via the contract's own `try this._executeAtomic(...)`. |
| `BatchExecuted(account, nonce, atomicSucceeded)` | Always emitted on a successful `executeBatch` call. `atomicSucceeded = false` means the must-succeed zone completed but the atomic group reverted. |
| `AtomicReverted(account, nonce, reason)` | Companion event emitted *only* when the atomic group reverts. Carries the raw revert data for off-chain debugging. |
