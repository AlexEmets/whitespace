/**
 * The mark when the index goes away.
 *
 * `ema.update(null)` leaves the EMA where it was, which is right for one missed sample and
 * wrong for a long one: the mark froze at its last value, nothing said so, and every
 * report signed during and right after the outage carried a price from before it. The
 * gate only checks the venues at signing time, so a close signed the moment one venue
 * reconnected — before the sampler had run — went out at the frozen mark.
 *
 * Now the mark carries an age (time since an index sample last moved it). Past the
 * staleness bound it is reported stale, signing refuses with `mark_stale`, and the next
 * real index reseeds the EMA instead of being blended into a price that is no longer
 * the market's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublisherEngine } from '../src/engine.mjs';
import { createServerApp } from '../src/server.mjs';
import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';

const SCALE = 10n ** 18n;
const T0 = 1_757_325_600_000;
const FEED = 'BTC/USD';

function makeKeys(n) {
  return Array.from({ length: n }, () => {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, privateKey: pk };
  });
}

function setup(extra = {}) {
  const clock = { t: T0 };
  const engine = createPublisherEngine({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    markets: [FEED],
    bounds: { ...PUBLISHER_BOUNDS, markEmaSampleIntervalMs: 1000 },
    signerKeys: makeKeys(5),
    signatureThresholdK: 3,
    now: () => clock.t,
    ...extra,
  });
  const feedVenues = (price, at = clock.t) => {
    for (const venue of ['binance', 'bybit', 'okx']) {
      engine.ingestTick(FEED, { venue, bid: price * SCALE, ask: price * SCALE + SCALE, ts: at });
    }
  };
  return { engine, clock, feedVenues };
}

test('the default staleness bound is three sample intervals', () => {
  const { engine } = setup();
  assert.equal(engine.markStalenessMsOf(FEED), 3_000);
});

test('a null index does not refresh the mark: it keeps its value but its age grows and it goes stale', () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  const mark = engine.markOf(FEED);

  // Every venue goes quiet: ticks age past the 2 s venue staleness bound, index is null.
  for (let i = 3; i <= 7; i++) {
    clock.t = T0 + i * 1_000;
    const sample = engine.sampleMark(FEED);
    assert.equal(sample.aggregate.index, null);
  }
  const status = engine.markStatus(FEED);
  assert.equal(status.mark, mark, 'the value is not poisoned');
  assert.equal(status.markAgeMs, 7_000);
  assert.equal(status.stale, true);
});

test('a mark exactly at the bound is fresh; one millisecond past it is stale', () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  clock.t = T0 + 3_000;
  assert.equal(engine.markStatus(FEED).stale, false);
  clock.t = T0 + 3_001;
  assert.equal(engine.markStatus(FEED).stale, true);
});

test('never sampled: no mark, reported stale with no age', () => {
  const { engine } = setup();
  assert.deepEqual(engine.markStatus(FEED), { mark: null, markAgeMs: null, stale: true, staleAfterMs: 3_000 });
});

test('signing refuses a stale mark even when fresh ticks let the gate pass', async () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);

  clock.t = T0 + 5_000;
  feedVenues(70_000n); // venues are back, but the sampler has not run since
  const result = await engine.signReportFor(FEED, T0 / 1000 + 5, 'MARKET_CLOSE');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mark_stale');
  assert.equal('signedReport' in result, false);
});

test('signing still works with a mark exactly at the bound', async () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  clock.t = T0 + 3_000;
  feedVenues(65_000n);
  const result = await engine.signReportFor(FEED, T0 / 1000 + 3, 'MARKET_CLOSE');
  assert.equal(result.ok, true);
});

test('after a stale gap the next index reseeds the mark instead of blending into the old price', () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  const before = engine.markOf(FEED);

  clock.t = T0 + 10_000;
  feedVenues(70_000n);
  const sample = engine.sampleMark(FEED);
  assert.equal(sample.reseeded, true);
  assert.equal(sample.mark, sample.aggregate.index, 'seeded straight from the index');
  assert.notEqual(sample.mark, before);
  assert.equal(engine.markStatus(FEED).stale, false);
});

test('within the bound the EMA keeps smoothing (no reseed on an ordinary sample)', () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  clock.t = T0 + 1_000;
  feedVenues(66_000n);
  const sample = engine.sampleMark(FEED);
  assert.equal(sample.reseeded, false);
  assert.ok(sample.mark < sample.aggregate.index, 'smoothed, not jumped');
});

test('markStalenessMs is configurable', () => {
  const { engine, clock, feedVenues } = setup({ markStalenessMs: 10_000 });
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  clock.t = T0 + 9_000;
  assert.equal(engine.markStatus(FEED).stale, false);
});

test('GET /status reports markAgeMs and markStale', async () => {
  const { engine, clock, feedVenues } = setup();
  feedVenues(65_000n);
  engine.sampleMark(FEED);
  clock.t = T0 + 4_000;
  const server = createServerApp(engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/status`)).json();
    assert.equal(body.feeds[FEED].markAgeMs, 4_000);
    assert.equal(body.feeds[FEED].markStale, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
