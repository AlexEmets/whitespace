import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedLimitOrder, TRADER, OTHER_TRADER, TX_A } from './seed.js';

describe('GET /limit-orders/:address', () => {
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

  it('returns the exact LimitOrder shape with spec decimals', async () => {
    await seedLimitOrder();
    const res = await fetch(`${server.baseUrl}/limit-orders/${TRADER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: `${TRADER}-0-0`,
        trader: TRADER,
        pairIndex: 0,
        index: 0,
        orderType: 'LIMIT',
        buy: true,
        collateral: '50.000000',
        leverage: '10.00',
        triggerPrice: '60000.000000000000000000',
        tp: '70000.000000000000000000',
        sl: '0.000000000000000000',
        placedAt: 1788882000,
        updatedAt: 1788882000,
        placedTx: TX_A,
      },
    ]);
  });

  it('newest first, both order types', async () => {
    await seedLimitOrder({ index: 0, placedAt: 100 });
    await seedLimitOrder({ index: 1, placedAt: 200, orderType: 'STOP' });
    const body = await (await fetch(`${server.baseUrl}/limit-orders/${TRADER}`)).json();
    expect(body.map((o: { index: number; orderType: string }) => [o.index, o.orderType])).toEqual([
      [1, 'STOP'],
      [0, 'LIMIT'],
    ]);
  });

  it('accepts a checksummed address and is scoped per trader', async () => {
    await seedLimitOrder();
    const checksummed = '0x2B8BA090DEdF879F8045C0DDa5a78762CED90D19';
    expect(await (await fetch(`${server.baseUrl}/limit-orders/${checksummed}`)).json()).toHaveLength(1);
    const other = `0x${'00'.repeat(19)}aa`;
    expect(await (await fetch(`${server.baseUrl}/limit-orders/${other}`)).json()).toEqual([]);
  });

  it.each(['nope', '0x1234', `${TRADER}00`, OTHER_TRADER])('400 on a malformed address %s', async (addr) => {
    const res = await fetch(`${server.baseUrl}/limit-orders/${addr}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid address' });
  });
});
