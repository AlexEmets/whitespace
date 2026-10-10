import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedCandle } from './seed.js';
import { getPool } from '../src/db.js';
import { DEFAULT_CANDLE_LIMIT, MAX_CANDLE_LIMIT } from '../src/routes/markets.js';

describe('GET /markets', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('returns an empty array when no markets are indexed', async () => {
    const res = await fetch(`${server.baseUrl}/markets`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns the seeded BTC/USD market with decimal-string fields matching deployments/1874-operational.json', async () => {
    await seedMarket();
    const res = await fetch(`${server.baseUrl}/markets`);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      pairIndex: 0,
      from: 'BTC',
      to: 'USD',
      feedId: '0x4254432f55534400000000000000000000000000000000000000000000000000',
      maxLeverage: '100.00', // 10000 PRECISION_2 -> 100.00x
      maxOpenInterest: '1000000.000000', // 1_000_000_000_000 PRECISION_6
      openInterest: { long: '9990.000000', short: '0.000000' },
    });
  });

  it('money fields are JSON strings, never numbers (precision)', async () => {
    await seedMarket();
    const res = await fetch(`${server.baseUrl}/markets`);
    const text = await res.text();
    expect(text).toContain('"maxOpenInterest":"1000000.000000"');
    expect(text).not.toMatch(/"maxOpenInterest":\d/);
  });
});

describe('GET /markets/:pairIndex', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('returns the market for a valid, existing pairIndex', async () => {
    const res = await fetch(`${server.baseUrl}/markets/0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pairIndex).toBe(0);
    expect(body.from).toBe('BTC');
  });

  it('returns 404 for a pairIndex that does not exist', async () => {
    const res = await fetch(`${server.baseUrl}/markets/7`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-integer pairIndex', async () => {
    const res = await fetch(`${server.baseUrl}/markets/not-a-number`);
    expect(res.status).toBe(400);
  });
});

describe('GET /markets/:pairIndex/candles', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('rejects an unsupported interval', async () => {
    const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=2m`);
    expect(res.status).toBe(400);
  });

  it('accepts every supported interval (no false rejections)', async () => {
    for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=${interval}`);
      expect(res.status, `interval=${interval}`).toBe(200);
    }
  });

  it('returns candles within a [from, to] range, excluding buckets outside it', async () => {
    await seedCandle('1h', 0, { o: '100000000000000000000', h: '101000000000000000000', l: '99000000000000000000', c: '100500000000000000000', v: '1000000' });
    await seedCandle('1h', 3600, { o: '100500000000000000000', h: '102000000000000000000', l: '100000000000000000000', c: '101800000000000000000', v: '2000000' });
    await seedCandle('1h', 7200, { o: '101800000000000000000', h: '103000000000000000000', l: '101500000000000000000', c: '102900000000000000000', v: '3000000' });

    const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=1h&from=0&to=3600`);
    const body = await res.json();
    expect(body.map((c: { t: number }) => c.t)).toEqual([0, 3600]); // the bucket at 7200 must be excluded
  });

  it('returns candle OHLCV as decimal strings at 18/6 decimals', async () => {
    await seedCandle('1m', 60, {
      o: '65001000000000000000000',
      h: '65001000000000000000000',
      l: '64999000000000000000000',
      c: '65000000000000000000000',
      v: '19980000000',
    });
    const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=1m&from=0&to=120`);
    const body = await res.json();
    expect(body).toEqual([
      {
        t: 60,
        o: '65001.000000000000000000',
        h: '65001.000000000000000000',
        l: '64999.000000000000000000',
        c: '65000.000000000000000000',
        v: '19980.000000',
      },
    ]);
  });

  it('without from/to, returns the most recent candles in ascending time order', async () => {
    await seedCandle('1m', 60, { o: '1', h: '1', l: '1', c: '1', v: '0' });
    await seedCandle('1m', 120, { o: '2', h: '2', l: '2', c: '2', v: '0' });
    const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=1m`);
    const body = await res.json();
    expect(body.map((c: { t: number }) => c.t)).toEqual([60, 120]);
  });
});

describe('GET /markets/:pairIndex/candles is bounded', () => {
  let server: TestServer;
  const N = MAX_CANDLE_LIMIT + 1;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  const ts = (body: Array<{ t: number }>) => body.map((c) => c.t);

  async function seedIndexSeries(count: number): Promise<void> {
    await getPool().query(
      `INSERT INTO api_series.index_candle (pair_index, interval, bucket_start, open, high, low, close, tick_count, updated_at)
       SELECT 0, '1m', g * 60, 1, 1, 1, 1, 1, g * 60 FROM generate_series(1, $1::int) g`,
      [count],
    );
  }

  it(`a wide range over the index series returns the most recent ${MAX_CANDLE_LIMIT}, oldest first`, async () => {
    await seedIndexSeries(N);
    const body = ts(await (await fetch(`${server.baseUrl}/markets/0/candles?interval=1m&from=0&to=${N * 60}`)).json());
    expect(body).toHaveLength(MAX_CANDLE_LIMIT);
    expect(body[0]).toBe(2 * 60); // the oldest (bucket 1) is the one dropped
    expect(body[body.length - 1]).toBe(N * 60);
  });

  it(`a range holding exactly ${MAX_CANDLE_LIMIT} returns all of them (boundary)`, async () => {
    await seedIndexSeries(MAX_CANDLE_LIMIT);
    const body = ts(await (await fetch(`${server.baseUrl}/markets/0/candles?interval=1m&from=0&to=${N * 60}`)).json());
    expect(body).toHaveLength(MAX_CANDLE_LIMIT);
    expect(body[0]).toBe(60);
  });

  it(`no range over the index series returns the most recent ${DEFAULT_CANDLE_LIMIT}, not the whole series`, async () => {
    await seedIndexSeries(DEFAULT_CANDLE_LIMIT + 10);
    const body = ts(await (await fetch(`${server.baseUrl}/markets/0/candles?interval=1m`)).json());
    expect(body).toHaveLength(DEFAULT_CANDLE_LIMIT);
    expect(body[body.length - 1]).toBe((DEFAULT_CANDLE_LIMIT + 10) * 60);
    expect(body[0]).toBe(11 * 60);
  });

  it(`a wide range over the on-chain fallback is capped at ${MAX_CANDLE_LIMIT} too`, async () => {
    await getPool().query(
      `INSERT INTO candle (id, pair_index, interval, bucket_start, open, high, low, close, volume)
       SELECT '0-1m-' || g, 0, '1m', g * 60, 1, 1, 1, 1, 0 FROM generate_series(1, $1::int) g`,
      [N],
    );
    const body = ts(await (await fetch(`${server.baseUrl}/markets/0/candles?interval=1m&from=0&to=${N * 60}`)).json());
    expect(body).toHaveLength(MAX_CANDLE_LIMIT);
    expect(body[0]).toBe(2 * 60);
    expect(body[body.length - 1]).toBe(N * 60);
  });
});
