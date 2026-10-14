// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Hunter} from "../src/nft/Hunter.sol";

/// @notice Deploys the {Hunter} bug-bounty collection and seeds a wallet with the first badges.
///
/// @dev Whitechain (1874/1875) needs `--legacy`. Keys follow the repo convention
///      (`~/.whitespace-keys/`, see docs/runbooks/redeploy-testnet-1874.md):
///
///        export DEPLOYER_PRIVATE_KEY=$(key owner)
///        forge script script/DeployHunter.s.sol:DeployHunterScript \
///          --rpc-url https://rpc.testnet.whitechain.io --broadcast --legacy --slow \
///          --sender "$(addr owner)" -vvv
///
///      Optional env:
///        HUNTER_MINT_TO       recipient of the initial mint (default: the deployer)
///        HUNTER_INITIAL_MINT  how many to mint now        (default: 5)
contract DeployHunterScript is Script {
    function run() external returns (Hunter hunter) {
        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(ownerKey);
        address mintTo = vm.envOr("HUNTER_MINT_TO", owner);
        uint256 initial = vm.envOr("HUNTER_INITIAL_MINT", uint256(5));

        vm.startBroadcast(ownerKey);
        hunter = new Hunter(owner);
        if (initial > 0) {
            hunter.mintBatch(mintTo, initial);
        }
        vm.stopBroadcast();

        console2.log("Hunter deployed:", address(hunter));
        console2.log("owner:", owner);
        console2.log("minted:", initial);
        console2.log("to:", mintTo);
    }
}
