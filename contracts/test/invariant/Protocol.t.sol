// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm, console2} from "forge-std/Test.sol";

import {TestnetTrading} from "../helpers/TestnetTrading.sol";
import {SystemDeployer} from "../../script/Deploy.s.sol";
import {USDW} from "../../src/mocks/USDW.sol";
import {IOstiumVault} from "../../src/vendor/ostium/interfaces/IOstiumVault.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

/// @notice Drives random sequences of every user, keeper, liquidator and LP action against the
///         testnet deployment. Every contract call is wrapped so a revert is an outcome, not a
///         handler failure; prices only ever move inside the oracle's 5% deviation rail and are
///         delivered as fresh 3-of-5 signed reports.
contract ProtocolHandler is TestnetTrading {
    IOstiumTradingStorage.OpenOrderType internal constant MARKET = IOstiumTradingStorage.OpenOrderType.MARKET;

    address[4] internal traderSet = [address(0xA001), address(0xA002), address(0xA003), address(0xA004)];
    address internal lp2 = address(0x1B2);

    /// @dev The price the next report for a pair will carry. Always within 4.5% of the feed's
    ///      last accepted price, so every delivery clears the 5% rail.
    mapping(uint16 => int192) public px;

    struct Pending {
        uint16 pair;
        uint32 ts;
        address trader;
        bool open;
        bool buy;
    }

    mapping(uint256 => Pending) internal pending;
    uint256[] internal pendingIds;

    mapping(address => uint32[]) internal lpRequestIds;
    mapping(address => mapping(uint32 => bool)) internal lpRequested;

    /// @dev Invariant (c): set if any successful open ever left OI above the pair's cap.
    bool public oiBreached;
    uint256 public oiBreachPair;
    uint256 public oiBreachValue;
    uint256 public oiBreachMax;

    mapping(bytes32 => uint256) public calls;
    uint256 public totalCalls;

    constructor(SystemDeployer.Deployment memory deployment) {
        d = deployment;
        _bindDeployed();
        _bindTestnet();
        for (uint256 i = 0; i < traderSet.length; i++) {
            _fundTrader(traderSet[i], 1_000_000e6);
        }
        vm.prank(owner);
        USDW(d.collateral).mint(lp2, 200_000e6);
        vm.prank(lp2);
        usdw.approve(d.vault, type(uint256).max);
        for (uint16 p = 0; p < 4; p++) {
            px[p] = _basePrice(p);
        }
    }

    // -------------------------------------------------------------------------------------
    // Views for the invariants
    // -------------------------------------------------------------------------------------

    function traders() external view returns (address[4] memory) {
        return traderSet;
    }

    function lps() public view returns (address[2] memory) {
        return [lp, lp2];
    }

    function requestIdsOf(address who) external view returns (uint32[] memory) {
        return lpRequestIds[who];
    }

    // -------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------

    function _count(bytes32 what) internal {
        calls[what]++;
        totalCalls++;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return traderSet[seed % traderSet.length];
    }

    function _pairOf(uint256 seed) internal pure returns (uint16) {
        return uint16(seed % 4);
    }

    function _lastRequestOrZero() internal returns (uint256 orderId, uint32 timestamp) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PriceRequestedV2(uint256,uint8,bytes32,uint256)");
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.topics.length > 1 && log.topics[0] == sig) {
                orderId = uint256(log.topics[1]);
                (,, uint256 t) = abi.decode(log.data, (uint8, bytes32, uint256));
                return (orderId, uint32(t));
            }
        }
    }

    function _tryDeliver(uint256 orderId, uint16 pair, uint32 t) internal returns (bool ok) {
        bytes memory report = this.signedReportExt(pair, t, px[pair], true);
        vm.prank(keeper);
        try upkeep.performUpkeep(abi.encode(report, orderId)) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// @dev Delivers and, if the delivery raised the side's OI, checks the cap at the price the
    ///      open was accepted at (invariant c).
    function _deliverOpenChecked(uint256 orderId, uint16 pair, uint32 t, bool buy) internal returns (bool ok) {
        uint256 oiBefore = ts.openInterest(pair, buy ? 0 : 1);
        ok = _tryDeliver(orderId, pair, t);
        uint256 oiAfter = ts.openInterest(pair, buy ? 0 : 1);
        if (ok && oiAfter > oiBefore) {
            uint256 value = oiAfter * uint256(int256(px[pair])) / 1e18 / 1e12;
            uint256 cap = ts.openInterest(pair, 2);
            if (value > cap && !oiBreached) {
                oiBreached = true;
                oiBreachPair = pair;
                oiBreachValue = value;
                oiBreachMax = cap;
            }
        }
    }

    function _removePending(uint256 i) internal {
        delete pending[pendingIds[i]];
        pendingIds[i] = pendingIds[pendingIds.length - 1];
        pendingIds.pop();
    }

    uint256 internal constant SLOTS = 160; // 4 traders x 4 pairs x 10 indices

    function _slot(uint256 s) internal view returns (address t, uint16 pair, uint8 i) {
        s = s % SLOTS;
        return (traderSet[s / 40], uint16((s / 10) % 4), uint8(s % 10));
    }

    /// @dev The first open position at or after the seed-chosen (trader, pair, index) slot, so
    ///      a random seed nearly always acts on a position that exists. Leverage 0 if none.
    function _tradeAt(address t, uint16 pair, uint8 idx) internal view returns (IOstiumTradingStorage.Trade memory tr) {
        uint256 a;
        while (a < 3 && traderSet[a] != t) a++;
        uint256 start = a * 40 + uint256(pair) * 10 + idx;
        for (uint256 k = 0; k < SLOTS; k++) {
            (address who, uint16 p, uint8 i) = _slot(start + k);
            tr = ts.getOpenTrade(who, p, i);
            if (tr.leverage != 0) return tr;
        }
    }

    /// @dev Same scan over resting limit/stop orders.
    function _findOrder(uint256 a, uint256 p, uint256 idx)
        internal
        view
        returns (address t, uint16 pair, uint8 i, bool found)
    {
        uint256 start = (a % 4) * 40 + (p % 4) * 10 + idx % 10;
        for (uint256 k = 0; k < SLOTS; k++) {
            (t, pair, i) = _slot(start + k);
            if (ts.hasOpenLimitOrder(t, pair, i)) return (t, pair, i, true);
        }
    }

    // -------------------------------------------------------------------------------------
    // Trader actions
    // -------------------------------------------------------------------------------------

    /// @dev A trade on `pair` at the handler's price, collateral and leverage bounded to the pair.
    function _boundedTrade(uint256 a, uint16 pair, uint256 coll, uint256 lev, bool buy)
        internal
        view
        returns (IOstiumTradingStorage.Trade memory t)
    {
        t = _tradeFull(
            _actor(a),
            pair,
            bound(coll, 20e6, 3_000e6),
            uint32(bound(lev, 100, ps.pairMaxLeverage(pair))),
            buy,
            uint192(uint256(int256(px[pair]))),
            0,
            0
        );
    }

    function openMarket(uint256 a, uint256 p, uint256 coll, uint256 lev, bool buy, bool deliverNow) external {
        _openMarket(_boundedTrade(a, _pairOf(p), coll, lev, buy), deliverNow);
    }

    function _openMarket(IOstiumTradingStorage.Trade memory tr, bool deliverNow) internal {
        vm.recordLogs();
        vm.prank(tr.trader);
        try trading.openTrade(tr, _noBuilder(), MARKET, 200) {} catch {
            return;
        }
        _count("openMarket");
        (uint256 id, uint32 ts_) = _lastRequestOrZero();
        pending[id] = Pending(tr.pairIndex, ts_, tr.trader, true, tr.buy);
        pendingIds.push(id);
        if (deliverNow && _deliverOpenChecked(id, tr.pairIndex, ts_, tr.buy)) _removePending(pendingIds.length - 1);
    }

    function placeOrder(uint256 a, uint256 p, uint256 coll, uint256 lev, bool buy, bool stop, uint256 offsetBps)
        external
    {
        IOstiumTradingStorage.Trade memory tr = _boundedTrade(a, _pairOf(p), coll, lev, buy);
        tr.openPrice = _restingTarget(tr.openPrice, buy, stop, bound(offsetBps, 0, 300));
        _placeOrder(tr, stop ? IOstiumTradingStorage.OpenOrderType.STOP : IOstiumTradingStorage.OpenOrderType.LIMIT);
    }

    /// @dev A limit rests on the favourable side of the price, a stop on the unfavourable one.
    function _restingTarget(uint192 price, bool buy, bool stop, uint256 offsetBps) internal pure returns (uint192) {
        uint256 m = buy == stop ? 10_000 + offsetBps : 10_000 - offsetBps;
        return uint192(uint256(price) * m / 10_000);
    }

    function _placeOrder(IOstiumTradingStorage.Trade memory tr, IOstiumTradingStorage.OpenOrderType kind) internal {
        vm.prank(tr.trader);
        try trading.openTrade(tr, _noBuilder(), kind, 0) {
            _count("placeOrder");
        } catch {}
    }

    function cancelOrder(uint256 a, uint256 p, uint256 idx) external {
        (address t, uint16 pair, uint8 i, bool found) = _findOrder(a, p, idx);
        if (!found) return;
        vm.prank(t);
        try trading.cancelOpenLimitOrder(pair, i) {
            _count("cancelOrder");
        } catch {}
    }

    function updateOrder(uint256 a, uint256 p, uint256 idx, uint256 offsetBps) external {
        (address t, uint16 pair, uint8 i, bool found) = _findOrder(a, p, idx);
        if (!found) return;
        offsetBps = bound(offsetBps, 0, 300);
        uint192 target = uint192(uint256(int256(px[pair]) * int256(10_000 - offsetBps) / 10_000));
        vm.prank(t);
        try trading.updateOpenLimitOrder(pair, i, target, 0, 0) {
            _count("updateOrder");
        } catch {}
    }

    function triggerOrder(uint256 a, uint256 p, uint256 idx, bool useB) external {
        (address t, uint16 pair, uint8 i, bool found) = _findOrder(a, p, idx);
        if (!found) return;
        bool buy = ts.getOpenLimitOrder(t, pair, i).buy;
        bytes memory payload =
            _automationPayload(t, pair, i, IOstiumTradingStorage.LimitOrder.OPEN, vm.getBlockTimestamp());
        vm.recordLogs();
        vm.prank(useB ? liquidatorB : liquidatorA);
        try tradesUpKeep.performUpkeep(payload) {} catch {
            return;
        }
        (uint256 id, uint32 ts_) = _lastRequestOrZero();
        if (id == 0) return;
        _count("triggerOrder");
        _deliverOpenChecked(id, pair, ts_, buy);
    }

    function closeMarket(uint256 a, uint256 p, uint256 idx, uint256 pct, bool deliverNow) external {
        IOstiumTradingStorage.Trade memory tr = _tradeAt(_actor(a), _pairOf(p), uint8(idx % 10));
        if (tr.leverage == 0) return;
        _close(tr, pct % 3 == 0 ? uint16(0) : uint16(bound(pct, 1_000, 9_000)), deliverNow);
    }

    function _close(IOstiumTradingStorage.Trade memory tr, uint16 pc, bool deliverNow) internal {
        vm.recordLogs();
        vm.prank(tr.trader);
        try trading.closeTradeMarket(tr.pairIndex, tr.index, pc, uint192(uint256(int256(px[tr.pairIndex]))), 500) {}
        catch {
            return;
        }
        _count("closeMarket");
        (uint256 id, uint32 ts_) = _lastRequestOrZero();
        pending[id] = Pending(tr.pairIndex, ts_, tr.trader, false, false);
        pendingIds.push(id);
        if (deliverNow && _tryDeliver(id, tr.pairIndex, ts_)) _removePending(pendingIds.length - 1);
    }

    /// @notice Delivers a pending market order while fresh, or reclaims it once timed out.
    function settlePending(uint256 seed) external {
        if (pendingIds.length == 0) return;
        uint256 i = seed % pendingIds.length;
        uint256 id = pendingIds[i];
        Pending memory o = pending[id];
        (uint256 orderBlock,,,,) = ts.reqID_pendingMarketOrder(id);
        if (orderBlock == 0) {
            _removePending(i); // resolved elsewhere
            return;
        }
        if (vm.getBlockTimestamp() <= uint256(o.ts) + MAX_AGE) {
            bool ok = o.open ? _deliverOpenChecked(id, o.pair, o.ts, o.buy) : _tryDeliver(id, o.pair, o.ts);
            if (ok) {
                _count("deliverPending");
                _removePending(i);
            }
            return;
        }
        if (vm.getBlockNumber() < orderBlock + MARKET_TIMEOUT) return;
        vm.prank(o.trader);
        if (o.open) {
            try trading.openTradeMarketTimeout(id) {
                _count("openTimeout");
                _removePending(i);
            } catch {}
        } else {
            try trading.closeTradeMarketTimeout(id, false) {
                _count("closeTimeout");
                _removePending(i);
            } catch {}
        }
    }

    function _shift(uint256 price, uint256 bps, bool up) internal pure returns (uint192) {
        return uint192(up ? price * (10_000 + bps) / 10_000 : price * (10_000 - bps) / 10_000);
    }

    function updateTpSl(uint256 a, uint256 p, uint256 idx, uint256 tpBps, uint256 slBps) external {
        IOstiumTradingStorage.Trade memory tr = _tradeAt(_actor(a), _pairOf(p), uint8(idx % 10));
        if (tr.leverage == 0) return;
        slBps = bound(slBps, 0, 2_000);
        _setTpSl(
            tr,
            _shift(tr.openPrice, bound(tpBps, 1, 2_000), tr.buy),
            slBps == 0 ? uint192(0) : _shift(tr.openPrice, slBps, !tr.buy)
        );
    }

    function _setTpSl(IOstiumTradingStorage.Trade memory tr, uint192 tp, uint192 sl) internal {
        vm.startPrank(tr.trader);
        try trading.updateTp(tr.pairIndex, tr.index, tp) {
            _count("updateTp");
        } catch {}
        try trading.updateSl(tr.pairIndex, tr.index, sl) {
            _count("updateSl");
        } catch {}
        vm.stopPrank();
    }

    function topUp(uint256 a, uint256 p, uint256 idx, uint256 amount) external {
        IOstiumTradingStorage.Trade memory tr = _tradeAt(_actor(a), _pairOf(p), uint8(idx % 10));
        if (tr.leverage == 0) return;
        vm.prank(tr.trader);
        try trading.topUpCollateral(tr.pairIndex, tr.index, bound(amount, 1e6, 1_000e6)) {
            _count("topUp");
        } catch {}
    }

    function removeCollateral(uint256 a, uint256 p, uint256 idx, uint256 amount) external {
        IOstiumTradingStorage.Trade memory tr = _tradeAt(_actor(a), _pairOf(p), uint8(idx % 10));
        if (tr.leverage == 0 || tr.collateral < 2) return;
        _remove(tr, bound(amount, 1, tr.collateral - 1));
    }

    function _remove(IOstiumTradingStorage.Trade memory tr, uint256 amount) internal {
        vm.recordLogs();
        vm.prank(tr.trader);
        try trading.removeCollateral(tr.pairIndex, tr.index, amount) {} catch {
            return;
        }
        _count("removeCollateral");
        (uint256 id, uint32 ts_) = _lastRequestOrZero();
        _tryDeliver(id, tr.pairIndex, ts_);
    }

    /// @notice A liquidator triggers TP, SL or LIQ on a position and the keeper delivers.
    function triggerClose(uint256 a, uint256 p, uint256 idx, uint256 kind) external {
        IOstiumTradingStorage.Trade memory tr = _tradeAt(_actor(a), _pairOf(p), uint8(idx % 10));
        if (tr.leverage == 0) return;
        _triggerClose(tr, IOstiumTradingStorage.LimitOrder(kind % 3)); // TP, SL, LIQ
    }

    function _triggerClose(IOstiumTradingStorage.Trade memory tr, IOstiumTradingStorage.LimitOrder k) internal {
        bytes memory payload = _automationPayload(tr.trader, tr.pairIndex, tr.index, k, vm.getBlockTimestamp());
        vm.recordLogs();
        vm.prank(liquidatorA);
        try tradesUpKeep.performUpkeep(payload) {} catch {
            return;
        }
        (uint256 id, uint32 ts_) = _lastRequestOrZero();
        if (id == 0) return;
        _count("triggerClose");
        if (_tryDeliver(id, tr.pairIndex, ts_) && ts.getOpenTrade(tr.trader, tr.pairIndex, tr.index).leverage == 0) {
            _count("automationClosed");
        }
    }

    // -------------------------------------------------------------------------------------
    // Market and time
    // -------------------------------------------------------------------------------------

    function movePrice(uint256 p, int256 bps) external {
        uint16 pair = _pairOf(p);
        bps = bound(bps, -450, 450);
        int192 anchor = upkeep.lastPrice(_feedOf(pair));
        if (anchor == 0) anchor = px[pair];
        px[pair] = int192(int256(anchor) * (10_000 + bps) / 10_000);
        _count("movePrice");
    }

    function advance(uint256 blocks) external {
        blocks = bound(blocks, 1, 3_600);
        _advance(blocks);
        _count("advance");
    }

    // -------------------------------------------------------------------------------------
    // LP actions
    // -------------------------------------------------------------------------------------

    function _lp(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? lp : lp2;
    }

    function _noteRequest(address who, uint32 id) internal {
        if (!lpRequested[who][id]) {
            lpRequested[who][id] = true;
            lpRequestIds[who].push(id);
        }
    }

    function lpDeposit(uint256 s, uint256 amount) external {
        address who = _lp(s);
        uint256 bal = _bal(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal < 20_000e6 ? bal : 20_000e6);
        uint32 id = vault.targetSettlementId(true);
        if (usdw.allowance(who, d.vault) < amount) {
            vm.prank(who);
            usdw.approve(d.vault, type(uint256).max);
        }
        vm.prank(who);
        try vault.requestDeposit(amount) {
            _noteRequest(who, id);
            _count("lpDeposit");
        } catch {}
    }

    function lpWithdraw(uint256 s, uint256 shares) external {
        address who = _lp(s);
        uint256 bal = vault.balanceOf(who);
        if (bal == 0) return;
        shares = bound(shares, 1, bal / 2 + 1);
        uint32 id = vault.targetSettlementId(false);
        vm.prank(who);
        try vault.requestWithdraw(shares) {
            _noteRequest(who, id);
            _count("lpWithdraw");
        } catch {}
    }

    function settle(bool forced) external {
        if (forced) {
            vm.prank(gov);
            try vault.forceSettlement() {
                _count("forceSettlement");
            } catch {}
        } else {
            uint32 before = vault.lastSettlementId();
            vault.tryNewSettlement();
            if (vault.lastSettlementId() != before) _count("intervalSettlement");
        }
    }

    function lpClaim(uint256 s) external {
        address who = _lp(s);
        uint32[] memory ids = lpRequestIds[who];
        for (uint256 i = 0; i < ids.length; i++) {
            IOstiumVault.RequestStatus ds = vault.getDepositStatus(who, ids[i]);
            vm.startPrank(who);
            if (ds == IOstiumVault.RequestStatus.CLAIMABLE) {
                try vault.claimDeposit(ids[i]) {
                    _count("claimDeposit");
                } catch {}
            } else if (ds == IOstiumVault.RequestStatus.RECLAIMABLE) {
                try vault.reclaimDeposit(ids[i]) {
                    _count("reclaimDeposit");
                } catch {}
            }
            IOstiumVault.RequestStatus ws = vault.getWithdrawStatus(who, ids[i]);
            if (ws == IOstiumVault.RequestStatus.CLAIMABLE) {
                try vault.claimWithdraw(ids[i]) {
                    _count("claimWithdraw");
                } catch {}
            } else if (ws == IOstiumVault.RequestStatus.RECLAIMABLE) {
                try vault.reclaimWithdraw(ids[i]) {
                    _count("reclaimWithdraw");
                } catch {}
            }
            vm.stopPrank();
        }
    }

    function lpCancel(uint256 s) external {
        address who = _lp(s);
        uint32 id = vault.targetSettlementId(true);
        uint256 dep = vault.pendingDepositRequest(who, id);
        uint256 wd = vault.pendingWithdrawRequest(who, id);
        vm.startPrank(who);
        if (dep > 0) {
            try vault.cancelRequestDeposit(id, dep) {
                _count("cancelDeposit");
            } catch {}
        }
        if (wd > 0) {
            try vault.cancelRequestWithdraw(id, wd) {
                _count("cancelWithdraw");
            } catch {}
        }
        vm.stopPrank();
    }

    /// @dev The selectors the fuzzer may call; everything else on this contract is plumbing.
    function selectors() external pure returns (bytes4[] memory s) {
        s = new bytes4[](19);
        s[0] = this.openMarket.selector;
        s[1] = this.placeOrder.selector;
        s[2] = this.cancelOrder.selector;
        s[3] = this.updateOrder.selector;
        s[4] = this.triggerOrder.selector;
        s[5] = this.closeMarket.selector;
        s[6] = this.settlePending.selector;
        s[7] = this.updateTpSl.selector;
        s[8] = this.topUp.selector;
        s[9] = this.removeCollateral.selector;
        s[10] = this.triggerClose.selector;
        s[11] = this.movePrice.selector;
        s[12] = this.advance.selector;
        s[13] = this.lpDeposit.selector;
        s[14] = this.lpWithdraw.selector;
        s[15] = this.settle.selector;
        s[16] = this.lpClaim.selector;
        s[17] = this.lpCancel.selector;
        s[18] = this.openMarket.selector; // opens twice as likely: every other action needs positions
    }
}

/// @notice Protocol-wide invariants over random action sequences (see `ProtocolHandler`).
///
///         (a) USDW is conserved: the balances of every address that can hold it sum to the
///             total minted.
///         (b) TradingStorage holds at least every open trade's collateral plus every pending
///             open's and resting limit order's collateral; exactly that plus `devFees`.
///         (c) No successful open ever leaves a side's OI above the pair's cap at the price it
///             was accepted at.
///         (d) Any position whose value at the feed's last accepted price is below its
///             liquidation margin is liquidated by a liquidator trigger + keeper delivery at that
///             price.
///         (e) Vault accounting: the vault's USDW equals the LPs' realised value
///             `(maxAccPnlPerToken - accPnlPerToken) x supply`, plus the open PnL booked at the
///             last settlement, plus what it holds for LP requests in flight — to within
///             rounding dust.
///
/// @dev    Default runs are modest (inline config below); `FOUNDRY_PROFILE=invariant` runs the
///         nightly depth.
contract ProtocolInvariantTest is TestnetTrading {
    ProtocolHandler internal handler;

    function setUp() public {
        _setUpTestnet();
        handler = new ProtocolHandler(d);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.selectors()}));
    }

    // -------------------------------------------------------------------------------------
    // (a) USDW conservation
    // -------------------------------------------------------------------------------------

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 100
    /// forge-config: invariant.invariant.runs = 256
    /// forge-config: invariant.invariant.depth = 200
    function invariant_a_usdwIsConserved() public view {
        address[4] memory tr = handler.traders();
        address[2] memory l = handler.lps();
        uint256 sum;
        for (uint256 i = 0; i < tr.length; i++) {
            sum += _bal(tr[i]);
        }
        sum += _bal(l[0]) + _bal(l[1]);
        sum += _bal(d.tradingStorage) + _bal(d.vault) + _bal(d.callbacks) + _bal(d.trading) + _bal(dev);
        sum += _bal(marketMaker) + _bal(address(handler)) + _bal(address(this)) + _bal(owner) + _bal(gov);
        assertEq(sum, usdw.totalSupply(), "USDW created or destroyed");
        assertEq(_bal(d.callbacks), 0, "callbacks never keeps USDW");
        assertEq(_bal(d.trading), 0, "trading never keeps USDW");
    }

    // -------------------------------------------------------------------------------------
    // (b) Storage collateral
    // -------------------------------------------------------------------------------------

    function _escrowedInStorage() internal view returns (uint256 sum) {
        address[4] memory tr = handler.traders();
        for (uint256 a = 0; a < tr.length; a++) {
            for (uint16 p = 0; p < 4; p++) {
                for (uint8 i = 0; i < 10; i++) {
                    sum += ts.getOpenTrade(tr[a], p, i).collateral;
                }
            }
            uint256[] memory ids = ts.getPendingOrderIds(tr[a]);
            for (uint256 k = 0; k < ids.length; k++) {
                (,,, IOstiumTradingStorage.Trade memory t,) = ts.reqID_pendingMarketOrder(ids[k]);
                if (t.leverage > 0) sum += t.collateral; // opens carry collateral, closes do not
            }
        }
        for (uint16 p = 0; p < 4; p++) {
            IOstiumTradingStorage.OpenLimitOrder[] memory os = ts.getOpenLimitOrders(p);
            for (uint256 k = 0; k < os.length; k++) {
                sum += os[k].collateral;
            }
        }
    }

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 100
    /// forge-config: invariant.invariant.runs = 256
    /// forge-config: invariant.invariant.depth = 200
    function invariant_b_storageBacksEveryCollateral() public view {
        uint256 escrow = _escrowedInStorage();
        assertGe(_bal(d.tradingStorage), escrow, "storage short of collateral");
        assertEq(_bal(d.tradingStorage), escrow + ts.devFees(), "storage = collateral + dev fees, exactly");
    }

    // -------------------------------------------------------------------------------------
    // (c) OI cap
    // -------------------------------------------------------------------------------------

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 100
    /// forge-config: invariant.invariant.runs = 256
    /// forge-config: invariant.invariant.depth = 200
    function invariant_c_oiNeverAboveCapAfterAnOpen() public view {
        assertFalse(
            handler.oiBreached(),
            string.concat(
                "pair ", vm.toString(handler.oiBreachPair()), " OI ", vm.toString(handler.oiBreachValue()),
                " > cap ", vm.toString(handler.oiBreachMax())
            )
        );
    }

    // -------------------------------------------------------------------------------------
    // (d) Below maintenance is always liquidatable
    // -------------------------------------------------------------------------------------

    /// @dev The contract's `currentPercentProfit`, at the market price (what LIQ uses).
    function _pnlP(IOstiumTradingStorage.Trade memory t, uint32 initLev, uint256 price)
        internal
        pure
        returns (int256 profitP)
    {
        uint32 lev = t.leverage;
        int256 maxP = int256(900) * 1e6 * int256(uint256(lev)) / int256(uint256(lev > initLev ? lev : initLev));
        int256 open = int256(uint256(t.openPrice));
        profitP = (t.buy ? int256(price) - open : open - int256(price)) * 1e6 * int256(uint256(lev)) / open;
        if (profitP > maxP) profitP = maxP;
    }

    function _valueAt(address who, uint16 p, uint8 i, IOstiumTradingStorage.Trade memory t, uint256 price)
        internal
        view
        returns (uint256)
    {
        int256 profitP = _pnlP(t, _initialLeverage(who, p, i), price);
        int256 r = pairInfos.getTradeRolloverFee(who, p, i, t.buy, t.collateral, t.leverage);
        (int256 f,) = pairInfos.getTradeFundingFee(who, p, i, t.buy, t.collateral, t.leverage);
        return pairInfos.getTradeValuePure(t.collateral, profitP, r, f);
    }

    function _initialLeverage(address who, uint16 p, uint8 i) internal view returns (uint32) {
        return ts.getOpenTradeInfo(who, p, i).initialLeverage;
    }

    function _shouldLiquidate(address who, uint16 p, uint8 i, uint256 price) internal view returns (bool) {
        IOstiumTradingStorage.Trade memory t = ts.getOpenTrade(who, p, i);
        if (t.leverage == 0) return false;
        uint256 trig = ts.orderTriggerBlock(who, p, i, IOstiumTradingStorage.LimitOrder.LIQ);
        if (trig != 0 && vm.getBlockNumber() - trig < TRIGGER_TIMEOUT) return false; // a LIQ is already in flight
        return _valueAt(who, p, i, t, price)
            < pairInfos.getTradeLiquidationMargin(t.collateral, t.leverage, ps.pairMaxLeverage(p));
    }

    function _checkLiquidatable(address who, uint16 p, uint8 i, int192 last) internal {
        if (!_shouldLiquidate(who, p, i, uint256(int256(last)))) return;
        uint256 snap = vm.snapshotState();
        (uint256 id, uint32 t) = _triggerNow(liquidatorA, who, p, i, IOstiumTradingStorage.LimitOrder.LIQ);
        _deliverAt(id, p, t, last);
        assertEq(ts.getOpenTrade(who, p, i).leverage, 0, "below maintenance but not liquidated");
        vm.revertToState(snap);
    }

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 100
    /// forge-config: invariant.invariant.runs = 256
    /// forge-config: invariant.invariant.depth = 200
    function invariant_d_belowMaintenanceIsLiquidatable() public {
        address[4] memory tr = handler.traders();
        for (uint16 p = 0; p < 4; p++) {
            int192 last = upkeep.lastPrice(_feedOf(p));
            if (last <= 0) continue;
            for (uint256 a = 0; a < tr.length; a++) {
                for (uint8 i = 0; i < 10; i++) {
                    _checkLiquidatable(tr[a], p, i, last);
                }
            }
        }
    }

    // -------------------------------------------------------------------------------------
    // (e) Vault accounting
    // -------------------------------------------------------------------------------------

    /// @dev USDW the vault holds for LP requests that are not LP capital: deposits pending or
    ///      refused, the unallocated part of scaled deposits, and settled withdrawals not yet
    ///      claimed.
    function _inFlight() internal view returns (uint256 sum) {
        address[2] memory l = handler.lps();
        for (uint256 k = 0; k < l.length; k++) {
            uint32[] memory ids = handler.requestIdsOf(l[k]);
            for (uint256 j = 0; j < ids.length; j++) {
                uint32 id = ids[j];
                uint256 dep = vault.pendingDepositRequest(l[k], id);
                if (dep > 0) {
                    IOstiumVault.RequestStatus s = vault.getDepositStatus(l[k], id);
                    if (s == IOstiumVault.RequestStatus.CLAIMABLE) {
                        sum += dep - dep * vault.settlementAllocationScaleP(id) / 1e18;
                    } else {
                        sum += dep; // PENDING or RECLAIMABLE
                    }
                }
                uint256 wd = vault.pendingWithdrawRequest(l[k], id);
                if (wd > 0 && vault.getWithdrawStatus(l[k], id) == IOstiumVault.RequestStatus.CLAIMABLE) {
                    sum += wd * vault.settlementShareToAssetsPrice(id) / 1e18;
                }
            }
        }
    }

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 100
    /// forge-config: invariant.invariant.runs = 256
    /// forge-config: invariant.invariant.depth = 200
    function invariant_e_vaultAssetsMatchItsAccounting() public view {
        int256 realised = (int256(vault.maxAccPnlPerToken()) - vault.accPnlPerToken()) * int256(vault.totalSupply()) / 1e18;
        int256 expected = realised + vault.lastSettlementOpenPnl() / 1e12 + int256(_inFlight());
        int256 actual = int256(_bal(d.vault));
        // Rounding: at most a couple of micro-USDW per share mint/burn, claim and PnL transfer.
        int256 tolerance = 100 + 4 * int256(handler.totalCalls());
        assertApproxEqAbs(actual, expected, uint256(tolerance), "vault USDW != its accounting");
        assertGe(actual, int256(_inFlight()), "vault cannot cover LP requests in flight");
    }

    /// @dev Printed with `-vv` after each run, to see the campaign is not vacuous.
    function afterInvariant() external view {
        bytes32[12] memory keys = [
            bytes32("openMarket"), "deliverPending", "closeMarket", "triggerOrder", "triggerClose",
            "automationClosed", "removeCollateral", "topUp", "lpDeposit", "claimDeposit", "forceSettlement",
            "openTimeout"
        ];
        string memory line = "";
        for (uint256 i = 0; i < keys.length; i++) {
            line = string.concat(line, string(abi.encodePacked(keys[i])), "=", vm.toString(handler.calls(keys[i])), " ");
        }
        console2.log(line);
    }

    // -------------------------------------------------------------------------------------
    // Handler reachability (deterministic, so a broken handler cannot pass vacuously)
    // -------------------------------------------------------------------------------------

    function test_handlerReachesEveryAction() public {
        handler.openMarket(0, 0, 1_000e6, 1_000, true, true);
        handler.openMarket(1, 1, 1_000e6, 500, false, false);
        handler.settlePending(0);
        handler.placeOrder(2, 2, 500e6, 1_000, true, false, 100);
        handler.updateOrder(2, 2, 0, 150);
        handler.movePrice(2, -300);
        handler.triggerOrder(2, 2, 0, true);
        handler.updateTpSl(0, 0, 0, 500, 300);
        handler.topUp(0, 0, 0, 100e6);
        handler.removeCollateral(0, 0, 0, 50e6);
        handler.closeMarket(0, 0, 0, 5_000, true);
        handler.movePrice(0, -450);
        handler.triggerClose(0, 0, 0, 2);
        handler.placeOrder(3, 3, 100e6, 500, false, true, 50);
        handler.cancelOrder(3, 3, 0);
        handler.lpDeposit(1, 5_000e6);
        handler.lpWithdraw(0, 1_000e6);
        handler.lpCancel(1);
        handler.lpDeposit(1, 5_000e6);
        handler.settle(true);
        handler.lpClaim(0);
        handler.lpClaim(1);
        handler.advance(3_600);
        handler.settle(false);
        handler.openMarket(1, 1, 1_000e6, 500, false, false);
        handler.advance(20);
        handler.settlePending(1);

        bytes32[16] memory must = [
            bytes32("openMarket"), "deliverPending", "placeOrder", "updateOrder", "triggerOrder", "updateTp",
            "topUp", "removeCollateral", "closeMarket", "triggerClose", "cancelOrder", "lpDeposit", "lpWithdraw",
            "forceSettlement", "claimDeposit", "claimWithdraw"
        ];
        for (uint256 i = 0; i < must.length; i++) {
            assertGt(handler.calls(must[i]), 0, string(abi.encodePacked(must[i])));
        }
        assertGt(handler.calls("intervalSettlement"), 0, "interval settlement");
        assertGt(handler.calls("openTimeout"), 0, "open timeout");
        assertGt(handler.calls("cancelDeposit"), 0, "cancel");

        invariant_a_usdwIsConserved();
        invariant_b_storageBacksEveryCollateral();
        invariant_c_oiNeverAboveCapAfterAnOpen();
        invariant_d_belowMaintenanceIsLiquidatable();
        invariant_e_vaultAssetsMatchItsAccounting();
    }
}
