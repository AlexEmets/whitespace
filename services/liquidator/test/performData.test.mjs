import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import { encodeLiquidationPerformData } from '../src/performData.mjs';
import { LimitOrder } from '../src/abi.mjs';

const TRADER = '0x1111111111111111111111111111111111111111';

const SIMPLIFIED_TRADE_ID_ARRAY = {
  type: 'tuple[]',
  components: [
    { name: 'trader', type: 'address' },
    { name: 'pairId', type: 'uint256' },
    { name: 'index', type: 'uint256' },
    { name: 'limitOrder', type: 'uint8' },
  ],
};

test('encodes one candidate as a single-element SimplifiedTradeId[] with LimitOrder.LIQ, round-trips exactly', () => {
  const performData = encodeLiquidationPerformData([{ trader: TRADER, pairIndex: 0, index: 3 }], 1_757_325_600);
  const [trades, timestamp] = decodeAbiParameters([SIMPLIFIED_TRADE_ID_ARRAY, { type: 'uint256' }], performData);

  assert.equal(trades.length, 1);
  assert.equal(trades[0].trader.toLowerCase(), TRADER);
  assert.equal(trades[0].pairId, 0n);
  assert.equal(trades[0].index, 3n);
  assert.equal(trades[0].limitOrder, LimitOrder.LIQ);
  assert.equal(timestamp, 1_757_325_600n);
});

test('encodes multiple candidates in one performData payload, preserving order', () => {
  const candidates = [
    { trader: TRADER, pairIndex: 0, index: 0 },
    { trader: TRADER, pairIndex: 1, index: 2 },
  ];
  const performData = encodeLiquidationPerformData(candidates, 100);
  const [trades] = decodeAbiParameters([SIMPLIFIED_TRADE_ID_ARRAY, { type: 'uint256' }], performData);

  assert.equal(trades.length, 2);
  assert.equal(trades[0].pairId, 0n);
  assert.equal(trades[1].pairId, 1n);
  assert.equal(trades[1].index, 2n);
});

test('encodes an empty candidate list without throwing', () => {
  const performData = encodeLiquidationPerformData([], 100);
  const [trades] = decodeAbiParameters([SIMPLIFIED_TRADE_ID_ARRAY, { type: 'uint256' }], performData);
  assert.equal(trades.length, 0);
});
