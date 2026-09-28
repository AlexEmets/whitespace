/**
 * Report fetches are retried until the order's report deadline. They used to be tried
 * once: a publisher restart, or a market that was degraded for two seconds, meant the
 * order was never filled and the trader's collateral sat until the timeout reclaim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeeperEngine } from '../src/keeperEngine.mjs';
import { toPriceRequestedEvent } from '../src/watcher.mjs';

const FEED_BTC = '0x4254432f55534400000000000000000000000000000000000000000000000000';
const TS = 1_757_325_600; // order timestamp, seconds

function makeEvent(overrides = {}) {
  return toPriceRequestedEvent({ args: { orderId: 55n, orderType: 0, feed: FEED_BTC, timestamp: BigInt(TS), ...overrides } });
}

/** Virtual clock starting `startOffsetMs` after the order timestamp. */
function clock(startOffsetMs = 0) {
  let t = TS * 1000 + startOffsetMs;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

/** A report source that answers from `answers` in order, repeating the last one. */
function scripted(answers) {
  const calls = [];
  return {
    calls,
    async getSignedReport(req) {
      calls.push(req);
      return answers[Math.min(calls.length - 1, answers.length - 1)];
    },
  };
}

const OK = { ok: true, signedReport: '0xdeadbeef' };
const DOWN = { ok: false, reason: 'fetch_failed:ECONNREFUSED' };
const DEGRADED = { ok: false, reason: 'degraded_opens_blocked', status: 409 };

function engineWith(reportSource, c, extra = {}) {
  const sent = [];
  const gaveUp = [];
  const engine = createKeeperEngine({
    reportSource,
    txSender: { send: async (a) => (sent.push(a), { ok: true, hash: '0xtx' }) },
    onGiveUp: (e) => gaveUp.push(e),
    now: c.now,
    sleep: c.sleep,
    ...extra,
  });
  return { engine, sent, gaveUp };
}

test('publisher down, then back: the order is delivered after retrying with backoff', async () => {
  const c = clock();
  const source = scripted([DOWN, DOWN, OK]);
  const { engine, sent, gaveUp } = engineWith(source, c);

  const result = await engine.handlePriceRequested(makeEvent());

  assert.equal(result.ok, true);
  assert.equal(source.calls.length, 3);
  assert.equal(sent.length, 1);
  assert.equal(gaveUp.length, 0);
  assert.deepEqual(c.sleeps, [250, 500], 'exponential backoff');
  assert.ok(source.calls.every((r) => r.timestamp === TS), 'every retry asks for the same order timestamp');
});

test('a 409 (degraded, opens blocked) is retried: degradation is usually brief', async () => {
  const c = clock();
  const source = scripted([DEGRADED, OK]);
  const { engine, sent } = engineWith(source, c);
  const result = await engine.handlePriceRequested(makeEvent());
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
});

test('5xx and 429 are retried too', async () => {
  for (const status of [500, 503, 429]) {
    const c = clock();
    const source = scripted([{ ok: false, reason: `http_${status}`, status }, OK]);
    const { engine } = engineWith(source, c);
    assert.equal((await engine.handlePriceRequested(makeEvent())).ok, true, `status ${status}`);
  }
});

test('never retries past the deadline (timestamp + maxAge); gives up with the last reason logged', async () => {
  const c = clock();
  const source = scripted([DEGRADED]);
  const { engine, sent, gaveUp } = engineWith(source, c);

  const result = await engine.handlePriceRequested(makeEvent());

  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].orderId, 55n);
  assert.match(gaveUp[0].reason, /report_deadline_passed/);
  assert.match(gaveUp[0].reason, /degraded_opens_blocked/);
  assert.ok(c.now() <= (TS + 10) * 1000, 'did not sleep beyond the deadline');
  const totalSlept = c.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(totalSlept < 10_000);
  assert.ok(c.sleeps.every((ms) => ms <= 2_000), `backoff capped at 2 s: ${c.sleeps}`);
});

test('an order already past its deadline is not fetched at all', async () => {
  const c = clock(10_000); // exactly at timestamp + maxAge
  const source = scripted([OK]);
  const { engine, gaveUp } = engineWith(source, c);
  const result = await engine.handlePriceRequested(makeEvent());
  assert.equal(result.ok, false);
  assert.equal(source.calls.length, 0);
  assert.match(gaveUp[0].reason, /expired/);
});

test('one millisecond before the deadline, it still tries once', async () => {
  const c = clock(9_999);
  const source = scripted([OK]);
  const { engine } = engineWith(source, c);
  assert.equal((await engine.handlePriceRequested(makeEvent())).ok, true);
  assert.equal(source.calls.length, 1);
});

test('a permanent refusal (400/404) gives up immediately, without retrying', async () => {
  for (const status of [400, 404]) {
    const c = clock();
    const source = scripted([{ ok: false, reason: 'unknown feed', status }]);
    const { engine, gaveUp } = engineWith(source, c);
    const result = await engine.handlePriceRequested(makeEvent());
    assert.equal(result.ok, false);
    assert.equal(source.calls.length, 1, `status ${status}`);
    assert.match(gaveUp[0].reason, /unknown feed/);
  }
});

test('maxAge is configurable', async () => {
  const c = clock(4_000);
  const source = scripted([OK]);
  const { engine } = engineWith(source, c, { maxAgeS: 3 });
  assert.equal((await engine.handlePriceRequested(makeEvent())).ok, false);
  assert.equal(source.calls.length, 0);
});
