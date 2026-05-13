// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice EIP-7702 delegate target. After a user delegates their EOA to this
/// contract, anyone can submit a batch of operations the user signed off-chain
/// (single EIP-712 signature over the whole batch).
///
/// The batch is split into two zones by `atomicGroupStart`:
///   - ops[0 .. atomicGroupStart-1]  must-succeed zone (e.g. treasury transfer,
///                                   token approval, fee swap). A revert here
///                                   reverts the whole transaction.
///   - ops[atomicGroupStart .. end]  atomic group, isolated via a self-call.
///                                   A revert here unwinds only the group; the
///                                   must-succeed zone and the nonce stand.
///
/// Submission is permissionless because the signature commits to every byte of
/// the must-succeed zone (recipients, amounts, calldata), so a third-party
/// submitter cannot redirect any payment.
contract GaslessDelegate is EIP712 {
    struct Operation {
        address to;
        uint256 value;
        bytes data;
    }

    bytes32 private constant OPERATION_TYPEHASH =
        keccak256("Operation(address to,uint256 value,bytes data)");

    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "Batch(Operation[] operations,uint256 atomicGroupStart,uint256 nonce)Operation(address to,uint256 value,bytes data)"
    );

    /// @dev Per-EOA nonce. Lives in the delegated EOA's storage.
    uint256 public nonce;

    error EmptyBatch();
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error InvalidAtomicGroupStart(uint256 atomicGroupStart, uint256 opsLength);
    error OnlySelf();

    event BatchExecuted(address indexed account, uint256 indexed nonce, bool atomicSucceeded);
    event AtomicReverted(address indexed account, uint256 indexed nonce, bytes reason);

    constructor() EIP712("GaslessDelegate", "1") {}

    /// @notice Execute a user-signed batch on the delegated EOA.
    /// @param ops Operation list, in execution order.
    /// @param atomicGroupStart Index where the atomic group begins.
    ///   - ops[0..atomicGroupStart-1] must all succeed (whole-tx revert otherwise).
    ///   - ops[atomicGroupStart..ops.length-1] execute atomically as a group.
    ///   Must satisfy atomicGroupStart <= ops.length.
    /// @param batchNonce Must equal the EOA's current nonce.
    /// @param signature EIP-712 signature by the EOA over (ops, atomicGroupStart, batchNonce).
    function executeBatch(
        Operation[] calldata ops,
        uint256 atomicGroupStart,
        uint256 batchNonce,
        bytes calldata signature
    ) external {
        if (ops.length == 0) revert EmptyBatch();
        if (atomicGroupStart > ops.length) revert InvalidAtomicGroupStart(atomicGroupStart, ops.length);

        uint256 currentNonce = nonce;
        if (batchNonce != currentNonce) revert InvalidNonce(currentNonce, batchNonce);

        bytes32 digest = _hashBatch(ops, atomicGroupStart, batchNonce);
        address signer = ECDSA.recover(digest, signature);
        if (signer != address(this)) revert InvalidSignature();

        unchecked {
            nonce = currentNonce + 1;
        }

        for (uint256 i = 0; i < atomicGroupStart; ++i) {
            Operation calldata op = ops[i];
            (bool ok, bytes memory ret) = op.to.call{value: op.value}(op.data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }

        bool atomicOk = true;
        if (atomicGroupStart < ops.length) {
            try this._executeAtomic(ops, atomicGroupStart) {
                // ok
            } catch (bytes memory reason) {
                atomicOk = false;
                emit AtomicReverted(address(this), batchNonce, reason);
            }
        }

        emit BatchExecuted(address(this), batchNonce, atomicOk);
    }

    /// @dev External so it can be invoked through a self-call wrapped in
    /// try/catch. Runs ops[atomicGroupStart..end] atomically — any failure
    /// bubbles up and reverts this frame only.
    function _executeAtomic(Operation[] calldata ops, uint256 atomicGroupStart) external {
        if (msg.sender != address(this)) revert OnlySelf();
        for (uint256 i = atomicGroupStart; i < ops.length; ++i) {
            Operation calldata op = ops[i];
            (bool ok, bytes memory ret) = op.to.call{value: op.value}(op.data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    /// @notice EIP-712 digest the user must sign for a given batch.
    function hashBatch(
        Operation[] calldata ops,
        uint256 atomicGroupStart,
        uint256 batchNonce
    ) external view returns (bytes32) {
        return _hashBatch(ops, atomicGroupStart, batchNonce);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

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
            abi.encode(BATCH_TYPEHASH, keccak256(abi.encodePacked(opHashes)), atomicGroupStart, batchNonce)
        );
        return _hashTypedDataV4(structHash);
    }

    receive() external payable {}
}
