// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {GaslessDelegate} from "../src/GaslessDelegate.sol";
import {GASLESS_DELEGATE_SALT, GASLESS_DELEGATE_INIT_CODE_HASH, GASLESS_DELEGATE_ADDRESS} from "./GaslessDelegateAddress.sol";

/// @notice Deterministic single-chain deployer. Invoked by deploy.sh once per
/// supported chain id. Deploys GaslessDelegate via CREATE2 with a frozen salt
/// through the canonical CREATE2 factory, so the contract lands at
/// GASLESS_DELEGATE_ADDRESS on every EVM chain. It refuses to broadcast if the
/// compiled init code drifts from the frozen hash, and no-ops if the code is
/// already present. Key from OPERATOR_PRIVATE_KEY or OPERATOR_MNEMONIC.
contract DeployGaslessDelegate is Script {
    function run() external {
        uint256 deployerKey = _loadDeployerKey();
        address deployer = vm.addr(deployerKey);
        bytes32 initCodeHash = keccak256(type(GaslessDelegate).creationCode);
        address predicted = vm.computeCreate2Address(GASLESS_DELEGATE_SALT, initCodeHash);

        console.log("chain id      :", block.chainid);
        console.log("deployer      :", deployer);
        console.log("balance wei   :", deployer.balance);
        console.log("predicted     :", predicted);

        require(initCodeHash == GASLESS_DELEGATE_INIT_CODE_HASH, "init code drifted; address would fork");
        require(predicted == GASLESS_DELEGATE_ADDRESS, "predicted address drifted from frozen value");

        if (predicted.code.length > 0) {
            console.log("already deployed at canonical address; skipping broadcast");
            _report(predicted);
            return;
        }

        vm.startBroadcast(deployerKey);
        GaslessDelegate impl = new GaslessDelegate{salt: GASLESS_DELEGATE_SALT}();
        vm.stopBroadcast();

        require(address(impl) == predicted, "CREATE2 address mismatch");
        _report(address(impl));
    }

    function _report(address deployed) internal view {
        console.log("deployed at   :", deployed);
        console.log(string.concat("DEPLOYED_ADDRESS=", vm.toString(deployed)));
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
