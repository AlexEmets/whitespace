// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {USDW} from "../src/mocks/USDW.sol";
import {OstiumRegistry} from "../src/vendor/ostium/OstiumRegistry.sol";
import {OstiumVerifier} from "../src/vendor/ostium/OstiumVerifier.sol";
import {OstiumTradingStorage} from "../src/vendor/ostium/OstiumTradingStorage.sol";
import {OstiumPairsStorage} from "../src/vendor/ostium/OstiumPairsStorage.sol";
import {OstiumPairInfos} from "../src/vendor/ostium/OstiumPairInfos.sol";
import {OstiumTrading} from "../src/vendor/ostium/OstiumTrading.sol";
import {OstiumTradingCallbacks} from "../src/vendor/ostium/OstiumTradingCallbacks.sol";
import {OstiumVault} from "../src/vendor/ostium/OstiumVault.sol";
import {OstiumOpenPnl} from "../src/vendor/ostium/OstiumOpenPnl.sol";
import {OstiumPriceRouter} from "../src/vendor/ostium/OstiumPriceRouter.sol";
import {OstiumPrivatePriceUpKeep} from "../src/vendor/ostium/OstiumPrivatePriceUpKeep.sol";
import {IOstiumRegistry} from "../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPairInfos} from "../src/vendor/ostium/interfaces/IOstiumPairInfos.sol";

/// @notice Throwaway role holder used only while a deployment is in flight.
/// @dev    `OstiumRegistry.registerContracts` is `onlyGov`, but the registry constructor
///         makes it impossible for the deploying account to be gov: `setGov`, `setDev` and
///         `setManager` all revert with `HasAlreadyRole` when the incoming address equals
///         `owner()`, and during construction `owner()` is the deployer itself
///         (`Ownable(msg.sender)`). So the deployer can never register the components.
///
///         This contract is created by the deployer, holds `gov` *and* `owner` for the few
///         transactions the wiring takes, and then hands both roles to their final holders.
///         Anchoring the authority to "whoever created me" also keeps the flow identical
///         under `forge test` (caller is the script contract) and under `vm.broadcast`
///         (caller is the broadcasting EOA), where `address(this)` is not the real sender.
contract RegistryBootstrap {
    address public immutable driver;

    error NotDriver(address caller);

    constructor() {
        driver = msg.sender;
    }

    function exec(address target, bytes memory data) external returns (bytes memory) {
        if (msg.sender != driver) revert NotDriver(msg.sender);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

contract DeployScript is Script {
    struct Deployment {
        address registry;
        address collateral;
        address tradingStorage;
        address pairsStorage;
        address pairInfos;
        address trading;
        address callbacks;
        address vault;
        address openPnl;
        address priceRouter;
        address verifier;
        address priceUpKeep;
    }

    struct Roles {
        address gov;
        address dev;
        address manager;
        address owner;
        address marketMaker;
    }

    // Initializer parameters. Values chosen for testnet; tune in phase 3.
    uint32 internal constant MAX_TS_VALIDITY = 60;          // seconds a price report stays usable
    uint256 internal constant FIRST_ORDER_ID = 1;
    uint256 internal constant LIQ_MARGIN_THRESHOLD_P = 25;  // upstream default
    uint256 internal constant MAX_NEGATIVE_PNL_ON_OPEN_P = 40;
    uint256 internal constant MAX_ALLOWED_COLLATERAL = 1_000_000e6;
    uint16 internal constant MARKET_ORDERS_TIMEOUT = 30;    // blocks
    uint16 internal constant TRIGGER_TIMEOUT = 30;          // blocks

    // OstiumVault.initialize parameters. Each bound below is enforced by the vault's
    // own require block; the values were chosen to satisfy it with headroom.
    uint256 internal constant MAX_ACC_OPEN_PNL_DELTA = 1e18;      // PRECISION_18
    uint256 internal constant MAX_DAILY_ACC_PNL_DELTA = 1e17;     // must be >= MIN 1e13
    uint16 internal constant MAX_SUPPLY_INCREASE_DAILY_P = 1000;  // 10%, must be <= 30000
    uint16 internal constant MAX_DISCOUNT_P = 1000;               // 10%, must be <= 5000
    uint16 internal constant MAX_DISCOUNT_THRESHOLD_P = 11000;    // 110%, must be > 10000
    int256 internal constant OPEN_ROLLOVER_FEE = 0;               // greenfield: no history

    function _proxy(address implementation, bytes memory initCall) internal returns (address) {
        return address(new ERC1967Proxy(implementation, initCall));
    }

    /// @notice Deploy the full system, wire the registry, and replay the migration chain.
    /// @param r Role assignments. `gov`, `dev`, `manager` and `owner` MUST be four distinct
    ///          addresses — OstiumRegistry reverts with `HasAlreadyRole` on any collision.
    function deployAll(Roles memory r) public returns (Deployment memory d) {
        require(
            r.gov != r.dev && r.gov != r.manager && r.gov != r.owner && r.dev != r.manager
                && r.dev != r.owner && r.manager != r.owner,
            "roles must be distinct"
        );

        // The bootstrap holds gov + owner until the registry is wired; see RegistryBootstrap.
        RegistryBootstrap bootstrap = new RegistryBootstrap();

        OstiumRegistry registry =
            new OstiumRegistry(address(bootstrap), r.dev, r.manager, address(bootstrap));
        d.registry = address(registry);
        IOstiumRegistry reg = IOstiumRegistry(d.registry);

        d.collateral = address(new USDW(r.owner));

        // Verifier is not upgradeable upstream: it takes the registry in its constructor.
        d.verifier = address(new OstiumVerifier(reg));

        d.tradingStorage = _proxy(
            address(new OstiumTradingStorage()),
            abi.encodeCall(OstiumTradingStorage.initialize, (reg, d.collateral))
        );
        d.pairsStorage = _proxy(
            address(new OstiumPairsStorage()),
            abi.encodeCall(OstiumPairsStorage.initialize, (reg))
        );
        d.pairInfos = _proxy(
            address(new OstiumPairInfos()),
            abi.encodeCall(
                OstiumPairInfos.initialize,
                (reg, r.manager, LIQ_MARGIN_THRESHOLD_P, MAX_NEGATIVE_PNL_ON_OPEN_P)
            )
        );
        d.callbacks = _proxy(
            address(new OstiumTradingCallbacks()),
            abi.encodeCall(OstiumTradingCallbacks.initialize, (reg))
        );
        d.openPnl = _proxy(
            address(new OstiumOpenPnl()),
            abi.encodeCall(OstiumOpenPnl.initialize, (reg))
        );
        d.priceRouter = _proxy(
            address(new OstiumPriceRouter()),
            abi.encodeCall(
                OstiumPriceRouter.initialize, (reg, MAX_TS_VALIDITY, FIRST_ORDER_ID)
            )
        );
        d.priceUpKeep = _proxy(
            address(new OstiumPrivatePriceUpKeep()),
            abi.encodeCall(OstiumPrivatePriceUpKeep.initialize, (reg))
        );
        d.trading = _proxy(
            address(new OstiumTrading()),
            abi.encodeCall(
                OstiumTrading.initialize,
                (reg, MAX_ALLOWED_COLLATERAL, MARKET_ORDERS_TIMEOUT, TRIGGER_TIMEOUT)
            )
        );

        // Vault: note _asset comes FIRST and _registry second, and the parameter list
        // is eight items long. Verified against src/vendor/ostium/OstiumVault.sol:109.
        uint16[2] memory withdrawLockThresholdsP = [uint16(10), uint16(20)];
        d.vault = _proxy(
            address(new OstiumVault()),
            abi.encodeCall(
                OstiumVault.initialize,
                (
                    d.collateral,
                    d.registry,
                    MAX_ACC_OPEN_PNL_DELTA,
                    MAX_DAILY_ACC_PNL_DELTA,
                    MAX_SUPPLY_INCREASE_DAILY_P,
                    MAX_DISCOUNT_P,
                    MAX_DISCOUNT_THRESHOLD_P,
                    withdrawLockThresholdsP
                )
            )
        );

        bytes32[] memory names = new bytes32[](9);
        address[] memory addrs = new address[](9);
        names[0] = "tradingStorage";  addrs[0] = d.tradingStorage;
        names[1] = "pairsStorage";    addrs[1] = d.pairsStorage;
        names[2] = "pairInfos";       addrs[2] = d.pairInfos;
        names[3] = "trading";         addrs[3] = d.trading;
        names[4] = "callbacks";       addrs[4] = d.callbacks;
        names[5] = "vault";           addrs[5] = d.vault;
        names[6] = "openPnl";         addrs[6] = d.openPnl;
        names[7] = "priceRouter";     addrs[7] = d.priceRouter;
        names[8] = "ostiumVerifier";  addrs[8] = d.verifier;

        // Registration runs as gov, then the bootstrap relinquishes both of its roles.
        // Order matters: `setGov` is `onlyOwner`, so it must precede the ownership handover.
        bootstrap.exec(d.registry, abi.encodeCall(IOstiumRegistry.registerContracts, (names, addrs)));
        bootstrap.exec(d.registry, abi.encodeCall(IOstiumRegistry.setGov, (r.gov)));
        bootstrap.exec(d.registry, abi.encodeCall(Ownable.transferOwnership, (r.owner)));

        _replayMigrations(d, r.marketMaker);
    }

    /// @dev Upstream evolved a live system, so part of its state is set only by
    ///      `reinitializer(n)` functions. OZ v5 requires `_initialized < n`, which means
    ///      calling V4 first would silently skip V2 and V3 forever. Call them in ascending
    ///      order. All array arguments are empty: a greenfield deployment has no markets.
    function _replayMigrations(Deployment memory d, address marketMaker) internal {
        uint16[] memory noPairs = new uint16[](0);
        uint32[] memory noLeverages = new uint32[](0);
        uint256[] memory noUints = new uint256[](0);
        int256[] memory noInts = new int256[](0);
        IOstiumPairInfos.PairFundingFeesV2[] memory noFees =
            new IOstiumPairInfos.PairFundingFeesV2[](0);

        OstiumPairsStorage(d.pairsStorage).initializeV2(noPairs, noLeverages);

        OstiumOpenPnl(d.openPnl).initializeV2(OPEN_ROLLOVER_FEE, noPairs, noUints, noUints);

        OstiumPairInfos(d.pairInfos).initializeV2(noFees);
        OstiumPairInfos(d.pairInfos).initializeV3(
            LIQ_MARGIN_THRESHOLD_P, MAX_NEGATIVE_PNL_ON_OPEN_P
        );
        OstiumPairInfos(d.pairInfos).initializeV4(noPairs, noInts, noUints);

        OstiumVault(d.vault).initializeV2();
        OstiumVault(d.vault).initializeV3();
        OstiumVault(d.vault).initializeV4(marketMaker);
    }

    function run() external returns (Deployment memory) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        vm.startBroadcast(pk);
        Deployment memory d = deployAll(
            Roles({
                gov: vm.envAddress("GOV_ADDRESS"),
                dev: vm.envAddress("DEV_ADDRESS"),
                manager: vm.envAddress("MANAGER_ADDRESS"),
                owner: owner,
                marketMaker: vm.envAddress("MARKET_MAKER_ADDRESS")
            })
        );
        vm.stopBroadcast();
        return d;
    }
}
