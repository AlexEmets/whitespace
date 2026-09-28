import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import { createKeeperEngine } from '../src/keeperEngine.mjs';
import { toPriceRequestedEvent } from '../src/watcher.mjs';

const FEED_BTC = '0x4254432f55534400000000000000000000000000000000000000000000000000';

/** The engine reads the clock only to bound retries; pin it to the order's own second. */
const AT_ORDER_TIME = () => 1_757_325_600_000;

function makeEvent(overrides = {}) {
  return toPriceRequestedEvent({
    args: { orderId: 55n, orderType: 0, feed: FEED_BTC, timestamp: 1_757_325_600n, ...overrides },
  });
}

test('handlePriceRequested passes the event timestamp through to the report source byte-identically', async () => {
  let capturedRequest;
  const reportSource = {
    async getSignedReport(req) {
      capturedRequest = req;
      return { ok: true, signedReport: '0xdeadbeef' };
    },
  };
  const txSender = { send: async () => ({ ok: true, hash: '0xtx' }) };
  const engine = createKeeperEngine({ reportSource, txSender, now: AT_ORDER_TIME });

  const event = makeEvent();
  await engine.handlePriceRequested(event);

  assert.equal(capturedRequest.timestamp, 1_757_325_600);
  assert.equal(capturedRequest.feed, 'BTC/USD'); // resolved from the feedId back to the registry name
  assert.equal(capturedRequest.orderTypeName, 'MARKET_OPEN');
});

test('an order timestamp is never "corrected" to the current time', async () => {
  let capturedTimestamp;
  const reportSource = {
    async getSignedReport({ timestamp }) {
      capturedTimestamp = timestamp;
      return { ok: true, signedReport: '0xdeadbeef' };
    },
  };
  const txSender = { send: async () => ({ ok: true, hash: '0xtx' }) };
  const oldTimestamp = 1_000_000n;
  // Clock three seconds past the order: still inside maxAge, but a different second.
  const engine = createKeeperEngine({ reportSource, txSender, now: () => 1_000_003_000 });

  await engine.handlePriceRequested(makeEvent({ timestamp: oldTimestamp }));

  assert.equal(capturedTimestamp, 1_000_000);
  assert.notEqual(capturedTimestamp, 1_000_003);
});

test('handlePriceRequested wraps the signed report and orderId into performData for txSender', async () => {
  let capturedSend;
  const reportSource = { async getSignedReport() { return { ok: true, signedReport: '0xdeadbeef' }; } };
  const txSender = {
    async send(args) {
      capturedSend = args;
      return { ok: true, hash: '0xtx' };
    },
  };
  const engine = createKeeperEngine({ reportSource, txSender, now: AT_ORDER_TIME });

  await engine.handlePriceRequested(makeEvent({ orderId: 55n }));

  assert.equal(capturedSend.orderId, 55n);
  const [report, orderId] = decodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], capturedSend.performData);
  assert.equal(report, '0xdeadbeef');
  assert.equal(orderId, 55n);
});

test('when the report source refuses permanently, the order is given up and txSender is never called', async () => {
  const reportSource = { async getSignedReport() { return { ok: false, reason: 'unknown feed', status: 404 }; } };
  let sendCalled = false;
  const txSender = { async send() { sendCalled = true; return { ok: true }; } };
  const gaveUp = [];
  const engine = createKeeperEngine({ reportSource, txSender, onGiveUp: (e) => gaveUp.push(e), now: AT_ORDER_TIME });

  const result = await engine.handlePriceRequested(makeEvent());

  assert.equal(result.ok, false);
  assert.equal(sendCalled, false);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].orderId, 55n);
  assert.match(gaveUp[0].reason, /unknown feed/);
});

test('an unknown feedId (not in the registry) is passed through raw rather than crashing', async () => {
  let capturedFeed;
  const reportSource = {
    async getSignedReport({ feed }) {
      capturedFeed = feed;
      return { ok: true, signedReport: '0xdeadbeef' };
    },
  };
  const txSender = { send: async () => ({ ok: true, hash: '0xtx' }) };
  const engine = createKeeperEngine({ reportSource, txSender, now: AT_ORDER_TIME });

  const unknownFeed = `0x${'ff'.repeat(32)}`;
  await engine.handlePriceRequested(makeEvent({ feed: unknownFeed }));

  assert.equal(capturedFeed, unknownFeed);
});
