import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  midOf,
  spreadBpsOf,
  median,
  weightedMedian,
  classifyVenues,
  computeIndex,
  canSignForOrderType,
} from '../src/aggregator.mjs';

const NOW = 1_757_325_600_000;
const SCALE = 10n ** 18n;
const price = (n) => BigInt(Math.round(n * 1e6)) * (SCALE / 1_000_000n); // exact-enough helper for test fixtures

function tick(venue, bid, ask, ts = NOW) {
  return { venue, bid, ask, ts };
}

const BOUNDS = {
  stalenessBoundMs: 2_000,
  spreadWidthBoundBps: 10n,
  deviationBoundBps: 50n,
  minHealthyVenues: 3,
};

// --- mid-price rule ---------------------------------------------------------------

test('midOf is the mid of bid/ask, never last trade', () => {
  const t = tick('binance', price(100), price(102));
  assert.equal(midOf(t), price(101));
});

test('spreadBpsOf computes exact bps of (ask-bid)/mid', () => {
  // bid=100, ask=100.1 -> spread 0.1, mid ~100.05 -> ~9.995 bps, i.e. under 10
  const t = tick('binance', price(100), price(100.1));
  const spread = spreadBpsOf(t);
  assert.ok(spread < 10n, `expected <10bps, got ${spread}`);
});

// --- staleness bound: both directions ----------------------------------------------

test('a tick older than the staleness bound is rejected as stale', () => {
  const t = tick('binance', price(100), price(100.05), NOW - 2_001);
  const { healthy, rejected } = classifyVenues([t], NOW, BOUNDS);
  assert.equal(healthy.length, 0);
  assert.equal(rejected[0].reason, 'stale');
});

test('a tick within the staleness bound is NOT rejected as stale', () => {
  const t = tick('binance', price(100), price(100.05), NOW - 1_999);
  const { healthy, rejected } = classifyVenues([t], NOW, BOUNDS);
  assert.equal(rejected.length, 0);
  assert.equal(healthy.length, 1);
});

// --- spread width bound: both directions -------------------------------------------

test('a tick wider than the spread bound is rejected as wide_spread', () => {
  // ~20 bps spread on a single-venue check (no peers to fail on deviation)
  const t = tick('binance', price(100), price(100.2));
  const { healthy, rejected } = classifyVenues([t], NOW, BOUNDS);
  assert.equal(healthy.length, 0);
  assert.equal(rejected[0].reason, 'wide_spread');
});

test('a tick within the spread bound is NOT rejected as wide_spread', () => {
  // ~5 bps spread
  const t = tick('binance', price(100), price(100.05));
  const { healthy, rejected } = classifyVenues([t], NOW, BOUNDS);
  assert.equal(rejected.length, 0);
  assert.equal(healthy.length, 1);
});

// --- deviation bound vs median of others: both directions ---------------------------

test('a venue that deviates from the median of the others beyond the bound is rejected as deviant', () => {
  const ticks = [
    tick('binance', price(100), price(100.02)),
    tick('bybit', price(100.01), price(100.03)),
    tick('okx', price(102), price(102.02)), // ~2% away -> 200bps, way beyond 50bps
  ];
  const { healthy, rejected } = classifyVenues(ticks, NOW, BOUNDS);
  assert.equal(healthy.length, 2);
  assert.deepEqual(healthy.map((h) => h.tick.venue).sort(), ['binance', 'bybit']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].tick.venue, 'okx');
  assert.equal(rejected[0].reason, 'deviant');
});

test('venues that agree within the deviation bound are NOT rejected as deviant', () => {
  const ticks = [
    tick('binance', price(100), price(100.02)),
    tick('bybit', price(100.01), price(100.03)),
    tick('okx', price(100.02), price(100.04)),
  ];
  const { healthy, rejected } = classifyVenues(ticks, NOW, BOUNDS);
  assert.equal(rejected.length, 0);
  assert.equal(healthy.length, 3);
});

// --- 3-venue minimum + degraded transition ------------------------------------------

test('3 healthy venues is not degraded', () => {
  const ticks = [
    tick('binance', price(100), price(100.02)),
    tick('bybit', price(100.01), price(100.03)),
    tick('okx', price(100.02), price(100.04)),
  ];
  const result = computeIndex(ticks, NOW, BOUNDS);
  assert.equal(result.healthyCount, 3);
  assert.equal(result.degraded, false);
  assert.equal(result.noData, false);
  assert.notEqual(result.index, null);
});

test('2 healthy venues (below the 3-venue minimum) enters degraded mode but still has an index', () => {
  const ticks = [tick('binance', price(100), price(100.02)), tick('bybit', price(100.01), price(100.03))];
  const result = computeIndex(ticks, NOW, BOUNDS);
  assert.equal(result.healthyCount, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.noData, false);
  assert.notEqual(result.index, null);
});

test('0 healthy venues is degraded AND noData (nothing to price with)', () => {
  const result = computeIndex([], NOW, BOUNDS);
  assert.equal(result.healthyCount, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.noData, true);
  assert.equal(result.index, null);
});

test('a venue dropping from 4 healthy to 2 healthy flips degraded from false to true', () => {
  const fourHealthy = [
    tick('binance', price(100), price(100.02)),
    tick('bybit', price(100.01), price(100.03)),
    tick('okx', price(100.02), price(100.04)),
    tick('whitebit', price(99.99), price(100.01)),
  ];
  const before = computeIndex(fourHealthy, NOW, BOUNDS);
  assert.equal(before.degraded, false);

  const twoHealthy = fourHealthy.slice(0, 2);
  const after = computeIndex(twoHealthy, NOW, BOUNDS);
  assert.equal(after.degraded, true);
});

// --- weighted median -----------------------------------------------------------------

test('median: odd count returns the middle value', () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
});

test('median: even count returns the lower of the two middle values', () => {
  assert.equal(median([1n, 2n, 3n, 4n]), 2n);
});

test('weightedMedian with equal weights reduces to plain median', () => {
  const items = [1n, 2n, 3n, 4n, 5n].map((value) => ({ value, weight: 1n }));
  assert.equal(weightedMedian(items), 3n);
});

test('weightedMedian: a heavier venue can shift the result past the unweighted median', () => {
  // values 1,2,3 with weights 1,1,5 -> cumulative*2>=total(7) first at value=3 (weight 5 alone already >= 3.5)
  const items = [
    { value: 1n, weight: 1n },
    { value: 2n, weight: 1n },
    { value: 3n, weight: 5n },
  ];
  assert.equal(weightedMedian(items), 3n);
});

test('weightedMedian returns null for an empty set', () => {
  assert.equal(weightedMedian([]), null);
});

// --- do-not-sign gate (degraded opens blocked, closes allowed) ----------------------

test('MARKET_OPEN is blocked while degraded', () => {
  const aggregate = { noData: false, degraded: true };
  assert.deepEqual(canSignForOrderType('MARKET_OPEN', aggregate), { ok: false, reason: 'degraded_opens_blocked' });
});

test('LIMIT_OPEN is blocked while degraded', () => {
  const aggregate = { noData: false, degraded: true };
  assert.equal(canSignForOrderType('LIMIT_OPEN', aggregate).ok, false);
});

test('MARKET_CLOSE is allowed while degraded (closes must not trap positions)', () => {
  const aggregate = { noData: false, degraded: true };
  assert.deepEqual(canSignForOrderType('MARKET_CLOSE', aggregate), { ok: true });
});

test('REMOVE_COLLATERAL is allowed while degraded', () => {
  const aggregate = { noData: false, degraded: true };
  assert.equal(canSignForOrderType('REMOVE_COLLATERAL', aggregate).ok, true);
});

test('MARKET_OPEN is allowed when healthy (not degraded)', () => {
  const aggregate = { noData: false, degraded: false };
  assert.deepEqual(canSignForOrderType('MARKET_OPEN', aggregate), { ok: true });
});

test('every order type is blocked when there is no data at all, even closes', () => {
  const aggregate = { noData: true, degraded: true };
  assert.equal(canSignForOrderType('MARKET_OPEN', aggregate).ok, false);
  assert.equal(canSignForOrderType('MARKET_CLOSE', aggregate).ok, false);
  assert.equal(canSignForOrderType('MARKET_CLOSE', aggregate).reason, 'no_healthy_venues');
});
