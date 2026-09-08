import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedPendingOrder, TRADER, OTHER_TRADER } from './seed.js';
import { getPool } from '../src/db.js';

describe('GET /orders/:address', () => {
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

  it('returns an empty array when there are no pending orders', async () => {
    const res = await fetch(`${server.baseUrl}/orders/${OTHER_TRADER}`);
    expect(await res.json()).toEqual([]);
  });

  it('returns a pending open order', async () => {
    await seedPendingOrder();
    const res = await fetch(`${server.baseUrl}/orders/${TRADER}`);
    const body = await res.json();
    expect(body).toEqual([
      {
        orderId: '99',
        kind: 'open',
        pairIndex: 0,
        tradeId: null,
        index: null,
        buy: null,
        collateral: null,
        leverage: null,
        status: 'pending',
        requestedAt: 1788882000,
      },
    ]);
  });

  it('does NOT return an order once it is executed (only pending orders are served)', async () => {
    await seedPendingOrder();
    await getPool().query(`UPDATE "order" SET status = 'executed' WHERE order_id = 99`);
    const res = await fetch(`${server.baseUrl}/orders/${TRADER}`);
    expect(await res.json()).toEqual([]);
  });

  it('orders are scoped per-trader (filter proven both ways)', async () => {
    await seedPendingOrder();
    const mine = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    const theirs = await (await fetch(`${server.baseUrl}/orders/${OTHER_TRADER}`)).json();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
