# EIP-712 batch hashing — design rationale

This document explains why [`_hashBatch`](../src/GaslessDelegate.sol#L130) constructs the digest the way it does — recursively hashing nested data instead of a simpler scheme like length-prefixed concatenation or a reserved delimiter byte.

The short answer: **the recipe is dictated by [EIP-712](https://eips.ethereum.org/EIPS/eip-712) itself**, and the spec rejected the simpler alternatives explicitly. Citations below.

## What `_hashBatch` does

```solidity
function _hashBatch(
    Operation[] calldata ops,
    uint256 atomicGroupStart,
    uint256 batchNonce
) internal view returns (bytes32) {
    bytes32[] memory opHashes = new bytes32[](ops.length);
    for (uint256 i = 0; i < ops.length; ++i) {
        opHashes[i] = keccak256(
            abi.encode(OPERATION_TYPEHASH, ops[i].to, ops[i].value, keccak256(ops[i].data))
        );
    }
    bytes32 structHash = keccak256(
        abi.encode(
            BATCH_TYPEHASH,
            keccak256(abi.encodePacked(opHashes)),
            atomicGroupStart,
            batchNonce
        )
    );
    return _hashTypedDataV4(structHash);
}
```

The `BATCH_TYPEHASH` is the keccak256 of:

```
Batch(Operation[] operations,uint256 atomicGroupStart,uint256 nonce)Operation(address to,uint256 value,bytes data)
```

Five layers of hashing:

| Layer | Operation | EIP-712 rule |
|-------|-----------|--------------|
| 1 | `keccak256(ops[i].data)` | dynamic `bytes` is pre-hashed |
| 2 | `keccak256(abi.encode(OPERATION_TYPEHASH, to, value, hashed_data))` | `hashStruct(Operation)` |
| 3 | `keccak256(abi.encodePacked(opHashes))` | array hash (concat of element hashes) |
| 4 | `keccak256(abi.encode(BATCH_TYPEHASH, opsHash, atomicGroupStart, nonce))` | `hashStruct(Batch)` |
| 5 | `_hashTypedDataV4(structHash)` | domain-separated digest: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` |

`atomicGroupStart` is a static `uint256`, so it is encoded inline in layer 4 (no pre-hashing). Including it in the struct hash is what makes the boundary between must-succeed and atomic zones part of what the user signs — a submitter cannot move the boundary without invalidating the signature. Verified by [`test_revert_invalidSignature_tamperedAtomicGroupStart`](../test/GaslessDelegate.t.sol#L226).

## Why each layer (with EIP-712 citations)

### Layers 1 and 3 — pre-hashing dynamic values and arrays

> "The dynamic values `bytes` and `string` are encoded as a `keccak256` hash of their contents."
>
> "The array values are encoded as the `keccak256` hash of the concatenated `encodeData` of their contents."
> — EIP-712, *Definition of `encodeData`*

Both rules exist for the same reason: variable-length values can't be safely concatenated. Without pre-hashing, `[ab, cd]` and `[a, bcd]` produce identical packed bytes — and a signature over those bytes would authorize either. Hashing collapses each variable-length value to a fixed 32 bytes, eliminating the boundary ambiguity.

### Layers 2 and 4 — typehash binding

> "The function `hashStruct` starts with a `typeHash` to separate types. By giving different types a different prefix the `encodeData` function only has to be injective within a given type."
> — EIP-712, *Rationale for `typeHash`*

This is what stops two structurally-identical structs from colliding. `Operation(address to, uint256 value, bytes data)` and a hypothetical `Transfer(address to, uint256 value, bytes data)` have the same field shape; without the typehash prefix, signatures for one could be replayed against the other on a contract that defined both. Mixing `OPERATION_TYPEHASH` and `BATCH_TYPEHASH` into their respective struct hashes makes the digest unambiguously bound to *this* type definition.

### Layer 5 — domain separator

```solidity
return _hashTypedDataV4(structHash);
```

OpenZeppelin's helper produces `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`. The domain separator is computed from `name = "GaslessDelegate"`, `version = "1"`, `chainId`, and `verifyingContract = address(this)`.

For an EIP-7702 delegate, `address(this)` is the **delegated EOA's own address**. So a signature is bound to a specific user's EOA on a specific chain, and cannot cross-replay even though every delegated user runs identical code. This is the property exercised in [`test_signatureCannotCrossEOAs`](../test/GaslessDelegate.t.sol#L283).

## Why not simpler schemes?

The EIP-712 spec explicitly considered and rejected both alternatives that come to mind first.

### "Just put a delimiter byte between fields"

This fails immediately for `op.data`, which is arbitrary calldata — there is no byte you can guarantee won't appear in it. Workable only with an escape mechanism, which is fragile (canonicalization bugs) and produces variable-length signed bytes.

The spec's equivalent is:

> "[Tight packing] requires complicated packing instructions in EVM to do so. It does not allow in-place computation."
> — EIP-712, *Rationale for `encodeData`*, Alternative 6

### "Just use `abi.encode` directly and sign that"

`abi.encode` (not packed) is length-prefixed and avoids the boundary ambiguity. But:

> "The ABIv2 standard by itself fails the determinism security criteria."
> — EIP-712, *Rationale for `encodeData`*, Alternative 7

ABIv2 is non-deterministic: equivalent values can have multiple valid encodings (different padding, optional offsets), so two encodings of the same logical input can produce different signatures. A canonical scheme is required for cryptographic use.

The recursive-hash approach gives three properties that those alternatives don't:

1. **Fixed-size digest** regardless of payload size or nesting depth — always 32 bytes.
2. **Type binding** at every nesting level via typehashes.
3. **Determinism** by construction — there is exactly one valid hash for any given input.

## Implications for the contract

- **Reordering is detected.** Layer 3 hashes the concatenation of `opHashes`, so swapping any two operations produces a different digest and the signature stops recovering to `address(this)`. Verified by [`test_revert_invalidSignature_tamperedOps`](../test/GaslessDelegate.t.sol#L213).

- **Single-signature for the whole batch.** The user signs *one* digest covering every operation, every field, in order. There is no per-operation signature. This is what the prompt requires ("All of list is signed by user in a single signature, not each item of the list being signed") and the recursive hash is what makes it possible while still committing to every byte.

- **Cross-EOA replay is impossible.** Because the domain separator includes `verifyingContract = address(this)` (the delegated EOA address), a signature meant for user A's EOA fails verification on user B's EOA. See [`test_signatureCannotCrossEOAs`](../test/GaslessDelegate.t.sol#L283).

## References

- [EIP-712](https://eips.ethereum.org/EIPS/eip-712) — Typed structured data hashing and signing. Specifically:
  - *Definition of `encodeData`* — the per-field encoding rules.
  - *Rationale for `typeHash`* — why typehashes are mixed in.
  - *Rationale for `encodeData`* — Alternatives 6 and 7, on why tight-packing and raw ABIv2 were rejected.
- [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) — Set EOA account code. The mechanism by which the EOA temporarily runs this contract.
- OpenZeppelin's [`EIP712`](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/cryptography/EIP712.sol) — the implementation behind `_hashTypedDataV4` and `_domainSeparatorV4`.
