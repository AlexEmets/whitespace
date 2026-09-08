/**
 * Pure bigint mirror of the margin/liquidation-price math in
 * contracts/src/vendor/ostium/OstiumPairInfos.sol. No network, no I/O, no floats —
 * every function here takes and returns bigint, and every arithmetic step is written
 * in the same left-to-right order as the Solidity source so integer truncation
 * (Solidity's `/` truncates toward zero for both int and uint; JS BigInt `/` does the
 * same) lands identically.
 *
 * Read this alongside OstiumPairInfos.sol:775-882 (getTradeLiquidationPrice,
 * getTradeLiquidationPricePure, getTradeValuePure, getTradeLiquidationMargin) and
 * TradingCallbacksLib.sol:41-79 (_currentPercentProfit). Line numbers as of the vendor
 * commit pinned in contracts/VENDOR.md.
 *
 * WHERE THIS CAN DIVERGE FROM THE CONTRACT (read before trusting this module alone):
 *
 * 0. IMPORTANT, found while building this module: `getTradeLiquidationPrice` /
 *    `getTradeLiquidationPricePure` is NOT literally the on-chain trigger condition. The
 *    real trigger, in OstiumTradingCallbacks.executeAutomationCloseOrderCallback:504, is
 *    `isLiquidated = tvResult.tradeValue < tvResult.liqMarginValue`, computed by
 *    `pairInfos.getTradeValue(...)`. `getTradeLiquidationPrice` is a *separately solved*
 *    closed-form inverse (openPrice ± distance) that is never called anywhere in the
 *    trigger path — grep confirms it — it exists for display ("your liquidation price is
 *    approximately X"). The two are algebraically equivalent in continuous math, but
 *    each goes through its own independent chain of truncating integer divisions, so
 *    they are not always bit-for-bit equivalent at the exact boundary. Verified
 *    directly: for the fixture in test/marginEngine.test.mjs's boundary tests, at
 *    `currentPrice === getTradeLiquidationPricePure(...)` exactly, the value-based
 *    predicate says NOT liquidatable (tradeValue == liqMarginValue, fails the strict
 *    `<`), while a naive `currentPrice <= liquidationPrice` says liquidatable — a
 *    one-wei-of-price disagreement at the crossing point. This is why
 *    services/liquidator/src/liquidatorEngine.mjs does NOT decide off
 *    `getTradeLiquidationPrice`; it reconstructs `tradeValue` and `liqMarginValue`
 *    directly (see note 1) and applies `isLiquidatable` (this file, the exact
 *    predicate). `getTradeLiquidationPricePure` / `isLiquidatableByPrice` below remain
 *    for monitoring/display and as a cheap pre-filter only — see their own docstrings.
 *    Both directions of the pre-filter's disagreement are safe to act on speculatively
 *    (the contract is always the final arbiter: a wrongly-submitted trigger is rejected
 *    harmlessly with CancelReason.NOT_HIT, never executed), so using it to decide which
 *    candidates are worth the full exact check is fine; using it as the check itself is
 *    not.
 * 1. `rolloverFee` and `fundingFee` are NOT recomputed here from raw per-block state.
 *    On-chain these ultimately come from getPendingAccRolloverFees /
 *    getPendingAccFundingFees, which replay a Hill-function funding-rate curve and a
 *    Padé/power-of-two exponential approximation over accumulated per-block state
 *    (OstiumPairInfos.sol:561-716). That machinery is stateful (depends on every pair's
 *    funding history since its last touch) and numerically delicate — reimplementing it
 *    off-chain is exactly the kind of "wrong exponent never reverts" trap this project
 *    has hit twice already. This module treats rolloverFee/fundingFee as *inputs*,
 *    exactly like the contract's own `*Pure` functions do. The production caller
 *    (services/liquidator/src/chainReader.mjs) does not replay that machinery either —
 *    it obtains rolloverFee from `pairInfos.getTradeRolloverFee(...)` (a `view`
 *    function that runs the real accrual on-chain) and fundingFee from
 *    `getTradeFundingFeePure` (below, pure and exact) fed by
 *    `pairInfos.getPendingAccFundingFees(pairIndex)` and the trade's stored
 *    `tradeInitialAccFees` — both `view`, byte-exact, zero off-chain replication of the
 *    accrual curve itself. The pure functions in *this* file exist for (a) unit tests
 *    with synthetic fee values and (b) composing those exact view-call results into a
 *    final tradeValue — never for guessing fees from scratch.
 * 2. `liqMarginThresholdP` and `maxNegativePnlOnOpenP` are governance-mutable
 *    (`OstiumPairInfos.setLiqMarginThresholdP`). This module takes the current value as
 *    a parameter; a caller with a stale cached value will diverge. The chain reader
 *    re-reads `pairInfos.liqMarginThresholdP()` each cycle rather than caching it
 *    indefinitely.
 * 3. `maxLeverage` is per-pair and per day/overnight session
 *    (TradingCallbacksLib.getEffectiveMaxLeverage: day trades use `pairMaxLeverage`,
 *    overnight trades use `pairOvernightMaxLeverage` if set, else fall back to
 *    `pairMaxLeverage` too). BTC/USD and ETH/USD are 24/7 crypto markets (design spec
 *    §1), so in practice `isDayTrade` is expected to be false and
 *    `pairOvernightMaxLeverage` is expected to be 0, collapsing to `pairMaxLeverage`
 *    unconditionally — but this module does not assume that; the caller must resolve
 *    the correct effective max leverage per trade.
 * 4. Integer division: this file follows Solidity's exact left-to-right chain of `*`
 *    and `/` operators (e.g. `.../ PRECISION_6 / 100n` as two sequential truncating
 *    divisions, not one division by their product) specifically because truncation can
 *    differ if the steps are reassociated with a negative intermediate value. See the
 *    inline comments at each such line.
 */

/** 18-decimal price precision (matches @whitespace/shared/decimal's PRICE_SCALE). */
export const PRECISION_18 = 10n ** 18n;
/** 6-decimal collateral (USDW) precision. */
export const PRECISION_6 = 10n ** 6n;
/** 2-decimal leverage/percent precision (e.g. leverage=1000 means 10.00x). */
export const PRECISION_2 = 100n;

/** OstiumPairInfos.sol:27 — MAX_FUNDING_FEE et al. live there too, but the only cap
 * this module needs is the PnL cap used by _currentPercentProfit. */
export const MAX_GAIN_P = 900n; // 900% PnL cap, TradingCallbacksLib.sol:22

/**
 * Mirrors OstiumPairInfos.getTradeLiquidationMargin (OstiumPairInfos.sol:875-882)
 * exactly. All inputs are uint-shaped (non-negative) bigints, matching the contract's
 * uint256/uint32/uint8 argument types.
 *
 * @param {object} p
 * @param {bigint} p.collateral PRECISION_6
 * @param {bigint} p.leverage PRECISION_2 (e.g. 1000n = 10.00x)
 * @param {bigint} p.maxLeverage PRECISION_2
 * @param {bigint} p.liqMarginThresholdP plain percent, e.g. 25n for 25% (OstiumPairInfos.liqMarginThresholdP())
 * @returns {bigint} PRECISION_6
 */
export function getTradeLiquidationMargin({ collateral, leverage, maxLeverage, liqMarginThresholdP }) {
  if (maxLeverage <= 0n) throw new Error('getTradeLiquidationMargin: maxLeverage must be > 0');
  // rawAdjustedThreshold = liqMarginThresholdP * leverage * PRECISION_6 / maxLeverage
  const rawAdjustedThreshold = (liqMarginThresholdP * leverage * PRECISION_6) / maxLeverage;
  // collateral * rawAdjustedThreshold / (100 * PRECISION_6)
  return (collateral * rawAdjustedThreshold) / (100n * PRECISION_6);
}

/**
 * Mirrors TradingCallbacksLib._currentPercentProfit (TradingCallbacksLib.sol:41-69),
 * including the MAX_GAIN_P cap. Only the cap's *upper* bound is applied on-chain (a
 * losing position is never capped — the cap exists to bound the maximum payout, not the
 * maximum loss), so this never affects a liquidation-triggering (losing) computation in
 * practice, but is included for exactness.
 *
 * @param {object} p
 * @param {bigint} p.openPrice PRECISION_18
 * @param {bigint} p.currentPrice PRECISION_18
 * @param {boolean} p.buy
 * @param {bigint} p.leverage PRECISION_2
 * @param {bigint} p.initialLeverage PRECISION_2
 * @returns {{ p: bigint, maxPnlP: bigint }} both PRECISION_6 * PRECISION_2-scaled percent (i.e. divide by 1e8 for a fraction)
 */
export function currentPercentProfit({ openPrice, currentPrice, buy, leverage, initialLeverage }) {
  if (openPrice <= 0n) throw new Error('currentPercentProfit: openPrice must be > 0');
  const maxLev = leverage > initialLeverage ? leverage : initialLeverage;
  const maxPnlP = (MAX_GAIN_P * PRECISION_6 * leverage) / maxLev;
  let p = ((buy ? currentPrice - openPrice : openPrice - currentPrice) * PRECISION_6 * leverage) / openPrice;
  if (p > maxPnlP) p = maxPnlP;
  return { p, maxPnlP };
}

/**
 * Mirrors OstiumPairInfos.getTradeValuePure (OstiumPairInfos.sol:859-873) exactly,
 * including the two *sequential* truncating divisions (`/ PRECISION_6 / 100n`, not one
 * division by their product — see file header note 4) and the floor-at-zero.
 *
 * @param {object} p
 * @param {bigint} p.collateral PRECISION_6
 * @param {bigint} p.percentProfit from currentPercentProfit().p
 * @param {bigint} p.rolloverFee signed, PRECISION_6
 * @param {bigint} p.fundingFee signed, PRECISION_6
 * @returns {bigint} PRECISION_6, always >= 0
 */
export function getTradeValuePure({ collateral, percentProfit, rolloverFee, fundingFee }) {
  let value = collateral + (collateral * percentProfit) / PRECISION_6 / 100n - rolloverFee - fundingFee;
  if (value < 0n) value = 0n;
  return value;
}

/**
 * Mirrors OstiumPairInfos.getTradeLiquidationPricePure (OstiumPairInfos.sol:806-825)
 * exactly, including the sequential `/ collateral / leverage` divisions.
 *
 * @param {object} p
 * @param {bigint} p.openPrice PRECISION_18
 * @param {boolean} p.buy
 * @param {bigint} p.collateral PRECISION_6
 * @param {bigint} p.leverage PRECISION_2
 * @param {bigint} p.rolloverFee signed, PRECISION_6
 * @param {bigint} p.fundingFee signed, PRECISION_6
 * @param {bigint} p.maxLeverage PRECISION_2
 * @param {bigint} p.liqMarginThresholdP plain percent
 * @returns {bigint} PRECISION_18, floored at 0
 */
export function getTradeLiquidationPricePure({
  openPrice,
  buy,
  collateral,
  leverage,
  rolloverFee,
  fundingFee,
  maxLeverage,
  liqMarginThresholdP,
}) {
  if (collateral <= 0n) throw new Error('getTradeLiquidationPricePure: collateral must be > 0');
  if (leverage <= 0n) throw new Error('getTradeLiquidationPricePure: leverage must be > 0');
  const liqMarginValue = getTradeLiquidationMargin({ collateral, leverage, maxLeverage, liqMarginThresholdP });
  const targetCollateralAfterFees = collateral - liqMarginValue - rolloverFee - fundingFee;
  // openPrice * targetCollateralAfterFees * PRECISION_2 / collateral / leverage
  const liqPriceDistance = (openPrice * targetCollateralAfterFees * PRECISION_2) / collateral / leverage;
  const liqPrice = buy ? openPrice - liqPriceDistance : openPrice + liqPriceDistance;
  return liqPrice > 0n ? liqPrice : 0n;
}

/**
 * The contract's actual liquidation predicate
 * (OstiumTradingCallbacks.executeAutomationCloseOrderCallback:504,
 * `isLiquidated = tvResult.tradeValue < tvResult.liqMarginValue`) — strict less-than.
 * At exact equality the position is NOT liquidatable; this is the boundary the tests in
 * test/marginEngine.test.mjs pin down.
 *
 * @param {bigint} tradeValue
 * @param {bigint} liqMarginValue
 */
export function isLiquidatable(tradeValue, liqMarginValue) {
  return tradeValue < liqMarginValue;
}

/**
 * The same predicate, approximated as a price crossing instead of a value comparison.
 * NOT bit-exact with isLiquidatable — see file header note 0. Empirically, at the exact
 * price `getTradeLiquidationPricePure` returns, the value-based predicate is already on
 * the *not-liquidatable* side of its own boundary (tradeValue == liqMarginValue, and
 * isLiquidatable is strict `<`), so this uses a strict comparison too
 * (`<`/`>`, excluding the boundary) to match as closely as the two independent
 * truncation paths allow — proven for one fixture in test/marginEngine.test.mjs, not
 * proven to hold in general for every input (that is precisely the divergence being
 * documented, not a bug to silently paper over).
 *
 * services/liquidator/src/liquidatorEngine.mjs therefore uses this ONLY as a cheap
 * pre-filter (cache a liquidation price, skip candidates nowhere near it without an RPC
 * round trip) and always confirms with the exact value-based predicate — built from
 * `pairInfos.getTradeRolloverFee` / `getPendingAccFundingFees` / `getTradeValuePure` /
 * `getTradeLiquidationMargin`, all exact — before submitting.
 *
 * @param {boolean} buy
 * @param {bigint} currentPrice PRECISION_18 — the trusted index/mark price
 * @param {bigint} liquidationPrice PRECISION_18, from getTradeLiquidationPricePure
 */
export function isLiquidatableByPrice(buy, currentPrice, liquidationPrice) {
  return buy ? currentPrice < liquidationPrice : currentPrice > liquidationPrice;
}

/**
 * Mirrors OstiumPairInfos.getTradeFundingFeePure (OstiumPairInfos.sol:762-773) exactly.
 * Pure and exact — safe to reimplement, unlike the accrual curve that produces its
 * inputs (see file header note 1). Combine with two `view` calls
 * (`pairInfos.getPendingAccFundingFees(pairIndex)` for `endAccFundingFeesPerOi`, and the
 * public `tradeInitialAccFees(trader, pairIndex, index)` mapping getter for
 * `accFundingFeesPerOi`) to get the exact live funding fee without replaying the Hill
 * function off-chain.
 *
 * @param {bigint} accFundingFeesPerOi trade's stored initial funding accumulator
 * @param {bigint} endAccFundingFeesPerOi current pair accumulator (long or short side, per trade.buy)
 * @param {bigint} collateral PRECISION_6
 * @param {bigint} leverage PRECISION_2
 * @returns {bigint} signed, PRECISION_6
 */
export function getTradeFundingFeePure(accFundingFeesPerOi, endAccFundingFeesPerOi, collateral, leverage) {
  const accFundingDelta = endAccFundingFeesPerOi - accFundingFeesPerOi;
  const fundingFee = (accFundingDelta * (collateral * leverage)) / PRECISION_18 / 100n;
  if (fundingFee !== 0n) return fundingFee;
  return accFundingDelta > 0n ? 1n : 0n;
}

/**
 * Convenience composition of the four functions above: given a trade and a current
 * price, returns everything the liquidator engine needs to decide. Two equivalent ways
 * to express the same boundary are both returned (tradeValue-vs-margin, and
 * price-vs-liquidationPrice) — see docs/decisions/phase-6-liquidator.md for the algebraic
 * proof that they agree (modulo the MAX_GAIN_P cap, which never engages on the losing
 * side that drives liquidation).
 *
 * @param {object} p
 * @param {bigint} p.openPrice
 * @param {bigint} p.currentPrice
 * @param {boolean} p.buy
 * @param {bigint} p.collateral
 * @param {bigint} p.leverage
 * @param {bigint} p.initialLeverage
 * @param {bigint} p.maxLeverage
 * @param {bigint} p.liqMarginThresholdP
 * @param {bigint} [p.rolloverFee]
 * @param {bigint} [p.fundingFee]
 */
export function evaluateMargin({
  openPrice,
  currentPrice,
  buy,
  collateral,
  leverage,
  initialLeverage,
  maxLeverage,
  liqMarginThresholdP,
  rolloverFee = 0n,
  fundingFee = 0n,
}) {
  const liqMarginValue = getTradeLiquidationMargin({ collateral, leverage, maxLeverage, liqMarginThresholdP });
  const { p: percentProfit } = currentPercentProfit({ openPrice, currentPrice, buy, leverage, initialLeverage });
  const tradeValue = getTradeValuePure({ collateral, percentProfit, rolloverFee, fundingFee });
  const liquidationPrice = getTradeLiquidationPricePure({
    openPrice,
    buy,
    collateral,
    leverage,
    rolloverFee,
    fundingFee,
    maxLeverage,
    liqMarginThresholdP,
  });
  return {
    liqMarginValue,
    percentProfit,
    tradeValue,
    liquidationPrice,
    liquidatable: isLiquidatable(tradeValue, liqMarginValue),
  };
}
