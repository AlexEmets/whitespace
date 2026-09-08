import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPriceRequestedEvent } from '../src/watcher.mjs';

const FEED = '0x4254432f55534400000000000000000000000000000000000000000000000000';

test('toPriceRequestedEvent decodes every field exactly, including the exact log timestamp', () => {
  const log = {
    args: { orderId: 7n, orderType: 0, feed: FEED, timestamp: 1_757_325_600n },
    blockNumber: 123n,
    transactionHash: '0xabc',
  };
  const event = toPriceRequestedEvent(log);
  assert.equal(event.orderId, 7n);
  assert.equal(event.orderType, 0);
  assert.equal(event.orderTypeName, 'MARKET_OPEN');
  assert.equal(event.feed, FEED);
  assert.equal(event.timestamp, 1_757_325_600);
  assert.equal(event.blockNumber, 123n);
});

test('toPriceRequestedEvent maps every OrderType enum value to its name', () => {
  const names = ['MARKET_OPEN', 'MARKET_CLOSE', 'LIMIT_OPEN', 'LIMIT_CLOSE', 'REMOVE_COLLATERAL'];
  for (let i = 0; i < names.length; i++) {
    const event = toPriceRequestedEvent({ args: { orderId: 1n, orderType: i, feed: FEED, timestamp: 1n } });
    assert.equal(event.orderTypeName, names[i]);
  }
});

test('toPriceRequestedEvent never substitutes wall-clock time for the log timestamp', () => {
  const farPastTimestamp = 1_000_000n; // long before "now" by any measure
  const event = toPriceRequestedEvent({ args: { orderId: 1n, orderType: 1, feed: FEED, timestamp: farPastTimestamp } });
  assert.equal(event.timestamp, 1_000_000);
  assert.notEqual(event.timestamp, Math.floor(Date.now() / 1000));
});
