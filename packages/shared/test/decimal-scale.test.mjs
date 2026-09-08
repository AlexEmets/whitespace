import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString, parseDecimalToBigInt, SCALE } from '../src/decimal.mjs';

test('toDecimalString formats the real proof-trade open price at 18 decimals', () => {
  assert.equal(toDecimalString(65001000000000000000000n, SCALE.PRICE), '65001.000000000000000000');
});

test('toDecimalString formats the real proof-trade collateral at 6 decimals', () => {
  assert.equal(toDecimalString(999000000n, SCALE.COLLATERAL), '999.000000');
});

test('toDecimalString formats leverage at 2 decimals (1000 -> 10.00x)', () => {
  assert.equal(toDecimalString(1000n, SCALE.LEVERAGE), '10.00');
});

test('toDecimalString keeps a value that is not an exact whole number', () => {
  assert.equal(toDecimalString(65001500000000000000000n, SCALE.PRICE), '65001.500000000000000000');
});

test('toDecimalString handles negative values (e.g. percentProfit)', () => {
  assert.equal(toDecimalString(-30768n, SCALE.PRICE), '-0.000000000000030768');
});

test('toDecimalString handles zero', () => {
  assert.equal(toDecimalString(0n, SCALE.COLLATERAL), '0.000000');
});

test('toDecimalString accepts numeric strings as returned by node-postgres', () => {
  assert.equal(toDecimalString('999000000', SCALE.COLLATERAL), '999.000000');
});

test('toDecimalString never produces a value that round-trips through Number() losslessly-failing input', () => {
  // 2^53 + 1 cannot be represented exactly as a JS number; if this function
  // ever routed through Number(), this would silently round to ...52.
  const raw = 9007199254740993n; // 2^53 + 1
  const asNumber = Number(raw);
  assert.notEqual(BigInt(asNumber), raw, 'sanity: Number() really does lose precision here');
  assert.equal(toDecimalString(raw, 0), '9007199254740993');
});

test('parseDecimalToBigInt is the exact inverse of toDecimalString', () => {
  const raw = 65001000000000000000000n;
  const s = toDecimalString(raw, SCALE.PRICE);
  assert.equal(parseDecimalToBigInt(s, SCALE.PRICE), raw);
});

test('parseDecimalToBigInt round-trips a fractional collateral value', () => {
  assert.equal(parseDecimalToBigInt('999.5', SCALE.COLLATERAL), 999500000n);
});

test('parseDecimalToBigInt rejects more fractional digits than the scale supports', () => {
  assert.throws(() => parseDecimalToBigInt('1.1234567', SCALE.COLLATERAL), RangeError);
});

test('parseDecimalToBigInt rejects non-decimal input (no exponents, no commas)', () => {
  assert.throws(() => parseDecimalToBigInt('1e10', SCALE.PRICE), TypeError);
  assert.throws(() => parseDecimalToBigInt('1,000', SCALE.PRICE), TypeError);
});
