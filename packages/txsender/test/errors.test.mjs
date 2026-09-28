import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlreadyKnown, isNonceTooLow, isUnderpriced, reasonOf } from '../src/errors.mjs';

test('nonce-too-low variants are recognised, including viem-wrapped details', () => {
  assert.equal(isNonceTooLow(new Error('nonce too low')), true);
  assert.equal(isNonceTooLow({ message: 'Execution failed', details: 'nonce too low: next nonce 9, tx nonce 5' }), true);
  assert.equal(isNonceTooLow(new Error('Nonce has already been used')), true);
  assert.equal(isNonceTooLow({ message: 'x', cause: { message: 'NONCE_EXPIRED' } }), true);
  assert.equal(isNonceTooLow(new Error('nonce too high')), false);
  assert.equal(isNonceTooLow(null), false);
});

test('already-known and underpriced are distinct classes', () => {
  assert.equal(isAlreadyKnown(new Error('already known')), true);
  assert.equal(isAlreadyKnown('known transaction: 0xabc'), true);
  assert.equal(isAlreadyKnown(new Error('replacement transaction underpriced')), false);
  assert.equal(isUnderpriced(new Error('replacement transaction underpriced')), true);
  assert.equal(isUnderpriced(new Error('insufficient funds')), false);
});

test('reasonOf keeps one line and prefers viem shortMessage', () => {
  assert.equal(reasonOf({ shortMessage: 'short', message: 'long\nstack' }), 'short');
  assert.equal(reasonOf(new Error('first\nsecond')), 'first');
  assert.equal(reasonOf('plain'), 'plain');
  assert.equal(reasonOf(undefined), 'unknown');
});
