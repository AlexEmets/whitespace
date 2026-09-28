// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SystemDeployer} from "../../script/Deploy.s.sol";
import {DeployTestnetScript} from "../../script/DeployTestnet.s.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {WhitespaceVerifier} from "../../src/oracle/WhitespaceVerifier.sol";
import {WhitespacePriceUpKeep} from "../../src/oracle/WhitespacePriceUpKeep.sol";
import {OstiumTradesUpKeep} from "../../src/vendor/ostium/OstiumTradesUpKeep.sol";
import {IOstiumRegistry} from "../../src/vendor/ostium/interfaces/IOstiumRegistry.sol";
import {IOstiumPriceUpKeep} from "../../src/vendor/ostium/interfaces/IOstiumPriceUpKeep.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumAutomationCompatible} from "../../src/vendor/ostium/interfaces/IOstiumAutomationCompatible.sol";
import {ReportLib} from "./ReportLib.sol";

/// @notice The system exactly as `DeployTestnetScript.deployTestnet()` builds it for chain 1874 —
///         the entry point itself, driven through its env block, not a re-enactment of its steps.
///         A step the script forgets, or runs as the wrong role, fails here first.
abstract contract TestnetFixture is Test {
    // Role keys. The script derives gov, manager, owner and the LP from these.
    uint256 internal constant OWNER_KEY = 0x0B0E;
    uint256 internal constant GOV_KEY = 0x060F;
    uint256 internal constant MANAGER_KEY = 0x0A11;
    uint256 internal constant LP_KEY = 0x01B0;

    // N=5 report signers, k=3.
    uint256 internal constant K1 = 0xA11CE01;
    uint256 internal constant K2 = 0xA11CE02;
    uint256 internal constant K3 = 0xA11CE03;
    uint256 internal constant K4 = 0xA11CE04;
    uint256 internal constant K5 = 0xA11CE05;
    uint256 internal constant THRESHOLD = 3;

    uint256 internal constant LP_AMOUNT = 100_000e6;
    uint32 internal constant MAX_AGE = 10;
    uint16 internal constant MAX_DEVIATION_BPS = 500;

    address internal owner = vm.addr(OWNER_KEY);
    address internal gov = vm.addr(GOV_KEY);
    address internal manager = vm.addr(MANAGER_KEY);
    address internal lp = vm.addr(LP_KEY);
    address internal dev = address(0xDE7);
    address internal marketMaker = address(0x33D);
    address internal keeper = address(0x1EE);
    address internal guardian = address(0x64A);
    address internal liquidatorA = address(0x11A);
    address internal liquidatorB = address(0x11B);

    uint16 internal constant BTC = 0;
    uint16 internal constant ETH = 1;
    uint16 internal constant SOL = 2;
    uint16 internal constant WBT = 3;

    DeployTestnetScript internal script;
    SystemDeployer.Deployment internal d;
    WhitespaceVerifier internal verifier;
    WhitespacePriceUpKeep internal upkeep;
    OstiumTradesUpKeep internal tradesUpKeep;

    function _signerAddresses() internal pure returns (address[] memory s) {
        s = new address[](5);
        s[0] = vm.addr(K1);
        s[1] = vm.addr(K2);
        s[2] = vm.addr(K3);
        s[3] = vm.addr(K4);
        s[4] = vm.addr(K5);
    }

    function _join(address[] memory a) internal pure returns (string memory out) {
        for (uint256 i = 0; i < a.length; i++) {
            out = i == 0 ? vm.toString(a[i]) : string.concat(out, ",", vm.toString(a[i]));
        }
    }

    /// @dev The env block `docs/runbooks` records for a real run, with test keys.
    function _setTestnetEnv() internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(OWNER_KEY));
        vm.setEnv("GOV_PRIVATE_KEY", vm.toString(GOV_KEY));
        vm.setEnv("MANAGER_PRIVATE_KEY", vm.toString(MANAGER_KEY));
        vm.setEnv("LP_PRIVATE_KEY", vm.toString(LP_KEY));
        vm.setEnv("DEV_ADDRESS", vm.toString(dev));
        vm.setEnv("MARKET_MAKER_ADDRESS", vm.toString(marketMaker));
        vm.setEnv("ORACLE_SIGNERS", _join(_signerAddresses()));
        vm.setEnv("ORACLE_THRESHOLD", vm.toString(THRESHOLD));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));
        vm.setEnv("KEEPER_ADDRESS", vm.toString(keeper));
        address[] memory liquidators = new address[](2);
        liquidators[0] = liquidatorA;
        liquidators[1] = liquidatorB;
        vm.setEnv("LIQUIDATOR_ADDRESSES", _join(liquidators));
        vm.setEnv("LP_AMOUNT", vm.toString(LP_AMOUNT));
    }

    function _deployTestnet() internal {
        _setTestnetEnv();
        script = new DeployTestnetScript();
        d = script.deployTestnet();
        _bindDeployed();
    }

    function _bindDeployed() internal {
        IOstiumRegistry registry = IOstiumRegistry(d.registry);
        verifier = WhitespaceVerifier(registry.getContractAddress("ostiumVerifier"));
        upkeep = WhitespacePriceUpKeep(registry.getContractAddress("BTC/USDPriceUpkeep"));
        tradesUpKeep = OstiumTradesUpKeep(registry.getContractAddress("tradesUpKeep"));
    }

    // -------------------------------------------------------------------------------------
    // Prices
    // -------------------------------------------------------------------------------------

    function _feedOf(uint16 pairIndex) internal pure returns (bytes32) {
        if (pairIndex == BTC) return "BTC/USD";
        if (pairIndex == ETH) return "ETH/USD";
        if (pairIndex == SOL) return "SOL/USD";
        if (pairIndex == WBT) return "WBT/USD";
        revert("unknown pair");
    }

    /// @dev A plausible mid for each market, 18 decimals.
    function _basePrice(uint16 pairIndex) internal pure returns (int192) {
        if (pairIndex == BTC) return 65_000e18;
        if (pairIndex == ETH) return 2_500e18;
        if (pairIndex == SOL) return 150e18;
        return 20e18;
    }

    /// @dev A 3-of-5 report whose bid/ask sit one basis point either side of `price`.
    function _report(uint16 pairIndex, uint32 timestamp, int192 price) internal view returns (bytes memory) {
        int192 halfSpread = price / 10_000;
        return ReportLib.signedReport(
            ReportLib.Report({
                chainId: block.chainid,
                verifier: address(verifier),
                feedId: _feedOf(pairIndex),
                timestamp: timestamp,
                price: price,
                bid: price - halfSpread,
                ask: price + halfSpread,
                isMarketOpen: true,
                isDayTradingClosed: false
            }),
            ReportLib.keys3(K1, K2, K3)
        );
    }

    function _deliver(uint256 orderId, bytes memory report) internal {
        vm.prank(keeper);
        IOstiumPriceUpKeep(address(upkeep)).performUpkeep(abi.encode(report, orderId));
    }

    /// @dev `PriceRequestedV2(uint256 indexed orderId, OrderType, bytes32 feed, uint256 timestamp)`.
    function _lastPriceRequest() internal returns (uint256 orderId, uint32 timestamp) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.topics.length > 1 && log.topics[0] == sig) {
                orderId = uint256(log.topics[1]);
                (,, uint256 ts) = abi.decode(log.data, (uint8, bytes32, uint256));
                return (orderId, uint32(ts));
            }
        }
        revert("no PriceRequestedV2 emitted");
    }

    // -------------------------------------------------------------------------------------
    // Trading
    // -------------------------------------------------------------------------------------

    function _fundTrader(address who, uint256 amount) internal {
        vm.prank(owner); // USDW owner
        USDW(d.collateral).mint(who, amount);
        vm.prank(who);
        IERC20(d.collateral).approve(d.tradingStorage, type(uint256).max);
    }

    function _trade(address who, uint16 pairIndex, uint256 collateral, uint32 leverage, bool buy, uint8 index)
        internal
        view
        returns (IOstiumTradingStorage.Trade memory)
    {
        return IOstiumTradingStorage.Trade({
            collateral: collateral,
            openPrice: uint192(uint256(int256(_basePrice(pairIndex)))),
            tp: 0,
            sl: 0,
            trader: who,
            leverage: leverage,
            pairIndex: pairIndex,
            index: index,
            buy: buy,
            isDayTrade: false
        });
    }

    function _noBuilder() internal pure returns (IOstiumTradingStorage.BuilderFee memory) {
        return IOstiumTradingStorage.BuilderFee({builder: address(0), builderFee: 0});
    }

    /// @notice Requests a market open; returns the order to deliver a price for.
    function _requestOpen(IOstiumTradingStorage.Trade memory t, uint256 slippageP)
        internal
        returns (uint256 orderId, uint32 timestamp)
    {
        vm.recordLogs();
        vm.prank(t.trader);
        IOstiumTrading(d.trading).openTrade(t, _noBuilder(), IOstiumTradingStorage.OpenOrderType.MARKET, slippageP);
        return _lastPriceRequest();
    }

    /// @notice Opens and fills a market position at the pair's base price.
    function _open(address who, uint16 pairIndex, uint256 collateral, uint32 leverage, bool buy) internal {
        (uint256 orderId, uint32 ts) = _requestOpen(_trade(who, pairIndex, collateral, leverage, buy, 0), 100);
        _deliver(orderId, _report(pairIndex, ts, _basePrice(pairIndex)));
    }

    function _openTrade(address who, uint16 pairIndex, uint8 index)
        internal
        view
        returns (IOstiumTradingStorage.Trade memory t)
    {
        (t.collateral, t.openPrice, t.tp, t.sl, t.trader, t.leverage, t.pairIndex, t.index, t.buy, t.isDayTrade) =
            IOstiumTradingStorage(d.tradingStorage).openTrades(who, pairIndex, index);
    }

    // -------------------------------------------------------------------------------------
    // Automation
    // -------------------------------------------------------------------------------------

    function _automationPayload(
        address who,
        uint16 pairIndex,
        uint8 index,
        IOstiumTradingStorage.LimitOrder kind,
        uint256 timestamp
    ) internal pure returns (bytes memory) {
        IOstiumAutomationCompatible.SimplifiedTradeId[] memory trades =
            new IOstiumAutomationCompatible.SimplifiedTradeId[](1);
        trades[0] = IOstiumAutomationCompatible.SimplifiedTradeId({
            trader: who,
            pairId: pairIndex,
            index: index,
            limitOrder: kind
        });
        return abi.encode(trades, timestamp);
    }

    /// @notice A forwarder triggers `kind` on a position; returns the resulting price request.
    function _trigger(
        address forwarder,
        address who,
        uint16 pairIndex,
        uint8 index,
        IOstiumTradingStorage.LimitOrder kind
    ) internal returns (uint256 orderId, uint32 timestamp) {
        vm.recordLogs();
        vm.prank(forwarder);
        tradesUpKeep.performUpkeep(_automationPayload(who, pairIndex, index, kind, block.timestamp));
        return _lastPriceRequest();
    }

    /// @dev Advance blocks and time together at 1 s/block, as the OP Stack sequencer does.
    function _advance(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + blocks);
    }
}
