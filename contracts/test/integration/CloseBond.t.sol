// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SystemFixture} from "../helpers/SystemFixture.sol";
import {IOstiumTrading} from "../../src/vendor/ostium/interfaces/IOstiumTrading.sol";
import {IOstiumTradingStorage} from "../../src/vendor/ostium/interfaces/IOstiumTradingStorage.sol";

/// @notice The oracle-fee bond on the close path.
/// @dev See docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md.
contract CloseBondTest is SystemFixture {
    /// Settled by test_fullCloseIsTenThousandNotOneHundred rather than assumed:
    /// OstiumTrading.PERCENT_BASE (OstiumTrading.sol:28), the value that means "close all of it".
    uint16 internal constant FULL = 100e2;

    address internal trader = address(0x7AA);

    // -------------------------------------------------------------------------------------
    // Fixture wiring — single-trader wrappers around SystemFixture's multi-trader API.
    // Later tasks in this plan append more helpers here; keep additions in this shape.
    // -------------------------------------------------------------------------------------

    /// @dev Names `SystemFixture._deployConfiguredSystem` (SystemFixture.sol:66) the way
    ///      `TradeLocal.t.sol:58` does, since every test below calls it by that name.
    function _configureAll() internal {
        _deployConfiguredSystem();
    }

    /// @dev Overloads (does not override) `SystemFixture._fundTrader(address,uint256)`
    ///      (SystemFixture.sol:171) for this suite's single implicit `trader`.
    function _fundTrader(uint256 amount) internal {
        _fundTrader(trader, amount);
    }

    /// @dev Overloads `SystemFixture._collateralOf` (SystemFixture.sol:226) for `trader`'s
    ///      first (and only, in this plan) open-trade slot.
    function _openCollateral() internal view returns (uint256 collateral) {
        return _collateralOf(trader, 0);
    }

    /// @dev `closeTradeMarket`'s counterpart: open a market trade and deliver a valid report
    ///      so it fills. Delegates to `SystemFixture._openPositionAtBaseline`
    ///      (SystemFixture.sol:232-235), which does exactly this for a given `who`.
    function _openAndFill(uint256 collateral) internal {
        _openPositionAtBaseline(trader, collateral);
    }

    /// @dev Request a close at `pct` (the `closePercentage` argument, precision-2 — see `FULL`
    ///      above) and deliver a valid report so it fills. Ported from `TradeLocal.t.sol:164-172`.
    function _requestCloseAndFill(uint16 pct) internal {
        vm.recordLogs();
        vm.prank(trader);
        IOstiumTrading(d.trading).closeTradeMarket(
            0, 0, pct, uint192(uint256(int256(BTC_65K))), 100
        );
        (uint256 orderId, uint32 timestamp) = _lastPriceRequest();
        _deliver(orderId, _signed(timestamp, BTC_65K));
    }

    // -------------------------------------------------------------------------------------
    // Characterisation
    // -------------------------------------------------------------------------------------

    /// TradeLocal.t.sol:166 passes closePercentage = 0 (its literal 100 there is the
    /// unrelated slippageP argument), which OstiumTrading.sol:297-299 defaults to
    /// PERCENT_BASE — so that test exercises a full close without ever pinning what
    /// PERCENT_BASE actually is. Seven later tasks in this plan branch on that value, so it
    /// is settled here by test rather than by reading.
    function test_fullCloseIsTenThousandNotOneHundred() public {
        _configureAll();
        _fundTrader(10_000e6);
        _openAndFill(1000e6);

        _requestCloseAndFill(100);

        assertGt(
            _openCollateral(),
            0,
            "closePercentage=100 must be a 1% partial close; if this fails, PERCENT_BASE is 100 and every 100e2 in this plan is wrong"
        );
    }
}
