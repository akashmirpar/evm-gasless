// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Frozen deployment identity for GaslessDelegate. These three values are the
// contract of RIN-213: as long as the salt and the init-code hash are frozen,
// CREATE2 through the canonical factory yields GASLESS_DELEGATE_ADDRESS on every
// EVM chain. Deploy.s.sol refuses to broadcast if the compiled init code no
// longer hashes to GASLESS_DELEGATE_INIT_CODE_HASH, so a dependency, compiler,
// or source change can never silently mint a divergent address.
//
// Values are for OZ 5.6.1 / solc 0.8.27 / optimizer runs 200 / evm prague /
// bytecode_hash none. Changing any of them (or the salt) forks the address and
// must be a deliberate, reviewed decision, not an accident.
bytes32 constant GASLESS_DELEGATE_SALT = keccak256("pluton.gasless.GaslessDelegate.v1");
bytes32 constant GASLESS_DELEGATE_INIT_CODE_HASH = 0x7fe104f2bb4e73a8a50dd4f86950cddc877f3b43ee8809517f9af26e5f837e60;
address constant GASLESS_DELEGATE_ADDRESS = 0x2e80ca7db998b5e77B7714C5Ca71FEC26699b8fe;
