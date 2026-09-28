import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSlHit,
  isTpHit,
  isOpenOrderHit,
  openOrderTpSlReached,
  isTradeableQuote,
  evaluateCloseTriggers,
  evaluateOpenTrigger,
} from '../src/triggerRules.mjs';

const E18 = 10n ** 18n;
const STATIC = { priceImpactK: 0n, netVolThreshold: 0n, decayRate: 0n, buyVolume: 0n, sellVolume: 0n, lastUpdateTimestamp: 0n };
const NO_FEES = { takerFeeP: 0n, oracleFee: 0n, builder: '0x0000000000000000000000000000000000000000', builderFee: 0n };

test('SL (lib :419-422): long hits at price <= sl, short at price >= sl, sl == 0 never', () => {
  const sl = 90n * E18;
  assert.equal(isSlHit({ sl, buy: true, price: sl }), true, 'long, exactly at sl');
  assert.equal(isSlHit({ sl, buy: true, price: sl - 1n }), true);
  assert.equal(isSlHit({ sl, buy: true, price: sl + 1n }), false);
  assert.equal(isSlHit({ sl, buy: false, price: sl }), true, 'short, exactly at sl');
  assert.equal(isSlHit({ sl, buy: false, price: sl + 1n }), true);
  assert.equal(isSlHit({ sl, buy: false, price: sl - 1n }), false);
  assert.equal(isSlHit({ sl: 0n, buy: true, price: 0n }), false);
  assert.equal(isSlHit({ sl: 0n, buy: false, price: 10n ** 30n }), false);
});

test('TP (lib :415-418): long hits at fill >= tp, short at fill <= tp, tp == 0 never', () => {
  const tp = 110n * E18;
  assert.equal(isTpHit({ tp, buy: true, priceAfterImpact: tp }), true);
  assert.equal(isTpHit({ tp, buy: true, priceAfterImpact: tp - 1n }), false);
  assert.equal(isTpHit({ tp, buy: false, priceAfterImpact: tp }), true);
  assert.equal(isTpHit({ tp, buy: false, priceAfterImpact: tp + 1n }), false);
  assert.equal(isTpHit({ tp: 0n, buy: true, priceAfterImpact: 10n ** 30n }), false);
  assert.equal(isTpHit({ tp: 0n, buy: false, priceAfterImpact: 0n }), false);
});

test('LIMIT entries (lib :364-368) compare the fill after impact; STOP entries compare the raw price', () => {
  const t = 100n * E18;
  assert.equal(isOpenOrderHit({ orderType: 'LIMIT', buy: true, targetPrice: t, price: 0n, priceAfterImpact: t }), true);
  assert.equal(isOpenOrderHit({ orderType: 'LIMIT', buy: true, targetPrice: t, price: 0n, priceAfterImpact: t + 1n }), false);
  assert.equal(isOpenOrderHit({ orderType: 'LIMIT', buy: false, targetPrice: t, price: 0n, priceAfterImpact: t }), true);
  assert.equal(isOpenOrderHit({ orderType: 'LIMIT', buy: false, targetPrice: t, price: 0n, priceAfterImpact: t - 1n }), false);
  assert.equal(isOpenOrderHit({ orderType: 'STOP', buy: true, targetPrice: t, price: t, priceAfterImpact: 0n }), true);
  assert.equal(isOpenOrderHit({ orderType: 'STOP', buy: true, targetPrice: t, price: t - 1n, priceAfterImpact: 10n ** 30n }), false);
  assert.equal(isOpenOrderHit({ orderType: 'STOP', buy: false, targetPrice: t, price: t, priceAfterImpact: 10n ** 30n }), true);
  assert.equal(isOpenOrderHit({ orderType: 'STOP', buy: false, targetPrice: t, price: t + 1n, priceAfterImpact: 0n }), false);
  assert.throws(() => isOpenOrderHit({ orderType: 'MARKET', buy: true, targetPrice: t, price: t, priceAfterImpact: t }), /unknown/);
});

test('open-order TP/SL already reached at the fill (lib :370-378)', () => {
  const p = 100n * E18;
  assert.equal(openOrderTpSlReached({ tp: p, sl: 0n, buy: true, priceAfterImpact: p }), 'TP_REACHED');
  assert.equal(openOrderTpSlReached({ tp: p + 1n, sl: 0n, buy: true, priceAfterImpact: p }), null);
  assert.equal(openOrderTpSlReached({ tp: 0n, sl: p, buy: true, priceAfterImpact: p }), 'SL_REACHED');
  assert.equal(openOrderTpSlReached({ tp: p, sl: 0n, buy: false, priceAfterImpact: p }), 'TP_REACHED');
  assert.equal(openOrderTpSlReached({ tp: 0n, sl: p, buy: false, priceAfterImpact: p }), 'SL_REACHED');
  assert.equal(openOrderTpSlReached({ tp: 0n, sl: p + 1n, buy: false, priceAfterImpact: p }), null);
});

test('a quote with any side <= 0 is not tradeable (MARKET_CLOSED)', () => {
  assert.equal(isTradeableQuote({ price: 1n, bid: 1n, ask: 1n }), true);
  assert.equal(isTradeableQuote({ price: 0n, bid: 1n, ask: 1n }), false);
  assert.equal(isTradeableQuote({ price: 1n, bid: 0n, ask: 1n }), false);
  assert.equal(isTradeableQuote({ price: 1n, bid: 1n, ask: -1n }), false);
});

// Same fixture as marginEngine.test.mjs: 1000 USDW, 10x, 100x max, 25% threshold.
// Long liquidation boundary: 90.25.
const TRADE = {
  collateral: 1_000_000000n,
  leverage: 1000n,
  openPrice: 100n * E18,
  buy: true,
  tp: 0n,
  sl: 0n,
  initialLeverage: 1000n,
  rolloverFee: 0n,
  fundingFee: 0n,
};
const margin = { maxLeverage: 10000n, liqMarginThresholdP: 25n, blockTimestamp: 0n };
const at = (price, bid = price, ask = price) => ({ price, bid, ask, impact: STATIC });

test('evaluateCloseTriggers LIQ: strict < at the exact boundary, from the mark', () => {
  assert.equal(evaluateCloseTriggers({ trade: TRADE, market: at(90_250000000000000000n), ...margin }).liq, false);
  assert.equal(evaluateCloseTriggers({ trade: TRADE, market: at(90_249999000000000000n), ...margin }).liq, true);
  // Bid/ask far away do not matter for LIQ: the callback uses a.price (:534-546).
  assert.equal(evaluateCloseTriggers({ trade: TRADE, market: at(90_250000000000000000n, 1n, 1n), ...margin }).liq, false);
});

test('evaluateCloseTriggers TP on a long uses the bid (close fill), not the mark', () => {
  const trade = { ...TRADE, tp: 110n * E18 };
  // mark above tp, bid below -> not hit
  assert.equal(evaluateCloseTriggers({ trade, market: at(111n * E18, 109n * E18, 112n * E18), ...margin }).tp, false);
  // bid exactly at tp -> hit, even with the mark below it
  assert.equal(evaluateCloseTriggers({ trade, market: at(109n * E18, 110n * E18, 111n * E18), ...margin }).tp, true);
});

test('evaluateCloseTriggers TP on a short uses the ask', () => {
  const trade = { ...TRADE, buy: false, tp: 90n * E18 };
  assert.equal(evaluateCloseTriggers({ trade, market: at(89n * E18, 88n * E18, 91n * E18), ...margin }).tp, false);
  assert.equal(evaluateCloseTriggers({ trade, market: at(91n * E18, 89n * E18, 90n * E18), ...margin }).tp, true);
});

test('evaluateCloseTriggers SL uses the mark, not bid/ask', () => {
  const long = { ...TRADE, sl: 95n * E18 };
  assert.equal(evaluateCloseTriggers({ trade: long, market: at(96n * E18, 94n * E18, 94n * E18), ...margin }).sl, false);
  assert.equal(evaluateCloseTriggers({ trade: long, market: at(95n * E18, 99n * E18, 99n * E18), ...margin }).sl, true);
  const short = { ...TRADE, buy: false, sl: 105n * E18 };
  assert.equal(evaluateCloseTriggers({ trade: short, market: at(104n * E18, 106n * E18, 106n * E18), ...margin }).sl, false);
  assert.equal(evaluateCloseTriggers({ trade: short, market: at(105n * E18, 100n * E18, 100n * E18), ...margin }).sl, true);
});

const ORDER = { orderType: 'LIMIT', buy: true, targetPrice: 100n * E18, tp: 0n, sl: 0n, collateral: 1_000_000000n, leverage: 1000n };

test('evaluateOpenTrigger LIMIT buy fills at the ask: hit when ask <= target', () => {
  assert.equal(evaluateOpenTrigger({ order: ORDER, market: at(99n * E18, 99n * E18, 100n * E18), fees: NO_FEES, blockTimestamp: 0n }).hit, true);
  const miss = evaluateOpenTrigger({ order: ORDER, market: at(99n * E18, 98n * E18, 100n * E18 + 1n), fees: NO_FEES, blockTimestamp: 0n });
  assert.equal(miss.hit, false);
  assert.equal(miss.reason, 'not_hit');
});

test('evaluateOpenTrigger LIMIT sell fills at the bid: hit when bid >= target', () => {
  const order = { ...ORDER, buy: false };
  assert.equal(evaluateOpenTrigger({ order, market: at(101n * E18, 100n * E18, 102n * E18), fees: NO_FEES, blockTimestamp: 0n }).hit, true);
  assert.equal(evaluateOpenTrigger({ order, market: at(101n * E18, 100n * E18 - 1n, 102n * E18), fees: NO_FEES, blockTimestamp: 0n }).hit, false);
});

test('evaluateOpenTrigger STOP uses the mark', () => {
  const buyStop = { ...ORDER, orderType: 'STOP' };
  assert.equal(evaluateOpenTrigger({ order: buyStop, market: at(100n * E18, 1n, 1n), fees: NO_FEES, blockTimestamp: 0n }).hit, true);
  assert.equal(evaluateOpenTrigger({ order: buyStop, market: at(100n * E18 - 1n, 200n * E18, 200n * E18), fees: NO_FEES, blockTimestamp: 0n }).hit, false);
  const sellStop = { ...ORDER, orderType: 'STOP', buy: false };
  assert.equal(evaluateOpenTrigger({ order: sellStop, market: at(100n * E18, 200n * E18, 200n * E18), fees: NO_FEES, blockTimestamp: 0n }).hit, true);
  assert.equal(evaluateOpenTrigger({ order: sellStop, market: at(100n * E18 + 1n, 1n, 1n), fees: NO_FEES, blockTimestamp: 0n }).hit, false);
});

test('evaluateOpenTrigger: hit but the fill already crosses the order TP -> not triggerable', () => {
  const order = { ...ORDER, tp: 99n * E18 };
  const r = evaluateOpenTrigger({ order, market: at(99n * E18, 99n * E18, 99n * E18), fees: NO_FEES, blockTimestamp: 0n });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'TP_REACHED');
});

test('evaluateOpenTrigger: fees larger than the collateral can never fill', () => {
  const r = evaluateOpenTrigger({ order: ORDER, market: at(90n * E18), fees: { ...NO_FEES, oracleFee: 2_000_000000n }, blockTimestamp: 0n });
  assert.equal(r.hit, false);
  assert.equal(r.reason, 'fees_exceed_collateral');
});
