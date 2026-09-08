import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkEma } from '../src/ema.mjs';

test('the EMA is unseeded (null) before the first sample', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  assert.equal(ema.value, null);
});

test('the first sample seeds the EMA directly (no history to smooth against yet)', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n);
  assert.equal(ema.value, 100n);
});

test('windowMs/sampleIntervalMs=10 gives alpha=2/11, matched exactly for a hand-computed step', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  assert.equal(ema.periods, 10);
  assert.equal(ema.alphaNum, 2n);
  assert.equal(ema.alphaDen, 11n);

  ema.update(100n); // seed
  // 100 + (110-100)*2/11 = 100 + floor(20/11) = 100 + 1 = 101
  assert.equal(ema.update(110n), 101n);
  // 101 + (110-101)*2/11 = 101 + floor(18/11) = 101 + 1 = 102
  assert.equal(ema.update(110n), 102n);
});

test('a single large tick is smoothed, not applied in full (cannot trigger a liquidation cascade on its own)', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n);
  const jumped = ema.update(1_000n); // a 10x spike in one sample
  assert.ok(jumped > 100n && jumped < 1_000n, `expected 100 < ${jumped} < 1000`);
  // exact: 100 + (1000-100)*2/11 = 100 + floor(1800/11) = 100 + 163 = 263
  assert.equal(jumped, 263n);
});

test('repeated identical samples converge monotonically toward the sampled value without overshoot', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n);
  let prev = ema.value;
  for (let i = 0; i < 50; i++) {
    const next = ema.update(200n);
    assert.ok(next >= prev, 'must move monotonically toward the target');
    assert.ok(next <= 200n, 'must never overshoot a constant target');
    prev = next;
  }
  // Integer truncation means a tiny-magnitude EMA can permanently stall a few units
  // short of the target (floor((target-value)*alphaNum/alphaDen) hits 0). At the
  // 18-decimal scale real prices use, that residual is worth ~1e-17 of a unit —
  // negligible — but here (unscaled small integers) it is visible, so assert "close",
  // not exact.
  assert.ok(prev >= 195n, `expected convergence close to 200, got ${prev}`);
});

test('at 18-decimal scale, integer-truncation residual is negligible (sub-wei of a dollar)', () => {
  const SCALE = 10n ** 18n;
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n * SCALE);
  let prev = ema.value;
  for (let i = 0; i < 200; i++) {
    prev = ema.update(200n * SCALE);
  }
  const residual = 200n * SCALE - prev;
  assert.ok(residual >= 0n && residual < 1_000_000n, `residual should be dust, got ${residual} (of 1e18 scale)`);
});

test('update(null) leaves the EMA unchanged (no sample this tick, e.g. no healthy venues)', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n);
  assert.equal(ema.update(null), 100n);
  assert.equal(ema.value, 100n);
});

test('reset() clears the EMA back to unseeded', () => {
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(100n);
  ema.reset();
  assert.equal(ema.value, null);
});

test('a shorter window reacts faster than a longer window to the same input sequence', () => {
  const fast = createMarkEma({ windowMs: 2_000, sampleIntervalMs: 1_000 }); // alpha=2/3
  const slow = createMarkEma({ windowMs: 20_000, sampleIntervalMs: 1_000 }); // alpha=2/21
  fast.update(100n);
  slow.update(100n);
  const fastNext = fast.update(200n);
  const slowNext = slow.update(200n);
  assert.ok(fastNext > slowNext, `fast window should move further per tick: ${fastNext} vs ${slowNext}`);
});

test('works with realistic 18-decimal scaled prices, still exact bigint math', () => {
  const SCALE = 10n ** 18n;
  const ema = createMarkEma({ windowMs: 10_000, sampleIntervalMs: 1_000 });
  ema.update(65_000n * SCALE);
  const next = ema.update(65_100n * SCALE);
  // 65000e18 + (100e18)*2/11 = 65000e18 + floor(200e18/11)
  const expected = 65_000n * SCALE + (200n * SCALE) / 11n;
  assert.equal(next, expected);
});
