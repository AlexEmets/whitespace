import { test } from 'node:test';
import net from 'node:net';
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
    // Drop any connection still waiting on a response, so a broken handler fails the test
    // instead of hanging it on close.
    server.closeAllConnections();
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

/**
 * The signing window. `/v2/report` used to sign any timestamp it was given, so anyone who
 * could reach it could collect reports dated in the future and replay them later, or
 * backdate one. A report is only useful to the chain within maxAge of its timestamp, so
 * the publisher signs exactly that window: not older than now - maxAge, not later than
 * now + a small clock skew.
 */
function healthyEngine() {
  const engine = newEngine();
  for (const venue of ['binance', 'bybit', 'okx']) {
    engine.ingestTick('BTC/USD', { venue, bid: 65_000n * SCALE, ask: 65_001n * SCALE, ts: NOW });
  }
  engine.sampleMark('BTC/USD');
  return engine;
}

const NOW_S = NOW / 1000;
const reportAt = (base, ts) => fetch(`${base}/v2/report?feed=${encodeURIComponent('BTC/USD')}&timestamp=${ts}&orderType=MARKET_CLOSE`);

test('GET /v2/report refuses a timestamp more than the clock skew in the future', async () => {
  await withServer(healthyEngine(), async (base) => {
    const res = await reportAt(base, NOW_S + 3);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'timestamp_in_future');
    assert.match(body.detail, /3s ahead/);
    assert.equal('signedReport' in body, false);
  });
});

test('GET /v2/report still signs at exactly now + 2s (the skew allowance)', async () => {
  await withServer(healthyEngine(), async (base) => {
    assert.equal((await reportAt(base, NOW_S + 2)).status, 200);
  });
});

test('GET /v2/report refuses a timestamp older than maxAge', async () => {
  await withServer(healthyEngine(), async (base) => {
    const res = await reportAt(base, NOW_S - 11);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'timestamp_too_old');
    assert.match(body.detail, /11s old/);
  });
});

test('GET /v2/report still signs at exactly now - maxAge', async () => {
  await withServer(healthyEngine(), async (base) => {
    assert.equal((await reportAt(base, NOW_S - 10)).status, 200);
  });
});

test('the window follows the configured maxAge and skew', async () => {
  const server = createServerApp(healthyEngine(), { maxReportAgeS: 30, maxClockSkewS: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await reportAt(base, NOW_S - 30)).status, 200);
    assert.equal((await reportAt(base, NOW_S - 31)).status, 400);
    assert.equal((await reportAt(base, NOW_S + 1)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * The request handler is async and node:http drops its promise, so a throw inside it was an
 * unhandled rejection — process exit. These pin that every failure ends in a response and
 * the server keeps serving afterwards.
 */
function rawRequest(base, requestLine, timeoutMs = 1000) {
  const { port } = new URL(base);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data || null);
    });
  });
}

function captureRejections() {
  const seen = [];
  const onRejection = (err) => seen.push(err);
  process.on('unhandledRejection', onRejection);
  return { seen, restore: () => process.off('unhandledRejection', onRejection) };
}

test('GET // answers 400 instead of rejecting, and the server keeps serving', async () => {
  const rejections = captureRejections();
  try {
    await withServer(newEngine(), async (base) => {
      const raw = await rawRequest(base, 'GET // HTTP/1.1');
      assert.ok(raw, 'the server must answer');
      assert.match(raw, /^HTTP\/1\.1 400 /);
      assert.equal(rejections.seen.length, 0);
      assert.equal((await fetch(`${base}/health`)).status, 503);
    });
  } finally {
    rejections.restore();
  }
});

test('an exception inside a route answers a generic 500 and the server keeps serving', async () => {
  const rejections = captureRejections();
  const engine = healthyEngine();
  engine.signReportFor = async () => {
    throw new Error('signer exploded: secret detail');
  };
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await withServer(engine, async (base) => {
      // Bounded: without a response the request would otherwise hang the test forever.
      const res = await fetch(`${base}/v2/report?feed=${encodeURIComponent('BTC/USD')}&timestamp=${NOW_S}&orderType=MARKET_CLOSE`, {
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: 'internal error' });
      assert.doesNotMatch(text, /secret/);
      assert.ok(logged.some((l) => l.includes('/v2/report') && l.includes('signer exploded')));
      assert.equal(rejections.seen.length, 0);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
  } finally {
    console.error = originalError;
    rejections.restore();
  }
});
