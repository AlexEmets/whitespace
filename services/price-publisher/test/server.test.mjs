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

test('GET /health', async () => {
  await withServer(newEngine(), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
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
