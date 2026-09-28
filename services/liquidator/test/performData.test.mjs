import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import { encodePerformData } from '../src/performData.mjs';
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

const decode = (data) => decodeAbiParameters([SIMPLIFIED_TRADE_ID_ARRAY, { type: 'uint256' }], data);

test('encodes one trigger as a single-element SimplifiedTradeId[], round-trips exactly', () => {
  const performData = encodePerformData([{ trader: TRADER, pairIndex: 0, index: 3, limitOrder: LimitOrder.LIQ }], 1_757_325_600);
  const [trades, timestamp] = decode(performData);

  assert.equal(trades.length, 1);
  assert.equal(trades[0].trader.toLowerCase(), TRADER);
  assert.equal(trades[0].pairId, 0n);
  assert.equal(trades[0].index, 3n);
  assert.equal(trades[0].limitOrder, LimitOrder.LIQ);
  assert.equal(timestamp, 1_757_325_600n);
});

test('encodes a mixed batch of every automation kind in one payload, preserving order', () => {
  const kinds = [LimitOrder.TP, LimitOrder.SL, LimitOrder.LIQ, LimitOrder.OPEN];
  const performData = encodePerformData(
    kinds.map((limitOrder, i) => ({ trader: TRADER, pairIndex: i, index: i + 1, limitOrder })),
    100,
  );
  const [trades] = decode(performData);

  assert.deepEqual(
    trades.map((t) => [t.pairId, t.index, t.limitOrder]),
    [
      [0n, 1n, 0],
      [1n, 2n, 1],
      [2n, 3n, 2],
      [3n, 4n, 3],
    ],
  );
});

test('refuses kinds the bot never triggers (REMOVE_COLLATERAL and PENDING_CLOSE would revert the whole batch)', () => {
  for (const limitOrder of [LimitOrder.CLOSE_DAY_TRADE, LimitOrder.REMOVE_COLLATERAL, LimitOrder.PENDING_CLOSE, 99, undefined]) {
    assert.throws(() => encodePerformData([{ trader: TRADER, pairIndex: 0, index: 0, limitOrder }], 1), /unsupported limitOrder/);
  }
});

test('encodes an empty list without throwing', () => {
  const [trades] = decode(encodePerformData([], 100));
  assert.equal(trades.length, 0);
});
