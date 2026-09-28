import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublisherEngine } from '../src/engine.mjs';
import { createServerApp } from '../src/server.mjs';
import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';

const SCALE = 10n ** 18n;
const T0 = 1_757_325_600_000;
const FEED = 'BTC/USD';

function setup() {
  const clock = { t: T0 };
  const engine = createPublisherEngine({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    markets: [FEED, 'ETH/USD'],
    bounds: { ...PUBLISHER_BOUNDS, markEmaSampleIntervalMs: 1000 },
    signerKeys: Array.from({ length: 5 }, () => {
      const pk = generatePrivateKey();
      return { address: privateKeyToAccount(pk).address, privateKey: pk };
    }),
    signatureThresholdK: 3,
    now: () => clock.t,
  });
  return { engine, clock };
}

function tick(engine, venues, at = T0) {
  for (const venue of venues) engine.ingestTick(FEED, { venue, bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: at });
}

async function withServer(engine, fn) {
  const server = createServerApp(engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, async () => (await fetch(`${base}/metrics`)).text());
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const report = (base, ts, orderType) => fetch(`${base}/v2/report?feed=${encodeURIComponent(FEED)}&timestamp=${ts}&orderType=${orderType}`);

test('GET /metrics is Prometheus text with per-feed venue, degraded and mark gauges', async () => {
  const { engine } = setup();
  tick(engine, ['binance', 'bybit', 'okx']);
  engine.sampleMark(FEED);
  await withServer(engine, async (base) => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /publisher_healthy_venues\{feed="BTC\/USD"\} 3/);
    assert.match(text, /publisher_min_healthy_venues\{feed="BTC\/USD"\} 3/);
    assert.match(text, /publisher_degraded\{feed="BTC\/USD"\} 0/);
    assert.match(text, /publisher_mark_age_seconds\{feed="BTC\/USD"\} 0/);
    assert.match(text, /publisher_mark_stale\{feed="BTC\/USD"\} 0/);
    // A feed with no data at all: degraded, never marked.
    assert.match(text, /publisher_healthy_venues\{feed="ETH\/USD"\} 0/);
    assert.match(text, /publisher_degraded\{feed="ETH\/USD"\} 1/);
    assert.match(text, /publisher_mark_age_seconds\{feed="ETH\/USD"\} -1/);
    assert.match(text, /publisher_mark_stale\{feed="ETH\/USD"\} 1/);
  });
});

test('gauges are read at scrape time: degradation and mark age show up without a restart', async () => {
  const { engine, clock } = setup();
  tick(engine, ['binance', 'bybit', 'okx']);
  engine.sampleMark(FEED);
  await withServer(engine, async (_base, scrape) => {
    clock.t = T0 + 5_000; // every tick is now past the 2 s venue bound
    const text = await scrape();
    assert.match(text, /publisher_healthy_venues\{feed="BTC\/USD"\} 0/);
    assert.match(text, /publisher_degraded\{feed="BTC\/USD"\} 1/);
    assert.match(text, /publisher_mark_age_seconds\{feed="BTC\/USD"\} 5/);
    assert.match(text, /publisher_mark_stale\{feed="BTC\/USD"\} 1/);
  });
});

test('signed and refused reports are counted by feed and order type / reason', async () => {
  const { engine } = setup();
  tick(engine, ['binance']); // one venue: degraded, opens refused, closes signed
  engine.sampleMark(FEED);
  const ts = T0 / 1000;
  await withServer(engine, async (base, scrape) => {
    assert.equal((await report(base, ts, 'MARKET_CLOSE')).status, 200);
    assert.equal((await report(base, ts, 'MARKET_CLOSE')).status, 200);
    assert.equal((await report(base, ts, 'MARKET_OPEN')).status, 409);
    assert.equal((await report(base, ts + 60, 'MARKET_CLOSE')).status, 400);
    assert.equal((await report(base, ts - 60, 'MARKET_CLOSE')).status, 400);
    const text = await scrape();
    assert.match(text, /publisher_reports_signed_total\{feed="BTC\/USD",order_type="MARKET_CLOSE"\} 2/);
    assert.match(text, /publisher_reports_refused_total\{feed="BTC\/USD",reason="degraded_opens_blocked"\} 1/);
    assert.match(text, /publisher_reports_refused_total\{feed="BTC\/USD",reason="timestamp_in_future"\} 1/);
    assert.match(text, /publisher_reports_refused_total\{feed="BTC\/USD",reason="timestamp_too_old"\} 1/);
  });
});

test('a caller-chosen orderType cannot mint new label values', async () => {
  const { engine } = setup();
  tick(engine, ['binance', 'bybit', 'okx']);
  engine.sampleMark(FEED);
  await withServer(engine, async (base, scrape) => {
    assert.equal((await report(base, T0 / 1000, 'WHATEVER_I_LIKE')).status, 200);
    const text = await scrape();
    assert.match(text, /order_type="other"\} 1/);
    assert.doesNotMatch(text, /WHATEVER_I_LIKE/);
  });
});

test('requests for unknown feeds are not counted (the feed label would be caller-chosen)', async () => {
  const { engine } = setup();
  await withServer(engine, async (base, scrape) => {
    assert.equal((await fetch(`${base}/v2/report?feed=NOPE&timestamp=1&orderType=MARKET_OPEN`)).status, 404);
    assert.doesNotMatch(await scrape(), /NOPE/);
  });
});
