# Execution model: must-succeed zone + atomic group

A batch is split into two zones by the `atomicGroupStart` index. This is the central design decision of the contract; everything else (the typed signature, the nonce, the `_executeAtomic` self-call) is in service of it.

## The rule

For a batch `ops = [op0, op1, …, opN]` with split `atomicGroupStart = k`:

| Zone | Operations | If it reverts |
|------|------------|---------------|
| **Must-succeed** | `ops[0..k-1]` | The whole `executeBatch` call reverts. Nonce is *not* consumed. |
| **Atomic group** | `ops[k..N]` | Only the group reverts. Must-succeed-zone ops stand. Nonce *is* consumed. `BatchExecuted` is emitted with `atomicSucceeded = false`. |

Edge cases:
- `k == 0` → no must-succeed zone, the entire batch is atomic. The submitter pays gas for nothing if it fails; nonce still advances.
- `k == ops.length` → no atomic group, the entire batch is must-succeed.
- `k > ops.length` → reverts with `InvalidAtomicGroupStart` before any work runs.

The boundary is signed (part of the EIP-712 digest), so the submitter cannot move it. Verified by [`test_revert_invalidSignature_tamperedAtomicGroupStart`](../test/GaslessDelegate.t.sol#L226).

## Why split them?

The product requirement is asymmetric:

- The fee path is what makes the gasless service economically viable. The submitter paid the gas to land this batch; the must-succeed zone is how they get paid back. **All of it must succeed, or the entire submission was wasted.** In the simplest case the must-succeed zone is one op (the treasury transfer). In the unsupported-fee-token case it's three (approve → swap → treasury credit).
- The user's "real" operations (transfers, swaps, approvals — whatever they actually wanted to do) must succeed *or fail together*. Partial execution of a multi-step intent is usually worse than no execution: you don't want a swap to succeed but the follow-up transfer to silently drop.

A single all-or-nothing batch can't deliver both. If the user's last op reverts and that rolls back the fee path, the submitter loses gas with nothing to show. A naively independent loop (each op in its own try/catch) breaks atomicity for the user's intent.

The split says: *charge the user (whatever path that takes), then attempt the work atomically; if the work doesn't fit together, that's between the user and their ops — but the submitter still gets paid for the gas they spent.*

## Worked example — unsupported fee token

User wants to pay the gas fee in TOKEN_X, but only USDT is accepted by the operator. Resulting batch:

| Index | Op | Zone |
|-------|----|------|
| 0 | `TOKEN_X.approve(rangoRouter, amountX)` | must-succeed |
| 1 | `rangoRouter.swap(TOKEN_X → USDT, amount, recipient=treasury)` | must-succeed |
| 2 | user's intent op A | atomic |
| 3 | user's intent op B | atomic |
| 4 | user's intent op C | atomic |

`atomicGroupStart = 2`.

If the approve or swap fail, the whole batch reverts — submitter eats the gas, but no harm done. If the user's intent fails partway, the swap already credited the treasury, the submitter is made whole, and the user's intent ops all roll back. This is the pattern exercised by [`test_feeSwapPattern_mustSucceedZoneIsApproveSwapTreasury`](../test/GaslessDelegate.t.sol#L195).

## How the atomic isolation works

Atomicity inside the EVM is per-call-frame: a top-level `revert` inside one frame rolls back everything in that frame. To isolate a group of ops from the surrounding code, you have to put them in a *separate* call frame and catch any revert at the boundary.

That's done with a self-call:

```solidity
// in executeBatch (after the must-succeed zone already ran)
try this._executeAtomic(ops, atomicGroupStart) {
    // ok
} catch (bytes memory reason) {
    atomicOk = false;
    emit AtomicReverted(address(this), batchNonce, reason);
}
```

[`_executeAtomic`](../src/GaslessDelegate.sol#L104) iterates `ops[atomicGroupStart..end]` and reverts on the first failure. The revert unwinds *that frame only* — the outer `executeBatch` frame catches it, emits `AtomicReverted`, and continues. The must-succeed-zone calls, the nonce increment, and the `BatchExecuted` event are all in the outer frame and survive.

`_executeAtomic` is `external` (it has to be, for `try this....` to make a real call) and guarded:

```solidity
if (msg.sender != address(this)) revert OnlySelf();
```

so no one can invoke it standalone — verified by [`test_revert_executeAtomic_external`](../test/GaslessDelegate.t.sol#L271).

## Why nonce increments before the calls

```solidity
nonce = currentNonce + 1;     // increment first
// then: must-succeed loop
// then: try this._executeAtomic(...)
```

If any op in the must-succeed zone reverts, the whole transaction reverts and the nonce write is rolled back along with everything else — so a failed must-succeed zone leaves the nonce unchanged. This is asserted in [`test_mustSucceedZoneReverts_wholeTxReverts`](../test/GaslessDelegate.t.sol#L138).

If the atomic group reverts, the increment *survives* because the catch happens in the outer frame. This is the desired outcome: the signature for nonce N is consumed, the user moves on to nonce N+1, and the failed atomic group is logged via `AtomicReverted` for debugging.

Incrementing before the call also closes a re-entrancy avenue: an op inside the batch could re-enter `executeBatch`, but it would see the new nonce and any "second use" of the same signature would fail with `InvalidNonce`.

## What does *not* protect the fee path

Worth being explicit about, because it's tempting to assume otherwise:

- **The user's signature does not encode "this op is the treasury".** The contract treats the entire `ops[0..atomicGroupStart-1]` range as must-succeed and runs each in order. The user is responsible for inspecting the batch.
- **There is no on-chain ceiling on amounts.** If the user signs a treasury op draining their entire balance, the contract will execute it. Off-chain validation is the user's job.
- **The contract does not check that any specific address (treasury, rango router, etc.) appears in `ops`.** Different operators may use different treasuries / different DEX routers; the contract is intentionally agnostic.

These are deliberate: pushing policy on-chain would either constrain legitimate flexibility or require additional configuration storage on the delegated EOA, which is undesirable.
