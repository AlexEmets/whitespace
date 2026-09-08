import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalTo18, formatFixed18, bpsOf, deviationBps, PRICE_SCALE } from '../src/decimal.mjs';

test('parseDecimalTo18 scales a known integer price exactly (65000.00 -> 65000e18)', () => {
  assert.equal(parseDecimalTo18('65000'), 65_000_000_000_000_000_000_000n);
  assert.equal(parseDecimalTo18('65000.00'), 65_000_000_000_000_000_000_000n);
});

test('parseDecimalTo18 scales a fractional price exactly', () => {
  // 65000.5 * 1e18
  assert.equal(parseDecimalTo18('65000.5'), 65_000_500_000_000_000_000_000n);
});

test('parseDecimalTo18 truncates (never rounds) beyond 18 fractional digits', () => {
  const value = parseDecimalTo18('1.1234567890123456789999');
  assert.equal(value, 1_123456789012345678n);
});

test('parseDecimalTo18 handles negative values', () => {
  assert.equal(parseDecimalTo18('-0.5'), -500_000_000_000_000_000n);
});

test('parseDecimalTo18 rejects non-numeric input', () => {
  assert.throws(() => parseDecimalTo18('not-a-number'));
  assert.throws(() => parseDecimalTo18(''));
});

test('formatFixed18 round-trips a whole and a fractional value', () => {
  assert.equal(formatFixed18(65_000_000_000_000_000_000_000n), '65000');
  assert.equal(formatFixed18(65_000_500_000_000_000_000_000n), '65000.5');
  assert.equal(formatFixed18(-500_000_000_000_000_000n), '-0.5');
});

test('bpsOf computes exact integer basis points', () => {
  // 10 / 10000 = 0.1% = 10 bps
  assert.equal(bpsOf(10n * PRICE_SCALE, 10_000n * PRICE_SCALE), 10n);
  assert.equal(bpsOf(0n, 100n), 0n);
});

test('bpsOf returns null for a non-positive denominator', () => {
  assert.equal(bpsOf(1n, 0n), null);
  assert.equal(bpsOf(1n, -1n), null);
});

test('deviationBps is symmetric in sign (uses absolute difference)', () => {
  const ref = 100n * PRICE_SCALE;
  const above = 101n * PRICE_SCALE; // +1%
  const below = 99n * PRICE_SCALE; // -1%
  assert.equal(deviationBps(above, ref), 100n);
  assert.equal(deviationBps(below, ref), 100n);
});
