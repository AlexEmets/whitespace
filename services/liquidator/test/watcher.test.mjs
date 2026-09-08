import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenEvent } from '../src/watcher.mjs';

const TRADER = '0x1111111111111111111111111111111111111111';

test('toOpenEvent extracts (trader, pairIndex, index, blockNumber) from a MarketOpenExecuted-shaped log', () => {
  const log = {
    args: {
      orderId: 5n,
      t: {
        collateral: 999_000000n,
        openPrice: 65001_000000000000000000n,
        tp: 0n,
        sl: 0n,
        trader: TRADER,
        leverage: 1000,
        pairIndex: 0,
        index: 2,
        buy: true,
        isDayTrade: false,
      },
      priceImpactP: 0n,
      tradeNotional: 0n,
    },
    blockNumber: 12345n,
  };

  const event = toOpenEvent(log);

  assert.equal(event.trader, TRADER);
  assert.equal(event.pairIndex, 0);
  assert.equal(event.index, 2);
  assert.equal(event.blockNumber, 12345n);
});

test('toOpenEvent defaults blockNumber to 0n when the log has none (defensive, should not normally happen)', () => {
  const event = toOpenEvent({ args: { t: { trader: TRADER, pairIndex: 1, index: 0 } } });
  assert.equal(event.blockNumber, 0n);
});
