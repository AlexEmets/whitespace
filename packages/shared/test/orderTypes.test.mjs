import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTypeName, ORDER_TYPE_NAMES } from '../src/orderTypes.mjs';

test('orderTypeName matches the on-chain enum order exactly', () => {
  assert.equal(orderTypeName(0), 'MARKET_OPEN');
  assert.equal(orderTypeName(1), 'MARKET_CLOSE');
  assert.equal(orderTypeName(2), 'LIMIT_OPEN');
  assert.equal(orderTypeName(3), 'LIMIT_CLOSE');
  assert.equal(orderTypeName(4), 'REMOVE_COLLATERAL');
});

test('orderTypeName accepts a bigint (as decoded from a log topic/data)', () => {
  assert.equal(orderTypeName(0n), 'MARKET_OPEN');
  assert.equal(orderTypeName(4n), 'REMOVE_COLLATERAL');
});

test('orderTypeName rejects an out-of-range value', () => {
  assert.throws(() => orderTypeName(5));
  assert.throws(() => orderTypeName(-1));
});

test('ORDER_TYPE_NAMES has exactly the 5 on-chain variants', () => {
  assert.equal(ORDER_TYPE_NAMES.length, 5);
});
