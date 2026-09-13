// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {GaslessDelegate} from "../src/GaslessDelegate.sol";
import {GASLESS_DELEGATE_SALT, GASLESS_DELEGATE_INIT_CODE_HASH, GASLESS_DELEGATE_ADDRESS} from "../script/GaslessDelegateAddress.sol";

contract Recipient {
    uint256 public hits;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function ping() external payable {
        if (shouldRevert) revert("recipient-fail");
        ++hits;
    }

    receive() external payable {}
}

contract GaslessDelegateTest is Test {
    GaslessDelegate impl;
    address treasury = makeAddr("treasury");

    Recipient r1;
    Recipient r2;
    Recipient r3;

    address user;
    uint256 userPk;

    function setUp() public {
        impl = new GaslessDelegate();
        (user, userPk) = makeAddrAndKey("user");
        r1 = new Recipient();
        r2 = new Recipient();
        r3 = new Recipient();

        // Simulate EIP-7702 delegation: install impl's runtime code at user.
        vm.etch(user, address(impl).code);
        vm.deal(user, 100 ether);
    }

    function _delegated() internal view returns (GaslessDelegate) {
        return GaslessDelegate(payable(user));
    }

    function _sign(GaslessDelegate.Operation[] memory ops, uint256 atomicGroupStart, uint256 nonce_)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = _delegated().hashBatch(ops, atomicGroupStart, nonce_);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _treasuryOp(uint256 value_) internal view returns (GaslessDelegate.Operation memory) {
        return GaslessDelegate.Operation({to: treasury, value: value_, data: ""});
    }

    function _pingOp(Recipient r, uint256 value_) internal pure returns (GaslessDelegate.Operation memory) {
        return GaslessDelegate.Operation({to: address(r), value: value_, data: abi.encodeWithSignature("ping()")});
    }

    // ------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------

    function test_happyPath_treasuryAndAtomic() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](3);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 1 ether);
        ops[2] = _pingOp(r2, 0);

        bytes memory sig = _sign(ops, 1, 0);

        _delegated().executeBatch(ops, 1, 0, sig);

        assertEq(treasury.balance, 0.1 ether, "treasury paid");
        assertEq(address(r1).balance, 1 ether);
        assertEq(r1.hits(), 1);
        assertEq(r2.hits(), 1);
        assertEq(_delegated().nonce(), 1);
    }

    function test_singleOp_treasuryOnly() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.5 ether);
        bytes memory sig = _sign(ops, 1, 0);

        _delegated().executeBatch(ops, 1, 0, sig);

        assertEq(treasury.balance, 0.5 ether);
        assertEq(_delegated().nonce(), 1);
    }

    function test_anyoneCanSubmit() public {
        address randomSubmitter = makeAddr("randomSubmitter");

        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 0);
        bytes memory sig = _sign(ops, 1, 0);

        vm.prank(randomSubmitter);
        _delegated().executeBatch(ops, 1, 0, sig);

        assertEq(treasury.balance, 0.1 ether, "treasury paid the signed amount");
        assertEq(randomSubmitter.balance, 0, "submitter received nothing");
        assertEq(r1.hits(), 1);
        assertEq(_delegated().nonce(), 1);
    }

    // ------------------------------------------------------------
    // Must-succeed zone semantics (atomicGroupStart > 1)
    // ------------------------------------------------------------

    function test_multipleMustSucceedOps() public {
        // ops[0..1] are must-succeed (treasury + secondary fee op), ops[2] atomic.
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](3);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 0);
        ops[2] = _pingOp(r2, 0);
        bytes memory sig = _sign(ops, 2, 0);

        _delegated().executeBatch(ops, 2, 0, sig);

        assertEq(treasury.balance, 0.1 ether);
        assertEq(r1.hits(), 1, "must-succeed op 1 ran");
        assertEq(r2.hits(), 1, "atomic op ran");
        assertEq(_delegated().nonce(), 1);
    }

    function test_mustSucceedZoneReverts_wholeTxReverts() public {
        // ops[0] succeeds, ops[1] (also in must-succeed zone) fails → whole tx reverts.
        r2.setShouldRevert(true);

        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](3);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r2, 0); // reverts
        ops[2] = _pingOp(r1, 0); // atomic op, never runs
        bytes memory sig = _sign(ops, 2, 0);

        vm.expectRevert(bytes("recipient-fail"));
        _delegated().executeBatch(ops, 2, 0, sig);

        assertEq(_delegated().nonce(), 0, "nonce unchanged on revert");
        assertEq(treasury.balance, 0, "treasury rolled back");
    }

    function test_allMustSucceedNoAtomic() public {
        // atomicGroupStart == ops.length → entire batch is must-succeed, no atomic group.
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 0);
        bytes memory sig = _sign(ops, 2, 0);

        _delegated().executeBatch(ops, 2, 0, sig);

        assertEq(treasury.balance, 0.1 ether);
        assertEq(r1.hits(), 1);
    }

    function test_allAtomicNoMustSucceed() public {
        // atomicGroupStart == 0 → entire batch is atomic. No must-succeed payment.
        // A failure unwinds the atomic group only, nonce still advances.
        r2.setShouldRevert(true);

        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _pingOp(r1, 0);
        ops[1] = _pingOp(r2, 0); // reverts
        bytes memory sig = _sign(ops, 0, 0);

        _delegated().executeBatch(ops, 0, 0, sig);

        assertEq(r1.hits(), 0, "r1 rolled back with the atomic group");
        assertEq(_delegated().nonce(), 1, "nonce advances even when atomic group fails");
    }

    // ------------------------------------------------------------
    // Atomic semantics (atomic group rollback does not affect must-succeed zone)
    // ------------------------------------------------------------

    function test_atomicReverts_mustSucceedZoneStillExecutes() public {
        r2.setShouldRevert(true);

        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](3);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 1 ether); // atomic; would succeed alone
        ops[2] = _pingOp(r2, 0); // atomic; reverts → drags r1 down

        bytes memory sig = _sign(ops, 1, 0);

        _delegated().executeBatch(ops, 1, 0, sig);

        assertEq(treasury.balance, 0.1 ether, "treasury paid");
        assertEq(r1.hits(), 0, "r1 rolled back");
        assertEq(address(r1).balance, 0, "r1 funds rolled back");
        assertEq(r2.hits(), 0);
        assertEq(_delegated().nonce(), 1, "nonce still consumed");
    }

    function test_feeSwapPattern_mustSucceedZoneIsApproveSwapTreasury() public {
        // Simulates the unsupported-fee-token flow:
        // ops[0] = approve (must succeed)
        // ops[1] = swap to treasury (must succeed)
        // ops[2..] = user's actual intent (atomic)
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](4);
        ops[0] = _pingOp(r1, 0); // stand-in for ERC20.approve
        ops[1] = _treasuryOp(0.05 ether); // stand-in for rango swap → treasury
        ops[2] = _pingOp(r2, 1 ether);
        ops[3] = _pingOp(r3, 0);
        bytes memory sig = _sign(ops, 2, 0);

        _delegated().executeBatch(ops, 2, 0, sig);

        assertEq(r1.hits(), 1, "approve ran");
        assertEq(treasury.balance, 0.05 ether, "treasury received swap output");
        assertEq(r2.hits(), 1, "user intent op 1 ran");
        assertEq(r3.hits(), 1, "user intent op 2 ran");
    }

    // ------------------------------------------------------------
    // Signature + nonce
    // ------------------------------------------------------------

    function test_revert_invalidSignature_wrongKey() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.1 ether);

        (, uint256 wrongPk) = makeAddrAndKey("not-user");
        bytes32 digest = _delegated().hashBatch(ops, 1, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(GaslessDelegate.InvalidSignature.selector);
        _delegated().executeBatch(ops, 1, 0, sig);
    }

    function test_revert_invalidSignature_tamperedOps() public {
        GaslessDelegate.Operation[] memory signedOps = new GaslessDelegate.Operation[](1);
        signedOps[0] = _treasuryOp(0.1 ether);
        bytes memory sig = _sign(signedOps, 1, 0);

        GaslessDelegate.Operation[] memory tamperedOps = new GaslessDelegate.Operation[](1);
        tamperedOps[0] = _treasuryOp(0.5 ether);

        vm.expectRevert(GaslessDelegate.InvalidSignature.selector);
        _delegated().executeBatch(tamperedOps, 1, 0, sig);
    }

    function test_revert_invalidSignature_tamperedAtomicGroupStart() public {
        // Signature commits to atomicGroupStart; changing it must invalidate the signature.
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 0);
        bytes memory sig = _sign(ops, 1, 0);

        // Submitter tries to move the atomic boundary so r1 falls in the must-succeed zone.
        vm.expectRevert(GaslessDelegate.InvalidSignature.selector);
        _delegated().executeBatch(ops, 2, 0, sig);
    }

    function test_revert_invalidNonce() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.1 ether);
        bytes memory sig = _sign(ops, 1, 5);

        vm.expectRevert(abi.encodeWithSelector(GaslessDelegate.InvalidNonce.selector, 0, 5));
        _delegated().executeBatch(ops, 1, 5, sig);
    }

    function test_revert_emptyBatch() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](0);

        vm.expectRevert(GaslessDelegate.EmptyBatch.selector);
        _delegated().executeBatch(ops, 0, 0, hex"");
    }

    function test_revert_atomicGroupStartOutOfRange() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _treasuryOp(0.1 ether);
        ops[1] = _pingOp(r1, 0);

        // No signature needed — the bounds check runs before signature verification.
        vm.expectRevert(abi.encodeWithSelector(GaslessDelegate.InvalidAtomicGroupStart.selector, 3, 2));
        _delegated().executeBatch(ops, 3, 0, hex"");
    }

    function test_replay_rejected() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.1 ether);
        bytes memory sig = _sign(ops, 1, 0);

        _delegated().executeBatch(ops, 1, 0, sig);

        vm.expectRevert(abi.encodeWithSelector(GaslessDelegate.InvalidNonce.selector, 1, 0));
        _delegated().executeBatch(ops, 1, 0, sig);
    }

    function test_revert_executeAtomic_external() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](2);
        ops[0] = _treasuryOp(0);
        ops[1] = _pingOp(r1, 0);

        vm.expectRevert(GaslessDelegate.OnlySelf.selector);
        _delegated()._executeAtomic(ops, 1);
    }

    // ------------------------------------------------------------
    // Storage layout the backend depends on
    // ------------------------------------------------------------

    // backend/src/modules/evm/services/delegate_state.service.ts reads the batch
    // nonce straight from slot 2 of the delegated EOA, so it survives moving the
    // EOA between delegate addresses. Moving `nonce` breaks that silently.
    function test_nonceStorageSlotIsPinned() public {
        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.1 ether);
        _delegated().executeBatch(ops, 1, 0, _sign(ops, 1, 0));

        assertEq(uint256(vm.load(user, bytes32(uint256(2)))), 1, "nonce is not at slot 2");
        assertEq(_delegated().nonce(), 1);
    }

    // ------------------------------------------------------------
    // Domain isolation
    // ------------------------------------------------------------

    function test_signatureCannotCrossEOAs() public {
        (address user2, uint256 user2Pk) = makeAddrAndKey("user2");
        vm.etch(user2, address(impl).code);
        vm.deal(user2, 10 ether);

        GaslessDelegate.Operation[] memory ops = new GaslessDelegate.Operation[](1);
        ops[0] = _treasuryOp(0.1 ether);

        bytes32 digestForUser2 = GaslessDelegate(payable(user2)).hashBatch(ops, 1, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user2Pk, digestForUser2);
        bytes memory user2Sig = abi.encodePacked(r, s, v);

        vm.expectRevert(GaslessDelegate.InvalidSignature.selector);
        _delegated().executeBatch(ops, 1, 0, user2Sig);
    }
}

contract GaslessDelegateCreate2Test is Test {
    // The frozen init-code hash IS the canonical address: this fails the moment a
    // dependency, compiler flag, or source edit changes the compiled creation
    // code, catching an address fork in CI before anyone reaches a deploy.
    function test_initCodeHashMatchesFrozenValue() public {
        assertEq(keccak256(type(GaslessDelegate).creationCode), GASLESS_DELEGATE_INIT_CODE_HASH);
    }

    // GASLESS_DELEGATE_ADDRESS is exactly the address the canonical CREATE2
    // factory (0x4e59...4956C, the deployer vm.computeCreate2Address assumes)
    // yields for this salt + init code — so any chain deployed through the script
    // lands here. Freezing it makes an accidental fork a failing test, not a
    // surprise on the next chain.
    function test_canonicalAddressMatchesFrozenValue() public {
        assertEq(vm.computeCreate2Address(GASLESS_DELEGATE_SALT, GASLESS_DELEGATE_INIT_CODE_HASH), GASLESS_DELEGATE_ADDRESS);
    }
}
