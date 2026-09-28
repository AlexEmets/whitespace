// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestnetTrading} from "../helpers/TestnetTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";
import {IOstiumTradingCallbacks} from "../../src/vendor/ostium/interfaces/IOstiumTradingCallbacks.sol";

/// @notice `OstiumPairInfos` economics at the deployed testnet parameters, each checked against
///         an independent re-derivation: maker/taker opening fees and their vault/dev split,
///         funding direction and cap, rollover accrual, the liquidation boundary, the dynamic
///         spread for several sizes, and recent-volume decay.
/// @dev    The reference functions below are transcriptions of the formulas, written out here
///         so a change to the contract's arithmetic shows up as a mismatch.
contract PairInfosEconomicsTest is TestnetTrading {
    address internal longTrader = address(0x7AA);
    address internal shortTrader = address(0x7AB);

    uint256 internal constant PREMIUM = 475_646_879; // brokerPremium per block, 1.5%/yr
    uint64 internal constant MAX_FUNDING = 31_709_791_983;

    function setUp() public {
        _setUpTestnet();
        _fundTrader(longTrader, 1_000_000e6);
        _fundTrader(shortTrader, 1_000_000e6);
    }

    // =====================================================================================
    // Opening fees: maker vs taker, vault/dev split
    // =====================================================================================

    function _baseFee(uint256 makerAmt, uint256 takerAmt) internal pure returns (uint256) {
        return (MAKER_FEE_P * makerAmt + TAKER_FEE_P * takerAmt) / 1e6 / 100;
    }

    /// @dev Opens at base and returns (dev fee excl. oracle fee, vault fee) actually charged.
    function _openAndMeasure(address who, uint256 collateral, uint32 leverage, bool buy)
        internal
        returns (uint256 devFee, uint256 vaultFee)
    {
        uint256 dev0 = ts.devFees();
        uint256 vault0 = _bal(d.vault);
        _openAt(who, BTC, collateral, leverage, buy, _basePrice(BTC));
        devFee = ts.devFees() - dev0 - ORACLE_FEE;
        vaultFee = _bal(d.vault) - vault0;
    }

    /// @dev The long skew the fee function sees, 6 decimals, at the fixture price.
    function _oiDeltaAtBase() internal view returns (uint256) {
        uint256 p = uint256(int256(_basePrice(BTC)));
        uint256 l = _oi(BTC, true) * p / 1e18 / 1e12;
        uint256 s = _oi(BTC, false) * p / 1e18 / 1e12;
        return l - s;
    }

    function test_openingFee_takerIntoAnEmptyMarketSplitsHalfToTheVault() public {
        (uint256 devFee, uint256 vaultFee) = _openAndMeasure(longTrader, 1_000e6, 1_000, true);
        uint256 base = _baseFee(0, 10_000e6);
        assertEq(base, 3e6, "0.03% of 10k");
        assertEq(vaultFee, base * 50 / 100, "vault half");
        assertEq(devFee, base - base * 50 / 100, "dev half");
    }

    function test_openingFee_makerWhenReducingTheSkewUpTo20x() public {
        _openAt(longTrader, BTC, 1_000e6, 1_000, true, _basePrice(BTC));
        assertGt(_oiDeltaAtBase(), 5_000e6, "precondition: long skew larger than the short");
        (uint256 devFee, uint256 vaultFee) = _openAndMeasure(shortTrader, 500e6, 1_000, false);
        uint256 base = _baseFee(5_000e6, 0);
        assertEq(base, 0.5e6, "0.01% of 5k");
        assertEq(vaultFee + devFee, base, "maker rate");
        assertEq(vaultFee, base * 50 / 100, "vault half");
    }

    function test_openingFee_crossingTheSkewSplitsMakerAndTaker() public {
        _openAt(longTrader, BTC, 1_000e6, 1_000, true, _basePrice(BTC));
        uint256 skew = _oiDeltaAtBase();
        (uint256 devFee, uint256 vaultFee) = _openAndMeasure(shortTrader, 2_000e6, 1_000, false);
        uint256 base = _baseFee(skew, 20_000e6 - skew);
        assertEq(vaultFee + devFee, base, "maker up to the skew, taker beyond it");
        assertGt(base, _baseFee(20_000e6, 0), "more than all-maker");
        assertLt(base, _baseFee(0, 20_000e6), "less than all-taker");
    }

    function test_openingFee_takerAboveTheMakerLeverageCap() public {
        _openAt(longTrader, BTC, 1_000e6, 1_000, true, _basePrice(BTC));
        (uint256 devFee, uint256 vaultFee) = _openAndMeasure(shortTrader, 200e6, 2_500, false); // 25x > 20x
        assertEq(vaultFee + devFee, _baseFee(0, 5_000e6), "taker despite reducing the skew");
        (devFee, vaultFee) = _openAndMeasure(shortTrader, 250e6, 2_000, false); // exactly 20x
        assertEq(vaultFee + devFee, _baseFee(5_000e6, 0), "20x is still maker");
    }

    function test_openingFee_sameSideAddingToTheSkewIsTaker() public {
        _openAt(longTrader, BTC, 1_000e6, 1_000, true, _basePrice(BTC));
        (uint256 devFee, uint256 vaultFee) = _openAndMeasure(shortTrader, 500e6, 1_000, true);
        assertEq(vaultFee + devFee, _baseFee(0, 5_000e6), "taker");
    }

    // =====================================================================================
    // Funding
    // =====================================================================================

    /// @dev Field-for-field the auto-getter's 12 static return values, decoded in one go (the
    ///      12-value destructuring is too deep for the stack).
    struct F {
        int256 accLong;
        int256 accShort;
        int64 lastFr;
        int64 infl;
        uint64 maxPerBlock;
        uint64 spring;
        uint32 lastBlock;
        uint16 pos;
        uint16 neg;
        uint16 up;
        uint16 down;
        int256 lastOiDelta;
    }

    function _f(uint16 p) internal view returns (F memory f) {
        (bool ok, bytes memory ret) =
            address(pairInfos).staticcall(abi.encodeWithSignature("pairFundingFees(uint16)", p));
        require(ok, "pairFundingFees");
        f = abi.decode(ret, (F));
    }

    function _refExp(int256 value) internal pure returns (uint256) {
        uint256 absV = uint256(value < 0 ? -value : value);
        if (absV < 793231258909201900) {
            int256 three = 3e18;
            int256 nt = value + three;
            uint256 num = uint256(nt * nt) / 1e18 + uint256(three);
            int256 dt = value - three;
            uint256 den = uint256(dt * dt) / 1e18 + uint256(three);
            return num * 1e18 / den;
        } else if (absV <= 6906000000000000000) {
            uint256 intPart = absV / 1e18;
            uint256 dec = absV - intPart * 1e18;
            uint256 approx = 1e6;
            for (uint256 i = 0; i < 10; i++) {
                dec = dec * 2;
                if (dec >= 1e18) {
                    approx = approx * _sqrtTable(i) / 1e6;
                    dec -= 1e18;
                }
                if (dec == 0) break;
            }
            return uint256(1e18) * 1e18 / ((2 ** intPart) * (approx / 1e3 * 1e15)) / 1e15 * 1e15;
        }
        return 0;
    }

    /// @dev e^(2^-(i+1)) x 1e6 — the contract's table, as a lookup rather than a 10-element
    ///      memory literal (which is too deep for the stack once inlined).
    function _sqrtTable(uint256 i) internal pure returns (uint256) {
        if (i == 0) return 1648721;
        if (i == 1) return 1284025;
        if (i == 2) return 1133148;
        if (i == 3) return 1064494;
        if (i == 4) return 1031743;
        if (i == 5) return 1015748;
        if (i == 6) return 1007843;
        if (i == 7) return 1003915;
        if (i == 8) return 1001955;
        return 1000977;
    }

    function _refTarget(int256 oiDelta, F memory f) internal pure returns (int256) {
        int256 x = 184 * oiDelta / 100;
        int256 x2 = x * x * 1e6;
        int256 hill = x2 * 1e18 / (16 * 1e16 + x2);
        int256 t = oiDelta >= 0
            ? int256(uint256(f.pos)) * hill / 100 + f.infl
            : -(int256(uint256(f.neg)) * hill / 100) + f.infl;
        if (t > 1e18) t = 1e18;
        else if (t < -1e18) t = -1e18;
        return t * int256(uint256(f.maxPerBlock)) / 1e18;
    }

    function _refOi(uint16 p) internal view returns (int256 oiDelta, int256 l, int256 s) {
        int256 price = openPnl.lastTradePrice(p);
        int256 cap = int256(ts.openInterest(p, 2));
        l = int256(ts.openInterest(p, 0)) * price / 1e18 / 1e12;
        s = int256(ts.openInterest(p, 1)) * price / 1e18 / 1e12;
        int256 m = l > s ? l : s;
        cap = m > cap ? m : cap;
        oiDelta = (l - s) * 1e6 / cap;
    }

    function _refPendingFunding(uint16 p) internal view returns (int256 vl, int256 vs, int64 fr, int256 oiDelta) {
        F memory f = _f(p);
        int256 l;
        int256 s;
        (oiDelta, l, s) = _refOi(p);
        int256 acc;
        (acc, fr) = _refAccAndRate(f, _refTarget(oiDelta, f), vm.getBlockNumber() - f.lastBlock);
        (vl, vs) = _refApply(f.accLong, f.accShort, acc, l, s);
    }

    function _refSpring(F memory f, int256 target) internal pure returns (uint256) {
        if (int256(f.lastFr) * target >= 0) {
            uint256 absT = uint256(target < 0 ? -target : target);
            uint256 absL = uint256(int256(f.lastFr < 0 ? -f.lastFr : f.lastFr));
            return absT > absL ? f.spring : uint256(f.down) * f.spring / 100e2;
        }
        return uint256(f.up) * f.spring / 100e2;
    }

    function _refAccAndRate(F memory f, int256 target, uint256 n) internal pure returns (int256 acc, int64 fr) {
        uint256 sf = _refSpring(f, target);
        int256 e = int256(_refExp(-int256(sf * n)));
        acc = target * int256(n) + (1e18 - e) * (int256(f.lastFr) - target) / int256(sf);
        fr = int64(target + (int256(f.lastFr) - target) * e / 1e18);
    }

    function _refApply(int256 vl, int256 vs, int256 acc, int256 l, int256 s) internal pure returns (int256, int256) {
        if (acc > 0) {
            if (l > 0) {
                vl += acc;
                vs -= s > 0 ? acc * l / s : int256(0);
            }
        } else {
            if (s > 0) {
                vs -= acc;
                vl += l > 0 ? acc * s / l : int256(0);
            }
        }
        return (vl, vs);
    }

    function _skewLong() internal {
        _openAt(longTrader, BTC, 10_000e6, 1_000, true, _basePrice(BTC)); // 100k notional
        _openAt(shortTrader, BTC, 2_000e6, 1_000, false, _basePrice(BTC)); // 20k notional
    }

    /// @notice The contract's pending funding matches the reference exactly for any horizon,
    ///         across all three branches of its exp approximation.
    /// forge-config: default.fuzz.runs = 64
    /// forge-config: invariant.fuzz.runs = 1024
    function testFuzz_funding_matchesTheReference(uint256 blocks) public {
        _skewLong();
        vm.roll(vm.getBlockNumber() + bound(blocks, 1, 3_000_000));
        _assertFundingMatchesReference();
    }

    function _assertFundingMatchesReference() internal view {
        (int256 al, int256 as_, int64 fr, int256 od) = pairInfos.getPendingAccFundingFees(BTC);
        (int256 rl, int256 rs, int64 rfr, int256 rod) = _refPendingFunding(BTC);
        assertEq(al, rl, "acc long");
        assertEq(as_, rs, "acc short");
        assertEq(fr, rfr, "rate");
        assertEq(od, rod, "oi delta");
    }

    /// @notice Long-skewed OI: longs pay, shorts receive, the rate never exceeds the 100%/yr
    ///         cap, and accrual over N blocks never exceeds N x cap.
    /// forge-config: default.fuzz.runs = 64
    /// forge-config: invariant.fuzz.runs = 1024
    function testFuzz_funding_directionAndCap(uint256 blocks) public {
        _skewLong();
        blocks = bound(blocks, 1, 5_000_000);
        F memory f0 = _f(BTC);
        vm.roll(vm.getBlockNumber() + blocks);
        (int256 al, int256 as_, int64 fr, int256 od) = pairInfos.getPendingAccFundingFees(BTC);
        assertGt(od, 0, "long skew");
        assertGt(fr, 0, "positive rate: longs pay");
        assertLe(uint256(int256(fr)), MAX_FUNDING, "rate within the cap");
        assertGt(al, f0.accLong, "long accumulator rises");
        assertLt(as_, f0.accShort, "short accumulator falls");
        assertLe(uint256(al - f0.accLong), blocks * MAX_FUNDING, "accrual within N x cap");
    }

    function test_funding_theShortIsPaidWhatTheLongPays() public {
        _skewLong();
        vm.roll(vm.getBlockNumber() + 50_000);
        IOstiumTradingStorage.Trade memory l = ts.getOpenTrade(longTrader, BTC, 0);
        IOstiumTradingStorage.Trade memory s = ts.getOpenTrade(shortTrader, BTC, 0);
        (int256 fl,) = pairInfos.getTradeFundingFee(longTrader, BTC, 0, true, l.collateral, l.leverage);
        (int256 fs,) = pairInfos.getTradeFundingFee(shortTrader, BTC, 0, false, s.collateral, s.leverage);
        assertGt(fl, 0, "long pays");
        assertLt(fs, 0, "short receives");
        assertApproxEqRel(uint256(-fs), uint256(fl), 0.005e18, "zero-sum up to entry-price differences");
    }

    /// @notice After many time constants the rate settles exactly on the Hill target, which at
    ///         this skew is well under the cap.
    function test_funding_rateConvergesToTheHillTarget() public {
        _skewLong();
        vm.roll(vm.getBlockNumber() + 2_000_000); // 200 time constants
        (,, int64 fr, int256 od) = pairInfos.getPendingAccFundingFees(BTC);
        int256 target = _refTarget(od, _f(BTC));
        assertEq(fr, target, "converged");
        assertLt(uint256(target), MAX_FUNDING, "below the cap at a ~66% skew");
    }

    function test_funding_balancedBookAccruesNothing() public {
        _openAt(longTrader, BTC, 1_000e6, 1_000, true, _basePrice(BTC));
        uint256 units = _oi(BTC, true);
        // a short with the same OI units: equal collateral and leverage at the mirrored fill
        _openAt(shortTrader, BTC, 1_000e6, 1_000, false, _basePrice(BTC));
        assertApproxEqRel(_oi(BTC, false), units, 0.01e18, "near balance (maker vs taker fee and bid vs ask)");
        F memory f0 = _f(BTC);
        vm.roll(vm.getBlockNumber() + 10_000);
        (int256 al,, int64 fr,) = pairInfos.getPendingAccFundingFees(BTC);
        assertLe(uint256(int256(fr < 0 ? -fr : fr)), MAX_FUNDING / 1_000_000, "rate ~0");
        assertLe(uint256(al > f0.accLong ? al - f0.accLong : f0.accLong - al), 10_000 * MAX_FUNDING / 1_000_000, "~no accrual");
    }

    // =====================================================================================
    // Rollover
    // =====================================================================================

    function test_rollover_accruesTheBrokerPremiumPerBlockOnBothSides() public {
        int256 l0 = pairInfos.getPendingAccRolloverFees(BTC, true);
        int256 s0 = pairInfos.getPendingAccRolloverFees(BTC, false);
        vm.roll(vm.getBlockNumber() + 12_345);
        assertEq(pairInfos.getPendingAccRolloverFees(BTC, true), l0 + int256(12_345 * PREMIUM), "long");
        assertEq(pairInfos.getPendingAccRolloverFees(BTC, false), s0 + int256(12_345 * PREMIUM), "short");
    }

    /// forge-config: default.fuzz.runs = 64
    /// forge-config: invariant.fuzz.runs = 1024
    function testFuzz_rollover_tradeFeeIsPremiumTimesBlocksTimesNotional(uint256 blocks, uint256 lev) public {
        lev = bound(lev, 100, 10_000);
        blocks = bound(blocks, 1, 31_536_000);
        _openAt(longTrader, BTC, 100e6, uint32(lev), true, _basePrice(BTC));
        IOstiumTradingStorage.Trade memory t = ts.getOpenTrade(longTrader, BTC, 0);
        vm.roll(vm.getBlockNumber() + blocks);
        int256 fee = pairInfos.getTradeRolloverFee(longTrader, BTC, 0, true, t.collateral, t.leverage);
        int256 expected = int256(blocks * PREMIUM) * int256(t.collateral * t.leverage) / 1e18 / 100;
        assertEq(fee, expected == 0 ? int256(1) : expected, "exact, minimum 1 once anything accrued");
        // one year at 1x costs 1.5% of notional
        if (blocks == 31_536_000 && lev == 100) assertApproxEqRel(uint256(fee), t.collateral * 15 / 1000, 1e12);
    }

    /// @notice The close charges exactly the rollover and funding the views report, and the
    ///         trader receives exactly collateral + PnL - rollover - funding.
    struct Accrued {
        int256 r;
        int256 f;
        uint256 value;
    }

    /// @dev Rollover, funding and the trade value at a close price, as the views report them now.
    function _accruedAtClose(address who, bool buy, uint256 closePx) internal view returns (Accrued memory a) {
        IOstiumTradingStorage.Trade memory t = ts.getOpenTrade(who, BTC, 0);
        a.r = pairInfos.getTradeRolloverFee(who, BTC, 0, buy, t.collateral, t.leverage);
        (a.f,) = pairInfos.getTradeFundingFee(who, BTC, 0, buy, t.collateral, t.leverage);
        a.value = pairInfos.getTradeValuePure(t.collateral, _profitP(t.openPrice, closePx, t.leverage), a.r, a.f);
    }

    function test_close_chargesExactlyTheAccruedRolloverAndFunding() public {
        // 40k long vs 10k short: skewed (funding accrues) but below the 50k impact threshold,
        // so the close fills at the plain bid
        _openAt(longTrader, BTC, 4_000e6, 1_000, true, _basePrice(BTC));
        _openAt(shortTrader, BTC, 1_000e6, 1_000, false, _basePrice(BTC));
        _advance(20_000);
        uint256 tradeId = ts.getOpenTradeInfo(longTrader, BTC, 0).tradeId;
        (uint256 id, uint32 ts_) = _requestClose(longTrader, BTC, 0, 0, _upx(BTC), 500);
        Accrued memory a = _accruedAtClose(longTrader, true, _spreadFill(_basePrice(BTC), true, false));
        assertGt(a.r, 0, "rollover accrued");
        assertGt(a.f, 0, "funding accrued");

        uint256 before = _bal(longTrader);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.FeesChargedV2(id, tradeId, longTrader, a.r, a.f);
        _deliverAt(id, BTC, ts_, _basePrice(BTC));
        assertEq(_bal(longTrader) - before, a.value, "paid exactly the trade value");
    }

    // =====================================================================================
    // Liquidation boundary
    // =====================================================================================

    function _profitP(uint256 open, uint256 price, uint32 lev) internal pure returns (int256 p) {
        int256 maxP = int256(900) * 1e6;
        p = (int256(price) - int256(open)) * 1e6 * int256(uint256(lev)) / int256(open);
        if (p > maxP) p = maxP;
    }

    function _isLiq(IOstiumTradingStorage.Trade memory t, uint256 price, int256 r, int256 f, uint256 margin)
        internal
        view
        returns (bool)
    {
        return pairInfos.getTradeValuePure(t.collateral, _profitP(t.openPrice, price, t.leverage), r, f) < margin;
    }

    /// @notice Finds the highest price at which the long is liquidatable under the contract's
    ///         own arithmetic, then shows the keeper path agrees: at that price a liquidation
    ///         goes through, one wei higher it is NOT_HIT. The view's liquidation price sits on
    ///         the same boundary to within one part in a million.
    /// forge-config: default.fuzz.runs = 16
    /// forge-config: invariant.fuzz.runs = 256
    function testFuzz_liquidation_boundaryIsExact(uint256 lev, uint256 blocks) public {
        lev = bound(lev, 2_500, 10_000);
        blocks = bound(blocks, 0, 200_000);
        _openAt(longTrader, BTC, 1_000e6, uint32(lev), true, _basePrice(BTC));
        _advance(blocks);

        uint256 boundary = this.liquidationBoundaryExt();
        assertApproxEqRel(this.liquidationPriceExt(), boundary, 1e12, "the view agrees with the boundary");

        uint256 collateral = ts.getOpenTrade(longTrader, BTC, 0).collateral;
        uint256 snap = vm.snapshotState();
        _assertLiquidatedAt(boundary, collateral);
        vm.revertToState(snap);
        _assertSurvivesAt(boundary + 1, collateral);
    }

    /// @dev External self-calls (never inlined) to keep these off the fuzz test's stack.
    function liquidationPriceExt() external view returns (uint256) {
        IOstiumTradingStorage.Trade memory t = ts.getOpenTrade(longTrader, BTC, 0);
        return pairInfos.getTradeLiquidationPrice(longTrader, BTC, 0, t.openPrice, true, t.collateral, t.leverage, 10_000);
    }

    function liquidationBoundaryExt() external view returns (uint256) {
        return _liquidationBoundary();
    }

    /// @dev Binary search, under the contract's own arithmetic, for the highest price at which
    ///      the long's value is below its liquidation margin.
    function _liquidationBoundary() internal view returns (uint256 lo) {
        IOstiumTradingStorage.Trade memory t = ts.getOpenTrade(longTrader, BTC, 0);
        int256 r = pairInfos.getTradeRolloverFee(longTrader, BTC, 0, true, t.collateral, t.leverage);
        (int256 f,) = pairInfos.getTradeFundingFee(longTrader, BTC, 0, true, t.collateral, t.leverage);
        uint256 margin = pairInfos.getTradeLiquidationMargin(t.collateral, t.leverage, 10_000);
        assertEq(margin, t.collateral * (uint256(25) * t.leverage * 1e6 / 10_000) / 1e8, "25% x lev/maxLev");
        lo = uint256(t.openPrice) * 95 / 100;
        uint256 hi = t.openPrice;
        assertTrue(_isLiq(t, lo, r, f, margin), "5% down is past the margin at >=25x");
        assertFalse(_isLiq(t, hi, r, f, margin), "healthy at entry");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_isLiq(t, mid, r, f, margin)) lo = mid;
            else hi = mid;
        }
    }

    function _assertLiquidatedAt(uint256 price, uint256 collateral) internal {
        uint256 vaultBefore = _bal(d.vault);
        uint256 traderBefore = _bal(longTrader);
        (uint256 id, uint32 ts_) = _triggerNow(liquidatorA, longTrader, BTC, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        _deliverAt(id, BTC, ts_, int192(int256(price)));
        assertEq(ts.openTradesCount(longTrader, BTC), 0, "liquidated at the boundary");
        assertEq(_bal(longTrader), traderBefore, "trader receives nothing");
        assertEq(_bal(d.vault) - vaultBefore, collateral, "the vault takes the whole collateral");
        assertEq(_oi(BTC, true), 0, "OI released");
    }

    function _assertSurvivesAt(uint256 price, uint256 collateral) internal {
        uint256 tradeId = ts.getOpenTradeInfo(longTrader, BTC, 0).tradeId;
        (uint256 id, uint32 ts_) = _triggerNow(liquidatorA, longTrader, BTC, 0, IOstiumTradingStorage.LimitOrder.LIQ);
        vm.expectEmit(true, true, true, true, d.callbacks);
        emit IOstiumTradingCallbacks.AutomationCloseOrderCanceled(
            id, tradeId, longTrader, BTC, IOstiumTradingStorage.LimitOrder.LIQ, IOstiumTradingCallbacks.CancelReason.NOT_HIT
        );
        _deliverAt(id, BTC, ts_, int192(int256(price)));
        assertEq(ts.getOpenTrade(longTrader, BTC, 0).collateral, collateral, "one wei better survives intact");
    }

    // =====================================================================================
    // Dynamic spread
    // =====================================================================================

    function _expectedFill(uint16 p, uint256 collateral, uint32 lev, uint256 initialVol, int192 price)
        internal
        view
        returns (uint256 fill, uint256 impactP)
    {
        (uint256 thr,, uint256 k) = pairInfos.pairDynamicSpreadParams(p);
        uint256 mid = uint256(int256(price));
        impactP = uint256(int256(2 * (price / 10_000))) * 1e18 * 100 / (mid * 2)
            + _dynImpact(thr, k, _postFee(collateral, lev) * lev * 1e10, initialVol);
        fill = mid * (1e18 + impactP / 100) / 1e18;
    }

    function _dynImpact(uint256 thr, uint256 k, uint256 n, uint256 initialVol) internal pure returns (uint256) {
        uint256 fin = n + initialVol;
        if (fin <= thr) return 0;
        uint256 excess = fin - thr;
        return initialVol < thr
            ? k * excess * excess * 100 / (2 * n) / 1e27
            : k * (initialVol - thr + n / 2) * 100 / 1e27;
    }

    /// @dev Opens `collateral` at `lev` long on a fresh book, checks the fill and the recorded
    ///      volume against the formula, rolls back, and returns the fill.
    function _checkSize(uint16 p, uint256 collateral, uint32 lev) internal returns (uint256 fill) {
        fill = this.expectedFillExt(p, collateral, lev, 0);
        uint256 snap = vm.snapshotState();
        _openAt(longTrader, p, collateral, lev, true, _basePrice(p));
        assertEq(ts.getOpenTrade(longTrader, p, 0).openPrice, fill, "fill = formula");
        _assertRecordedBuyVolume(p, _postFee(collateral, lev) * lev * 1e10);
        vm.revertToState(snap);
    }

    function _assertRecordedBuyVolume(uint16 p, uint256 expected) internal {
        (uint256 buyVol,, uint32 at) = pairInfos.pairDynamicSpreadState(p);
        assertEq(buyVol, expected, "volume recorded post-fee");
        assertEq(at, vm.getBlockTimestamp(), "stamped");
    }

    /// @dev External on purpose: an external self-call is never inlined, which keeps the
    ///      formula's temporaries off the caller's stack.
    function expectedFillExt(uint16 p, uint256 collateral, uint32 lev, uint256 initialVol)
        external
        view
        returns (uint256 fill)
    {
        (fill,) = _expectedFill(p, collateral, lev, initialVol, _basePrice(p));
    }

    function test_dynamicSpread_btcFillMatchesTheImpactFormulaForSeveralSizes() public {
        uint256 prev = _checkSize(BTC, 100e6, 10_000); // 10k notional
        assertEq(prev, _spreadFill(_basePrice(BTC), true, true), "below the threshold: half-spread only");
        uint256[3] memory sizes = [uint256(1_000e6), 5_000e6, 10_000e6]; // 100k, 500k, 1M
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 next = _checkSize(BTC, sizes[i], 10_000);
            assertGt(next, prev, "larger trades fill worse");
            prev = next;
        }
    }

    /// @notice WBT has 5x the impact coefficient and a fifth of the threshold.
    function test_dynamicSpread_wbtFillMatchesAndCostsMoreThanBtc() public {
        uint256 small = _checkSize(WBT, 100e6, 2_500);
        assertGt(_checkSize(WBT, 2_000e6, 2_500), small, "WBT impact grows with size");
        assertGt(_impactOf(WBT, 2_000e6, 2_500), _impactOf(BTC, 2_000e6, 2_500), "the same 50k costs more on WBT");
    }

    function _impactOf(uint16 p, uint256 collateral, uint32 lev) internal view returns (uint256) {
        uint256 base = uint256(int256(_basePrice(p)));
        return (this.expectedFillExt(p, collateral, lev, 0) - base) * 1e18 / base; // relative
    }

    function _effRate(uint256 buy, uint256 sell, uint128 rate, uint256 thr) internal pure returns (uint128) {
        uint256 net = buy > sell ? buy - sell : sell - buy;
        uint256 factor = 1e18;
        if (net > thr) {
            uint256 ratio = net * 1e18 / thr;
            factor = ratio > 3e18 ? 3e18 : ratio;
        }
        return uint128(uint256(rate) * 1e18 / factor);
    }

    function _pade(uint256 v, uint256 dt, uint128 rate) internal pure returns (uint256) {
        if (dt == 0) return v;
        uint256 h = uint256(rate) * dt / 2;
        uint256 num = 1e18 > h ? 1e18 - h : 0;
        return v * (num * 1e18 / (1e18 + h)) / 1e18;
    }

    /// @notice Recent volume decays with the Pade step at a rate slowed by up to 3x while the
    ///         book is one-sided; a trade after the decay pays exactly the decayed impact, and
    ///         after long enough nothing but the half-spread.
    function _decayedBuyVolume(uint256 dt) internal view returns (uint256) {
        (uint256 thr, uint128 rate,) = pairInfos.pairDynamicSpreadParams(BTC);
        (uint256 buy, uint256 sell,) = pairInfos.pairDynamicSpreadState(BTC);
        return _pade(buy, dt, _effRate(buy, sell, rate, thr));
    }

    function test_dynamicSpread_volumeDecaysOverTime() public {
        address second = address(0x7AC);
        _fundTrader(second, 10_000e6);
        _openAt(longTrader, BTC, 10_000e6, 10_000, true, _basePrice(BTC));
        (uint256 v0,,) = pairInfos.pairDynamicSpreadState(BTC);

        uint256 decayed = _decayedBuyVolume(600);
        _advance(600);
        assertLt(decayed, v0, "decayed");
        assertGt(decayed, 50_000e18, "still above the threshold after 10 min");
        uint256 fill = this.expectedFillExt(BTC, 100e6, 10_000, decayed);
        _openAt(second, BTC, 100e6, 10_000, true, _basePrice(BTC));
        assertEq(ts.getOpenTrade(second, BTC, 0).openPrice, fill, "impact on the decayed volume");
        (uint256 v1,,) = pairInfos.pairDynamicSpreadState(BTC);
        assertEq(v1, decayed + _postFee(100e6, 10_000) * 10_000 * 1e10, "decayed + new");
    }

    function test_dynamicSpread_volumeFullyDecaysAndOnlyTheSpreadRemains() public {
        address second = address(0x7AC);
        _fundTrader(second, 10_000e6);
        _openAt(longTrader, BTC, 10_000e6, 10_000, true, _basePrice(BTC));
        assertEq(_decayedBuyVolume(7_000), 0, "a one-sided 940k decays to zero within ~2h");
        _advance(7_000);
        _openAt(second, BTC, 100e6, 10_000, true, _basePrice(BTC));
        assertEq(ts.getOpenTrade(second, BTC, 0).openPrice, _spreadFill(_basePrice(BTC), true, true), "half-spread only");
    }
}
