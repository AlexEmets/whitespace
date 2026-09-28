import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedOrder, seedOrderEvent, TRADER, TX_A, TX_B } from './seed.js';

const OTHER = `0x${'00'.repeat(19)}bb`;

describe('GET /orders/:address/history', () => {
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

  it('merges oracle orders and limit actions, newest first, in the exact shape', async () => {
    await seedOrder(5, { requestedAt: 100, status: 'cancelled', cancelReason: 'slippage' });
    await seedOrderEvent(`${TX_A}-3`, { at: 200, kind: 'limit_cancelled' });
    const { status, body } = await get(`/orders/${TRADER}/history`);
    expect(status).toBe(200);
    expect(body).toEqual([
      {
        source: 'limit',
        id: `${TX_A}-3`,
        orderId: null,
        kind: 'limit_cancelled',
        orderType: 'STOP',
        pairIndex: 0,
        tradeId: null,
        index: 1,
        buy: false,
        collateral: '25.000000',
        leverage: '5.00',
        price: '59000.000000000000000000',
        tp: '0.000000000000000000',
        sl: '61000.000000000000000000',
        status: 'cancelled',
        cancelReason: null,
        requestedAt: 200,
        resolvedAt: 200,
        txHash: TX_A,
      },
      {
        source: 'order',
        id: '5',
        orderId: '5',
        kind: 'open',
        orderType: 'MARKET',
        pairIndex: 0,
        tradeId: null,
        index: null,
        buy: null,
        collateral: null,
        leverage: null,
        price: null,
        tp: null,
        sl: null,
        status: 'cancelled',
        cancelReason: 'slippage',
        requestedAt: 100,
        resolvedAt: null,
        txHash: TX_B,
      },
    ]);
  });

  it('keeps resolved orders of any age (unlike the one-hour /orders view)', async () => {
    await seedOrder(1, { requestedAt: 1, status: 'executed' });
    expect((await get(`/orders/${TRADER}/history`)).body).toHaveLength(1);
  });

  it('labels only market orders MARKET and placed/updated limit actions executed', async () => {
    await seedOrder(1, { kind: 'automation_open', requestedAt: 3 });
    await seedOrder(2, { kind: 'close', requestedAt: 2 });
    await seedOrderEvent('0xa-1', { at: 1, kind: 'limit_updated' });
    const { body } = await get(`/orders/${TRADER}/history`);
    expect(body.map((e: { kind: string; orderType: string | null; status: string }) => [e.kind, e.orderType, e.status])).toEqual([
      ['automation_open', null, 'pending'],
      ['close', 'MARKET', 'pending'],
      ['limit_updated', 'STOP', 'executed'],
    ]);
  });

  it('defaults to 100 and honours ?limit across both sources', async () => {
    for (let i = 0; i < 60; i++) await seedOrder(i + 1, { requestedAt: 2 * i });
    for (let i = 0; i < 60; i++) await seedOrderEvent(`0xe-${i}`, { at: 2 * i + 1 });
    const all = (await get(`/orders/${TRADER}/history`)).body;
    expect(all).toHaveLength(100);
    expect(all[0].requestedAt).toBe(119);
    const three = (await get(`/orders/${TRADER}/history?limit=3`)).body;
    expect(three.map((e: { requestedAt: number }) => e.requestedAt)).toEqual([119, 118, 117]);
    expect((await get(`/orders/${TRADER}/history?limit=500`)).body).toHaveLength(120);
  });

  it('is scoped per trader', async () => {
    await seedOrder(1, { trader: OTHER });
    await seedOrderEvent('0xa-1', { trader: OTHER });
    expect((await get(`/orders/${TRADER}/history`)).body).toEqual([]);
    expect((await get(`/orders/${OTHER}/history`)).body).toHaveLength(2);
  });

  it.each(['0', '501', '-1', 'abc', '1.5', ''])('400 on ?limit=%s', async (limit) => {
    const { status, body } = await get(`/orders/${TRADER}/history?limit=${limit}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/limit/);
  });

  it('400 on a malformed address', async () => {
    expect((await get('/orders/0xabc/history')).status).toBe(400);
  });
});
