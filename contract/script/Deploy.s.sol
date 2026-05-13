// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {GaslessDelegate} from "../src/GaslessDelegate.sol";

/// @notice Single-chain deployer. Invoked by deploy.sh once per supported chain
/// id. Reads the operator key from `OPERATOR_PRIVATE_KEY` (raw uint256) or
/// derives one from `OPERATOR_MNEMONIC` (+ optional `OPERATOR_MNEMONIC_INDEX`).
/// The deployed address is logged to stdout in a parseable form so the shell
/// wrapper can merge it into `gasless/chains/deployed.json`.
contract DeployGaslessDelegate is Script {
    function run() external {
        uint256 deployerKey = _loadDeployerKey();
        address deployer = vm.addr(deployerKey);

        console.log("chain id    :", block.chainid);
        console.log("deployer    :", deployer);
        console.log("balance wei :", deployer.balance);

        vm.startBroadcast(deployerKey);
        GaslessDelegate impl = new GaslessDelegate();
        vm.stopBroadcast();

        console.log("deployed at :", address(impl));
        console.log(string.concat("DEPLOYED_ADDRESS=", vm.toString(address(impl))));
        console.log(string.concat("DEPLOYED_CHAIN_ID=", vm.toString(block.chainid)));
    }

    function _loadDeployerKey() internal view returns (uint256) {
        uint256 raw = vm.envOr("OPERATOR_PRIVATE_KEY", uint256(0));
        if (raw != 0) {
            return raw;
        }
        string memory mnemonic = vm.envString("OPERATOR_MNEMONIC");
        uint32 index = uint32(vm.envOr("OPERATOR_MNEMONIC_INDEX", uint256(0)));
        return vm.deriveKey(mnemonic, index);
    }
}
