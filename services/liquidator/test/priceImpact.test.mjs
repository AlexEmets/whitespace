import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDynamicTradePriceImpact,
  decayVolumeWithPade,
  getEffectiveDecayRate,
  calculatePostFeeCollateral,
  FULL_IMPACT_P,
} from '../src/priceImpact.mjs';

const E18 = 10n ** 18n;
const STATIC = { priceImpactK: 0n, netVolThreshold: 0n, decayRate: 0n, buyVolume: 0n, sellVolume: 0n, lastUpdateTimestamp: 0n };
const QUOTE = { price: 100n * E18, bid: 99n * E18, ask: 101n * E18 };
const SIZE = { collateral: 1_000_000000n, leverage: 1000n }; // 1000 USDW at 10x -> 10_000e18 notional

function pai(isOpen, buy, impact = STATIC, extra = {}) {
  return getDynamicTradePriceImpact({ ...QUOTE, ...SIZE, isOpen, buy, impact, blockTimestamp: 0n, ...extra });
}

test('static path (priceImpactK == 0): open long and close short fill at the ask, the other two at the bid', () => {
  assert.equal(pai(true, true).priceAfterImpact, QUOTE.ask);
  assert.equal(pai(false, false).priceAfterImpact, QUOTE.ask);
  assert.equal(pai(true, false).priceAfterImpact, QUOTE.bid);
  assert.equal(pai(false, true).priceAfterImpact, QUOTE.bid);
  assert.equal(pai(false, true).isDynamic, false);
  // |100 - 99| * 1e18 * 100 / 100 = 1e18 (1%)
  assert.equal(pai(false, true).priceImpactP, E18);
});

test('static path with price 0 returns (0, 0) like _getTradePriceImpact', () => {
  const r = pai(false, true, STATIC, { price: 0n });
  assert.equal(r.priceAfterImpact, 0n);
  assert.equal(r.priceImpactP, 0n);
});

test('dynamic path below the volume threshold: only half the spread, applied to the mark', () => {
  const impact = { ...STATIC, priceImpactK: 1n, netVolThreshold: 10n ** 30n };
  // spread = 2e18 * 1e18 * 100 / 200e18 = 1e18 (1%)
  assert.equal(pai(false, true, impact).priceAfterImpact, 99n * E18); // close long: 100 * (1 - 0.01)
  assert.equal(pai(false, false, impact).priceAfterImpact, 101n * E18); // close short: 100 * (1 + 0.01)
  assert.equal(pai(false, true, impact).isDynamic, true);
});

test('dynamic path, quadratic branch (initial volume below threshold), computed by hand', () => {
  // K = 1e21, threshold = 1000e18, size = 10_000e18, initial = 0:
  // excess = 9000e18; dyn = 1e21 * (9000e18)^2 * 100 / (2 * 10_000e18) / 1e27 = 4.05e17 (0.405%)
  const impact = { ...STATIC, priceImpactK: 10n ** 21n, netVolThreshold: 1000n * E18 };
  const r = getDynamicTradePriceImpact({
    price: 100n * E18, bid: 100n * E18, ask: 100n * E18, ...SIZE, isOpen: true, buy: true, impact, blockTimestamp: 0n,
  });
  assert.equal(r.priceImpactP, 405_000000000000000n);
  assert.equal(r.priceAfterImpact, 100_405000000000000000n);
});

test('dynamic path, linear branch (initial volume at/above threshold) reads the right side volume', () => {
  // open long reads buyVolume; dyn = 1e21 * (2000e18 - 1000e18 + 5000e18) * 100 / 1e27 = 6e17 (0.6%)
  const impact = { ...STATIC, priceImpactK: 10n ** 21n, netVolThreshold: 1000n * E18, buyVolume: 2000n * E18, sellVolume: 2000n * E18 };
  const flat = { price: 100n * E18, bid: 100n * E18, ask: 100n * E18, ...SIZE, impact, blockTimestamp: 0n };
  assert.equal(getDynamicTradePriceImpact({ ...flat, isOpen: true, buy: true }).priceImpactP, 600_000000000000000n);
  // closing a long reads sellVolume (buy != isOpen): same volume here, below-spot
  assert.equal(getDynamicTradePriceImpact({ ...flat, isOpen: false, buy: true }).priceAfterImpact, 99_400000000000000000n);
});

test('below-spot impact of 100% or more clamps the fill to 0', () => {
  const impact = { ...STATIC, priceImpactK: 10n ** 27n, netVolThreshold: 0n };
  const r = getDynamicTradePriceImpact({
    price: 100n * E18, bid: 100n * E18, ask: 100n * E18, ...SIZE, isOpen: false, buy: true, impact, blockTimestamp: 0n,
  });
  assert.equal(r.priceAfterImpact, 0n);
  assert.equal(r.priceImpactP, FULL_IMPACT_P);
});

test('Padé decay: (1 - h)/(1 + h) with h = rate*dt/2, exact integer result', () => {
  // rate 1e16/s, dt 10s -> h = 5e16; mult = 0.95e36 / 1.05e18 = 904761904761904761
  assert.equal(decayVolumeWithPade(1000n * E18, 10n, 10n ** 16n), 904761904761904761000n);
  assert.equal(decayVolumeWithPade(1000n * E18, 0n, 10n ** 16n), 1000n * E18, 'dt 0 is a no-op');
  assert.equal(decayVolumeWithPade(1000n * E18, 1000n, 10n ** 16n), 0n, 'floored at 0');
});

test('effective decay rate: /3 with no threshold, slowed by imbalance, capped at 3x', () => {
  assert.equal(getEffectiveDecayRate(0n, 0n, 3n * E18, 0n), E18);
  assert.equal(getEffectiveDecayRate(10n, 10n, E18, 5n), E18, 'balanced: unchanged');
  assert.equal(getEffectiveDecayRate(20n, 0n, E18, 10n), E18 / 2n, '2x over threshold halves it');
  assert.equal(getEffectiveDecayRate(1000n, 0n, 3n * E18, 10n), E18, 'capped at MAX_DECAY_FACTOR');
});

test('the decay is applied between lastUpdateTimestamp and the evaluation time', () => {
  const impact = { ...STATIC, priceImpactK: 10n ** 21n, netVolThreshold: 1000n * E18, buyVolume: 2000n * E18, lastUpdateTimestamp: 100n, decayRate: 10n ** 16n };
  const flat = { price: 100n * E18, bid: 100n * E18, ask: 100n * E18, ...SIZE, impact, isOpen: true, buy: true };
  const fresh = getDynamicTradePriceImpact({ ...flat, blockTimestamp: 100n });
  const later = getDynamicTradePriceImpact({ ...flat, blockTimestamp: 110n });
  const before = getDynamicTradePriceImpact({ ...flat, blockTimestamp: 50n });
  assert.ok(later.priceImpactP < fresh.priceImpactP);
  assert.equal(before.priceImpactP, fresh.priceImpactP, 'a timestamp before the last update decays nothing');
});

test('calculatePostFeeCollateral: taker fee + oracle fee + builder fee, and the underflow case', () => {
  const base = { collateral: 1_000_000000n, leverage: 1000n, takerFeeP: 50_000n, oracleFee: 1_000000n };
  const zero = '0x0000000000000000000000000000000000000000';
  // opening fee = 10_000e6 * 50_000 / 1e6 / 100 = 5e6
  assert.equal(calculatePostFeeCollateral({ ...base, builder: zero, builderFee: 100_000n }), 994_000000n, 'no builder address: no builder fee');
  // builder fee = 100_000 * 10_000e6 / 1e6 / 100 = 10e6
  assert.equal(calculatePostFeeCollateral({ ...base, builder: '0x' + '22'.repeat(20), builderFee: 100_000n }), 984_000000n);
  assert.equal(calculatePostFeeCollateral({ ...base, takerFeeP: 0n, oracleFee: 1_000_000000n, builder: zero, builderFee: 0n }), 0n, 'fees == collateral is 0, not an underflow');
  assert.equal(calculatePostFeeCollateral({ ...base, takerFeeP: 0n, oracleFee: 1_000_000001n, builder: zero, builderFee: 0n }), null);
});
