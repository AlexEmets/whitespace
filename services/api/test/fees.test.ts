import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedFee, TRADER, TX_A } from './seed.js';

const OTHER = `0x${'00'.repeat(19)}bb`;

describe('GET /fees/:address', () => {
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

  const get = async (path: string) => {
    const res = await fetch(`${server.baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  };

  it('returns the exact FeeCharge shape, newest first, with signed funding', async () => {
    await seedFee('0xa-1-funding', 'funding', '-1234567', { at: 200 });
    await seedFee('0xa-0', 'oracle', '250000', { at: 100, tradeId: null, pairIndex: null });
    const { status, body } = await get(`/fees/${TRADER}`);
    expect(status).toBe(200);
    expect(body).toEqual([
      {
        id: '0xa-1-funding',
        trader: TRADER,
        tradeId: '2',
        pairIndex: 0,
        kind: 'funding',
        amount: '-1.234567',
        at: 200,
        blockNumber: '7285600',
        txHash: TX_A,
      },
      {
        id: '0xa-0',
        trader: TRADER,
        tradeId: null,
        pairIndex: null,
        kind: 'oracle',
        amount: '0.250000',
        at: 100,
        blockNumber: '7285600',
        txHash: TX_A,
      },
    ]);
  });

  it('defaults to 200 rows and honours ?limit up to 1000', async () => {
    const values = Array.from({ length: 205 }, (_, i) => i);
    for (const i of values) await seedFee(`0xf-${i}`, 'dev', '1', { at: i });
    expect((await get(`/fees/${TRADER}`)).body).toHaveLength(200);
    const two = (await get(`/fees/${TRADER}?limit=2`)).body;
    expect(two.map((f: { at: number }) => f.at)).toEqual([204, 203]);
    expect((await get(`/fees/${TRADER}?limit=1000`)).body).toHaveLength(205);
  });

  it('is scoped per trader', async () => {
    await seedFee('0xa-0', 'dev', '1', { trader: OTHER });
    expect((await get(`/fees/${TRADER}`)).body).toEqual([]);
  });

  it.each(['0', '1001', 'x'])('400 on ?limit=%s', async (limit) => {
    expect((await get(`/fees/${TRADER}?limit=${limit}`)).status).toBe(400);
  });

  it('400 on a malformed address', async () => {
    expect((await get('/fees/not-an-address')).status).toBe(400);
  });
});
