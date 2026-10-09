/**
 * `degraded` used to be recomputed from scratch on every request, so a single venue tick
 * landing a few ms past the staleness bound flipped one request to
 * `degraded_opens_blocked` and the next back. These pin the one-sided grace that replaced
 * it: entering degraded needs DEFAULT_DEGRADED_ENTER_GRACE_MS of continuous shortfall once
 * the feed has been healthy; recovery, startup and `noData` are immediate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublisherEngine, DEFAULT_DEGRADED_ENTER_GRACE_MS } from '../src/engine.mjs';
import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';

const SCALE = 10n ** 18n;
const T0 = 1_757_325_600_000;
const FEED = 'BTC/USD';
const GRACE = DEFAULT_DEGRADED_ENTER_GRACE_MS;

function setup(opts = {}) {
  const clock = { t: T0 };
  const engine = createPublisherEngine({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    markets: [FEED],
    bounds: { ...PUBLISHER_BOUNDS, markEmaSampleIntervalMs: 1000 },
    signerKeys: Array.from({ length: 5 }, () => {
      const pk = generatePrivateKey();
      return { address: privateKeyToAccount(pk).address, privateKey: pk };
    }),
    signatureThresholdK: 3,
    now: () => clock.t,
    ...opts,
  });
  const tick = (venues, at = clock.t) => {
    for (const venue of venues) engine.ingestTick(FEED, { venue, bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: at });
  };
  return { engine, clock, tick };
}

/** Three venues healthy at T0, then okx stops ticking while binance and bybit keep going. */
function healthyThenOneVenueLost() {
  const s = setup();
  s.tick(['binance', 'bybit', 'okx']);
  s.engine.sampleMark(FEED);
  assert.equal(s.engine.currentAggregate(FEED).degraded, false);
  // okx's tick is now past the 2 s bound; the other two are refreshed.
  s.clock.t = T0 + PUBLISHER_BOUNDS.stalenessBoundMs + 1;
  s.tick(['binance', 'bybit']);
  return s;
}

test('a momentary shortfall below the venue minimum does not flip opens to refused', async () => {
  const { engine, clock } = healthyThenOneVenueLost();
  const first = engine.currentAggregate(FEED);
  assert.equal(first.healthyCount, 2);
  assert.equal(first.rawDegraded, true, 'the instantaneous verdict stays visible');
  assert.equal(first.degraded, false);
  engine.sampleMark(FEED);
  const signed = await engine.signReportFor(FEED, Math.floor(clock.t / 1000), 'MARKET_OPEN');
  assert.equal(signed.ok, true);
});

test('a shortfall lasting the full grace period does enter degraded (boundary)', async () => {
  const { engine, clock, tick } = healthyThenOneVenueLost();
  const start = clock.t;
  engine.currentAggregate(FEED); // shortfall first observed here
  clock.t = start + GRACE - 1;
  tick(['binance', 'bybit']);
  assert.equal(engine.currentAggregate(FEED).degraded, false, 'one ms short of the grace');
  clock.t = start + GRACE;
  tick(['binance', 'bybit']);
  assert.equal(engine.currentAggregate(FEED).degraded, true);
  engine.sampleMark(FEED);
  const refused = await engine.signReportFor(FEED, Math.floor(clock.t / 1000), 'MARKET_OPEN');
  assert.deepEqual([refused.ok, refused.reason], [false, 'degraded_opens_blocked']);
});

test('once degraded, recovery to the venue minimum is immediate', () => {
  const { engine, clock, tick } = healthyThenOneVenueLost();
  const start = clock.t;
  engine.currentAggregate(FEED);
  clock.t = start + GRACE;
  tick(['binance', 'bybit']);
  assert.equal(engine.currentAggregate(FEED).degraded, true);
  tick(['binance', 'bybit', 'okx']);
  assert.equal(engine.currentAggregate(FEED).degraded, false);
});

test('a recovery inside the grace restarts it: two short dips do not add up', () => {
  const { engine, clock, tick } = healthyThenOneVenueLost();
  const start = clock.t;
  engine.currentAggregate(FEED);
  clock.t = start + GRACE - 500;
  tick(['binance', 'bybit', 'okx']);
  assert.equal(engine.currentAggregate(FEED).degraded, false); // recovered
  clock.t = start + GRACE + PUBLISHER_BOUNDS.stalenessBoundMs; // okx stale again
  tick(['binance', 'bybit']);
  assert.equal(engine.currentAggregate(FEED).degraded, false, 'a new dip starts a new grace');
});

test('a feed that has never been healthy is degraded from the start — no grace at startup', () => {
  const { engine, tick } = setup();
  tick(['binance', 'bybit']);
  assert.equal(engine.currentAggregate(FEED).degraded, true);
});

test('losing every venue is immediate: noData is never graced', () => {
  const { engine, clock, tick } = setup();
  tick(['binance', 'bybit', 'okx']);
  assert.equal(engine.currentAggregate(FEED).degraded, false);
  clock.t = T0 + PUBLISHER_BOUNDS.stalenessBoundMs + 1;
  const agg = engine.currentAggregate(FEED);
  assert.equal(agg.noData, true);
  assert.equal(agg.degraded, true);
});

test('degradedEnterGraceMs: 0 restores the instantaneous verdict', () => {
  const s = setup({ degradedEnterGraceMs: 0 });
  s.tick(['binance', 'bybit', 'okx']);
  assert.equal(s.engine.currentAggregate(FEED).degraded, false);
  s.clock.t = T0 + PUBLISHER_BOUNDS.stalenessBoundMs + 1;
  s.tick(['binance', 'bybit']);
  assert.equal(s.engine.currentAggregate(FEED).degraded, true);
});
