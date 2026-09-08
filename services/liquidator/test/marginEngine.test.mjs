import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTradeLiquidationMargin,
  currentPercentProfit,
  getTradeValuePure,
  getTradeLiquidationPricePure,
  getTradeFundingFeePure,
  isLiquidatable,
  isLiquidatableByPrice,
  evaluateMargin,
} from '../src/marginEngine.mjs';

// Fixture shared by the boundary tests: a 10x-leveraged position on a market whose
// pairMaxLeverage is 100x, at liqMarginThresholdP=25% (the value contracts/script/
// Deploy.s.sol actually deploys — LIQ_MARGIN_THRESHOLD_P = 25). Round numbers chosen so
// the liqMarginValue comes out even (25,000,000 = 25 USDW), then perturbed by a tiny
// price delta (1e12 out of a 1e18-scaled price, ~1e-6 relative) to probe either side of
// the boundary without hunting for wei-exact truncation edges.
const BASE = {
  collateral: 1_000_000000n, // 1000 USDW
  leverage: 1000n, // 10.00x
  initialLeverage: 1000n,
  maxLeverage: 10000n, // 100.00x
  liqMarginThresholdP: 25n,
  openPrice: 100_000000000000000000n, // 100.0
  rolloverFee: 0n,
  fundingFee: 0n,
};

test('getTradeLiquidationMargin matches the hand-derived value (25% * 10x/100x * 1000 USDW = 25 USDW)', () => {
  const margin = getTradeLiquidationMargin(BASE);
  assert.equal(margin, 25_000000n);
});

test('boundary (long): exactly at maintenance margin is NOT liquidatable (strict less-than)', () => {
  const price = 90_250000000000000000n; // pre-computed forward-pipeline equality point
  const { p } = currentPercentProfit({ ...BASE, currentPrice: price, buy: true });
  const tradeValue = getTradeValuePure({ ...BASE, percentProfit: p });
  const liqMarginValue = getTradeLiquidationMargin(BASE);
  assert.equal(tradeValue, 25_000000n);
  assert.equal(liqMarginValue, 25_000000n);
  assert.equal(isLiquidatable(tradeValue, liqMarginValue), false);

  const evaluated = evaluateMargin({ ...BASE, currentPrice: price, buy: true });
  assert.equal(evaluated.liquidatable, false);
});

test('boundary (long): just below maintenance margin (lower price, further loss) IS liquidatable', () => {
  const price = 90_249999000000000000n; // boundary - 1e12 wei of price
  const evaluated = evaluateMargin({ ...BASE, currentPrice: price, buy: true });
  assert.equal(evaluated.tradeValue, 24_999900n);
  assert.ok(evaluated.tradeValue < evaluated.liqMarginValue);
  assert.equal(evaluated.liquidatable, true);
});

test('boundary (long): just above maintenance margin (higher price, less loss) is NOT liquidatable', () => {
  const price = 90_250001000000000000n; // boundary + 1e12 wei of price
  const evaluated = evaluateMargin({ ...BASE, currentPrice: price, buy: true });
  assert.equal(evaluated.tradeValue, 25_000100n);
  assert.ok(evaluated.tradeValue > evaluated.liqMarginValue);
  assert.equal(evaluated.liquidatable, false);
});

test('boundary (short): direction is mirrored — higher price is the loss side', () => {
  const boundary = 109_750000000000000000n;
  const below = evaluateMargin({ ...BASE, currentPrice: boundary - 1_000_000_000_000n, buy: false });
  const at = evaluateMargin({ ...BASE, currentPrice: boundary, buy: false });
  const above = evaluateMargin({ ...BASE, currentPrice: boundary + 1_000_000_000_000n, buy: false });

  // For a short, price *below* the boundary is favorable (profit), not liquidatable.
  assert.equal(below.liquidatable, false);
  assert.equal(below.tradeValue, 25_000100n);
  // Exactly at boundary: still not liquidatable (strict less-than).
  assert.equal(at.liquidatable, false);
  assert.equal(at.tradeValue, 25_000000n);
  // Above the boundary (price rose against the short): liquidatable.
  assert.equal(above.liquidatable, true);
  assert.equal(above.tradeValue, 24_999900n);
});

test('18/6/2 decimal scaling proven exact against the real deployed BTC/USD trade', () => {
  // Real numbers, not invented: openPrice/collateral/leverage from the executed proof
  // trade in deployments/1874-operational.json (proofTrade), maxLeverage=10000 from the
  // same file's market.maxLeverage, and liqMarginThresholdP=25 from the value actually
  // passed to OstiumPairInfos.initializeV3 in contracts/script/Deploy.s.sol
  // (LIQ_MARGIN_THRESHOLD_P). rolloverFee/fundingFee=0 (a freshly opened trade, matching
  // the proof trade's own history). Expected values were computed independently with a
  // one-off bigint script mirroring the Solidity line-for-line (not by calling this
  // module), then hardcoded here as literals — see docs/decisions/phase-6-liquidator.md.
  const trade = {
    openPrice: 65001_000000000000000000n, // 65001.0, 18 decimals
    collateral: 999_000000n, // 999.0 USDW, 6 decimals
    leverage: 1000n, // 10.00x, 2 decimals
    initialLeverage: 1000n,
    maxLeverage: 10000n, // 100.00x, 2 decimals
    liqMarginThresholdP: 25n,
    rolloverFee: 0n,
    fundingFee: 0n,
  };

  const liqMarginValue = getTradeLiquidationMargin(trade);
  assert.equal(liqMarginValue, 24_975000n); // 24.975 USDW = 25% * (1000/10000) * 999

  const longLiqPrice = getTradeLiquidationPricePure({ ...trade, buy: true });
  assert.equal(longLiqPrice, 58663_402500000000000000n); // 58663.4025

  const shortLiqPrice = getTradeLiquidationPricePure({ ...trade, buy: false });
  assert.equal(shortLiqPrice, 71338_597500000000000000n); // 71338.5975

  // Cross-check: evaluateMargin's price-threshold form agrees with the tradeValue form
  // at a price just past each computed liquidation price.
  const evaluated = evaluateMargin({ ...trade, currentPrice: longLiqPrice - 1_000_000_000_000_000n, buy: true });
  assert.equal(evaluated.liquidatable, true);
});

test('currentPercentProfit caps at MAX_GAIN_P (900%) — never affects the losing side', () => {
  const hugelyProfitable = 10_000_000000000000000000n; // 100x the open price
  const { p, maxPnlP } = currentPercentProfit({
    openPrice: BASE.openPrice,
    currentPrice: hugelyProfitable,
    buy: true,
    leverage: BASE.leverage,
    initialLeverage: BASE.initialLeverage,
  });
  assert.equal(p, maxPnlP);
  assert.equal(maxPnlP, 900n * 1_000_000n * 1000n / 1000n); // MAX_GAIN_P * PRECISION_6 * leverage / leverage
});

test('rolloverFee and fundingFee shift the liquidation price, as they do on-chain', () => {
  const withoutFees = getTradeLiquidationPricePure({ ...BASE, buy: true });
  const withFees = getTradeLiquidationPricePure({ ...BASE, buy: true, rolloverFee: 10_000000n, fundingFee: 5_000000n });
  // More fees owed -> less collateral cushion -> the liquidation price for a long moves
  // *up* (closer to openPrice), since less adverse price movement is now enough to wipe
  // out the (smaller) remaining margin.
  assert.ok(withFees > withoutFees);
});

test('getTradeFundingFeePure mirrors OstiumPairInfos.getTradeFundingFeePure exactly, including the +/-1 floor', () => {
  // accFundingDelta=1e15, collateral*leverage=1000 USDW * 1000(2dp) = 1e12;
  // 1e15 * 1e12 / 1e18 / 100 = 1e9 / 100 = 1e7.
  const fee = getTradeFundingFeePure(0n, 1_000_000_000_000_000n, 1_000_000000n, 1000n);
  assert.equal(fee, 10_000000n);
  // A positive but tiny delta that would truncate to exactly 0 still returns 1, not 0 —
  // the contract's "round in the protocol's favor, never silently charge nothing" floor.
  const tiny = getTradeFundingFeePure(0n, 1n, 1_000_000000n, 1000n);
  assert.equal(tiny, 1n);
  // Same for a tiny negative delta.
  const tinyNeg = getTradeFundingFeePure(0n, -1n, 1_000_000000n, 1000n);
  assert.equal(tinyNeg, 0n);
  // Zero delta is exactly zero.
  assert.equal(getTradeFundingFeePure(5n, 5n, 1_000_000000n, 1000n), 0n);
});

test('isLiquidatableByPrice documents its divergence from isLiquidatable at the exact boundary', () => {
  // At the reverse-solved liquidation price itself, the exact (value-based) predicate
  // says NOT liquidatable...
  const liqPrice = getTradeLiquidationPricePure({ ...BASE, buy: true });
  assert.equal(liqPrice, 90_250000000000000000n);
  const { p } = currentPercentProfit({ ...BASE, currentPrice: liqPrice, buy: true });
  const tradeValue = getTradeValuePure({ ...BASE, percentProfit: p });
  const liqMarginValue = getTradeLiquidationMargin(BASE);
  assert.equal(isLiquidatable(tradeValue, liqMarginValue), false);

  // ...and the strict price-based approximation agrees at this exact fixture (current
  // === liquidationPrice is excluded on both sides) -- but this is an empirical match
  // for this fixture, not a general proof; see the file header note 0 in
  // src/marginEngine.mjs for why the two predicates are not guaranteed bit-identical
  // for every input, which is exactly why liquidatorEngine.mjs never decides off this
  // function alone.
  assert.equal(isLiquidatableByPrice(true, liqPrice, liqPrice), false);
  assert.equal(isLiquidatableByPrice(true, liqPrice - 1n, liqPrice), true);
  assert.equal(isLiquidatableByPrice(true, liqPrice + 1n, liqPrice), false);

  // Short side is mirrored.
  const shortLiqPrice = getTradeLiquidationPricePure({ ...BASE, buy: false });
  assert.equal(isLiquidatableByPrice(false, shortLiqPrice, shortLiqPrice), false);
  assert.equal(isLiquidatableByPrice(false, shortLiqPrice + 1n, shortLiqPrice), true);
  assert.equal(isLiquidatableByPrice(false, shortLiqPrice - 1n, shortLiqPrice), false);
});
