import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketStart, applyTick, INTERVAL_SECONDS, INTERVALS } from '../src/candles.mjs';

test('bucketStart floors to the interval boundary (1m)', () => {
  assert.equal(bucketStart(90, '1m'), 60);
  assert.equal(bucketStart(59, '1m'), 0);
  assert.equal(bucketStart(60, '1m'), 60);
});

test('bucketStart floors to the interval boundary (1h)', () => {
  const oneHour = INTERVAL_SECONDS['1h'];
  assert.equal(bucketStart(oneHour + 1, '1h'), oneHour);
  assert.equal(bucketStart(oneHour - 1, '1h'), 0);
});

test('bucketStart is idempotent exactly at a boundary for every supported interval', () => {
  for (const interval of INTERVALS) {
    const len = INTERVAL_SECONDS[interval];
    assert.equal(bucketStart(len * 7, interval), len * 7, `interval=${interval}`);
  }
});

test('bucketStart rejects an unknown interval', () => {
  assert.throws(() => bucketStart(0, '2m'), TypeError);
});

test('a tick one second before the next bucket stays in the current bucket', () => {
  const len = INTERVAL_SECONDS['5m'];
  assert.equal(bucketStart(len * 3 - 1, '5m'), len * 2);
});

test('a tick exactly on the next bucket boundary moves to the next bucket', () => {
  const len = INTERVAL_SECONDS['5m'];
  assert.equal(bucketStart(len * 3, '5m'), len * 3);
});

test('applyTick seeds open=high=low=close on the first tick in a bucket', () => {
  const c = applyTick(null, 65001000000000000000000n, 100n);
  assert.deepEqual(c, {
    open: 65001000000000000000000n,
    high: 65001000000000000000000n,
    low: 65001000000000000000000n,
    close: 65001000000000000000000n,
    volume: 100n,
  });
});

test('applyTick raises high and moves close on an up-tick, low unchanged', () => {
  const seed = applyTick(null, 100n, 10n);
  const next = applyTick(seed, 110n, 5n);
  assert.deepEqual(next, { open: 100n, high: 110n, low: 100n, close: 110n, volume: 15n });
});

test('applyTick lowers low and moves close on a down-tick, high unchanged', () => {
  const seed = applyTick(null, 100n, 10n);
  const next = applyTick(seed, 90n, 5n);
  assert.deepEqual(next, { open: 100n, high: 100n, low: 90n, close: 90n, volume: 15n });
});

test('applyTick never changes open across multiple ticks', () => {
  let c = applyTick(null, 100n, 1n);
  c = applyTick(c, 200n, 1n);
  c = applyTick(c, 50n, 1n);
  c = applyTick(c, 120n, 1n);
  assert.equal(c.open, 100n);
  assert.equal(c.close, 120n);
  assert.equal(c.high, 200n);
  assert.equal(c.low, 50n);
  assert.equal(c.volume, 4n);
});
