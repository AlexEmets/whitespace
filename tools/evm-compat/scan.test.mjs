import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBytecode } from './scan.mjs';

test('accepts bytecode with no Cancun opcodes', () => {
  // PUSH1 0x01, PUSH1 0x00, MSTORE, STOP
  assert.deepEqual(scanBytecode('0x600160005200'), []);
});

test('accepts PUSH0, which is Shanghai and allowed', () => {
  // PUSH0, POP, STOP
  assert.deepEqual(scanBytecode('0x5f5000'), []);
});

test('detects a real TSTORE', () => {
  // PUSH1 0x00, PUSH1 0x00, TSTORE
  assert.deepEqual(scanBytecode('0x600060005d'), [{ offset: 4, opcode: 'TSTORE' }]);
});

test('detects TLOAD and MCOPY', () => {
  assert.deepEqual(scanBytecode('0x5c'), [{ offset: 0, opcode: 'TLOAD' }]);
  assert.deepEqual(scanBytecode('0x5e'), [{ offset: 0, opcode: 'MCOPY' }]);
});

test('does NOT report forbidden bytes inside PUSH immediates', () => {
  // PUSH2 0x5d5d  -> the two 0x5d bytes are data, not opcodes
  assert.deepEqual(scanBytecode('0x615d5d'), []);
});

test('does NOT report a forbidden byte inside PUSH32 immediate data', () => {
  const immediate = '5c'.repeat(32);
  assert.deepEqual(scanBytecode('0x7f' + immediate), []);
});

test('handles a truncated trailing PUSH without throwing', () => {
  // PUSH32 with only one immediate byte present
  assert.deepEqual(scanBytecode('0x7f5c'), []);
});

test('tolerates empty and 0x-only input', () => {
  assert.deepEqual(scanBytecode('0x'), []);
  assert.deepEqual(scanBytecode(''), []);
});
