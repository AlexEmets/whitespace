import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedOrder, seedOrderEvent, seedOpenPosition, seedClosedPosition, seedPartialClose, TRADER, TX_A, TX_B } from './seed.js';

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

  // A close request names only the trade, and an open has no Trade payload until it fills,
  // so the row was "Market close — — —". The details come from what the order produced.
  describe('fills in side, margin, leverage and fill price from what the order produced', () => {
    const row = async (id: string) => ((await get(`/orders/${TRADER}/history`)).body as any[]).find((r) => r.id === id);

    it('an executed market open: the position it opened, at its open price', async () => {
      await seedOrder(2, { kind: 'open', status: 'executed' });
      await seedOpenPosition(); // trade 2, open_order_id 2
      expect(await row('2')).toMatchObject({ buy: true, collateral: '999.000000', leverage: '10.00', price: '65001.000000000000000000' });
    });

    it('an executed open whose position has since closed', async () => {
      await seedOrder(2, { kind: 'open', status: 'executed' });
      await seedClosedPosition(); // open_order_id 2, close_order_id 3
      expect(await row('2')).toMatchObject({ buy: true, collateral: '999.000000', leverage: '10.00', price: '65001.000000000000000000' });
    });

    it('an executed full close: the close price and the margin it closed', async () => {
      await seedOrder(3, { kind: 'close', status: 'executed', tradeId: 2 });
      await seedClosedPosition();
      expect(await row('3')).toMatchObject({ buy: true, collateral: '999.000000', leverage: '10.00', price: '64999.000000000000000000' });
    });

    it('an executed partial close: the part it closed, at its price', async () => {
      await seedOrder(5, { kind: 'close', status: 'executed', tradeId: 2 });
      await seedOpenPosition();
      await seedPartialClose({ orderId: 5 });
      expect(await row('5')).toMatchObject({ buy: true, collateral: '249.750000', leverage: '10.00', price: '65700.000000000000000000' });
    });

    it('a close still pending: side and leverage of its position, no margin or price yet', async () => {
      await seedOrder(7, { kind: 'close', status: 'pending', tradeId: 2 });
      await seedOpenPosition();
      expect(await row('7')).toMatchObject({ buy: true, collateral: null, leverage: '10.00', price: null });
    });

    it('a cancelled open borrows nothing from an unrelated position', async () => {
      await seedOrder(2, { kind: 'open', status: 'cancelled', cancelReason: 'SLIPPAGE' });
      await seedOpenPosition(); // open_order_id 2, but the order never filled
      expect(await row('2')).toMatchObject({ buy: null, collateral: null, leverage: null, price: null });
    });

    it('still returns each order exactly once', async () => {
      await seedOrder(2, { kind: 'open', status: 'executed' });
      await seedOrder(5, { kind: 'close', status: 'executed', tradeId: 2 });
      await seedOpenPosition();
      await seedPartialClose({ orderId: 5 });
      const ids = ((await get(`/orders/${TRADER}/history`)).body as any[]).map((r) => r.id);
      expect(ids.sort()).toEqual(['2', '5']);
    });
  });
});
