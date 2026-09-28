import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeAbiParameters } from 'viem';
import { createHttpReportSource, createLocalReportSource } from '../src/reportSource.mjs';

async function withFixtureServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HttpReportSource returns ok:true with the signedReport on 200', async () => {
  await withFixtureServer(
    (req, res) => {
      assert.equal(req.url.startsWith('/v2/report?'), true);
      const url = new URL(req.url, 'http://localhost');
      assert.equal(url.searchParams.get('feed'), 'BTC/USD');
      assert.equal(url.searchParams.get('timestamp'), '1757325600');
      assert.equal(url.searchParams.get('orderType'), 'MARKET_CLOSE');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ signedReport: '0xdeadbeef', signers: ['0x1'] }));
    },
    async (base) => {
      const source = createHttpReportSource(base);
      const result = await source.getSignedReport({ feed: 'BTC/USD', timestamp: 1_757_325_600, orderTypeName: 'MARKET_CLOSE' });
      assert.deepEqual(result, { ok: true, signedReport: '0xdeadbeef' });
    },
  );
});

test('HttpReportSource surfaces the publisher error reason on a non-2xx response (e.g. degraded)', async () => {
  await withFixtureServer(
    (req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'degraded_opens_blocked' }));
    },
    async (base) => {
      const source = createHttpReportSource(base);
      const result = await source.getSignedReport({ feed: 'BTC/USD', timestamp: 1, orderTypeName: 'MARKET_OPEN' });
      assert.deepEqual(result, { ok: false, reason: 'degraded_opens_blocked', status: 409 });
    },
  );
});

test('HttpReportSource falls back to http_<status> when the error body is not JSON', async () => {
  await withFixtureServer(
    (req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    },
    async (base) => {
      const result = await createHttpReportSource(base).getSignedReport({ feed: 'BTC/USD', timestamp: 1, orderTypeName: 'MARKET_CLOSE' });
      assert.deepEqual(result, { ok: false, reason: 'http_502', status: 502 });
    },
  );
});

test('HttpReportSource surfaces a network failure as ok:false rather than throwing', async () => {
  const source = createHttpReportSource('http://127.0.0.1:1'); // nothing listens on port 1
  const result = await source.getSignedReport({ feed: 'BTC/USD', timestamp: 1, orderTypeName: 'MARKET_CLOSE' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^fetch_failed:/);
  assert.equal(result.status, undefined, 'no status: the engine treats it as retryable');
});

test('LocalReportSource builds and signs a v2 report with the exact caller-supplied timestamp', async () => {
  const keys = Array.from({ length: 3 }, () => {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, privateKey: pk };
  });
  const source = createLocalReportSource({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    signerKeys: keys,
    getMarketPrice: async () => ({ price: 65_000n * 10n ** 18n }),
  });
  const result = await source.getSignedReport({ feed: 'BTC/USD', timestamp: 1_700_000_000, orderTypeName: 'MARKET_CLOSE' });
  assert.equal(result.ok, true);
  const [reportData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], result.signedReport);
  const decoded = decodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'int192' }, { type: 'int192' }, { type: 'int192' }, { type: 'bool' }, { type: 'bool' },
    ],
    reportData,
  );
  assert.equal(decoded[3], 1_700_000_000);
  assert.equal(decoded[4], 65_000n * 10n ** 18n);
});

test('LocalReportSource returns ok:false when no price is available', async () => {
  const source = createLocalReportSource({
    chainId: 1874,
    verifierAddress: '0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8',
    signerKeys: [],
    getMarketPrice: async () => null,
  });
  const result = await source.getSignedReport({ feed: 'BTC/USD', timestamp: 1, orderTypeName: 'MARKET_CLOSE' });
  assert.deepEqual(result, { ok: false, reason: 'no_price' });
});
