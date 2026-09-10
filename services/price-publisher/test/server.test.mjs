import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublisherEngine } from '../src/engine.mjs';
import { createServerApp } from '../src/server.mjs';
import { PUBLISHER_BOUNDS } from '@whitespace/shared/bounds';

const SCALE = 10n ** 18n;
const NOW = 1_757_325_600_000;

function makeKeys(n) {
  return Array.from({ length: n }, () => {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, privateKey: pk };
  });
}

async function withServer(engine, fn) {
  const server = createServerApp(engine);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function newEngine() {
  return createPublisherEngine({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    markets: ['BTC/USD'],
    bounds: { ...PUBLISHER_BOUNDS, markEmaSampleIntervalMs: 1000 },
    signerKeys: makeKeys(5),
    signatureThresholdK: 3,
    now: () => NOW,
  });
}

/**
 * Health used to be a hardcoded `{ ok: true }`, and this test asserted exactly that. That
 * pairing is how a nine-hour total outage went unnoticed on the live stack: every venue
 * socket was half-open, `/status` showed `healthyCount: 0`, and the one endpoint the
 * supervisor and any monitor look at kept reporting success. A health check that cannot
 * fail is not a health check, so the contract is now "can this publisher produce a
 * signable price at all", and these two tests pin both answers.
 */
test('GET /health fails with 503 when no feed has a live venue — nothing can be signed', async () => {
  await withServer(newEngine(), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.feedsWithVenues, 0);
    assert.equal(body.totalFeeds, 1);
  });
});

test('GET /health is 200 once a venue is live, and names what it can see', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', { venue: 'binance', bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: NOW });
  await withServer(engine, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.feedsWithVenues, 1);
    // A single venue is below the k-of-N threshold, so the feed is degraded — but the
    // service is working and honestly says so. Only "no venue at all" is a failed check;
    // whether a degraded feed is good enough to trade on is the signing gate's decision,
    // not this endpoint's.
    assert.equal(body.feeds['BTC/USD'].degraded, true);
    assert.equal(body.feeds['BTC/USD'].healthyCount, 1);
    assert.deepEqual(body.feeds['BTC/USD'].healthyVenues, ['binance']);
  });
});

test('GET /status reports degraded=true with fewer than 3 healthy venues', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', { venue: 'binance', bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: NOW });
  engine.sampleMark('BTC/USD');
  await withServer(engine, async (base) => {
    const res = await fetch(`${base}/status`);
    const body = await res.json();
    assert.equal(body.feeds['BTC/USD'].degraded, true);
    assert.equal(body.feeds['BTC/USD'].healthyCount, 1);
  });
});

test('GET /v2/report returns a signed report when the aggregate is healthy', async () => {
  const engine = newEngine();
  for (const venue of ['binance', 'bybit', 'okx']) {
    engine.ingestTick('BTC/USD', { venue, bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: NOW });
  }
  engine.sampleMark('BTC/USD');
  await withServer(engine, async (base) => {
    const res = await fetch(`${base}/v2/report?feed=${encodeURIComponent('BTC/USD')}&timestamp=1757325600&orderType=MARKET_OPEN`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.signedReport, /^0x[0-9a-f]+$/);
    assert.equal(body.signers.length, 5);
  });
});

test('GET /v2/report returns 409 (no signed report) when opens are blocked in degraded mode', async () => {
  const engine = newEngine();
  engine.ingestTick('BTC/USD', { venue: 'binance', bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: NOW });
  engine.sampleMark('BTC/USD');
  await withServer(engine, async (base) => {
    const res = await fetch(`${base}/v2/report?feed=${encodeURIComponent('BTC/USD')}&timestamp=1757325600&orderType=MARKET_OPEN`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'degraded_opens_blocked');
    assert.equal('signedReport' in body, false);
  });
});

test('GET /v2/report 400s on a missing parameter, 404s on an unknown feed', async () => {
  await withServer(newEngine(), async (base) => {
    const missing = await fetch(`${base}/v2/report?feed=${encodeURIComponent('BTC/USD')}&orderType=MARKET_OPEN`);
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${base}/v2/report?feed=${encodeURIComponent('DOGE/USD')}&timestamp=1&orderType=MARKET_OPEN`);
    assert.equal(unknown.status, 404);
  });
});
