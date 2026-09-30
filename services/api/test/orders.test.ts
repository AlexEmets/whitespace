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
        // 1788882000 is far in the past, so this pending market order is past the fill
        // window — flagged expired, but kept because it is reclaimable.
        expired: true,
        requestedAt: 1788882000,
        // The block, not just the timestamp: the trader's timeout refund is gated on
        // `block.number >= requestBlock + marketOrdersTimeout`, so the client needs the
        // same unit the contract compares in.
        requestedAtBlock: '7285600',
        resolvedAt: null,
        cancelReason: null,
      },
    ]);
  });

  /**
   * The order lifecycle has to stay observable after the order stops being pending.
   * This endpoint used to serve pending orders only, which made the "Filled" and
   * "Cancelled" branches in the UI unreachable — the order-entry panel sat on "nothing
   * has happened yet" while the position it had just opened showed in the table below.
   */
  it('returns a recently executed order, so the fill is observable', async () => {
    await seedPendingOrder();
    const now = Math.floor(Date.now() / 1000);
    await getPool().query(`UPDATE "order" SET status = 'executed', resolved_at = $1, trade_id = 7 WHERE order_id = 99`, [
      now - 30,
    ]);
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('executed');
    expect(body[0].resolvedAt).toBe(now - 30);
    expect(body[0].tradeId).toBe('7');
  });

  it('returns a recently cancelled order with the reason the UI explains to the trader', async () => {
    await seedPendingOrder();
    const now = Math.floor(Date.now() / 1000);
    await getPool().query(
      `UPDATE "order" SET status = 'cancelled', resolved_at = $1, cancel_reason = 'SLIPPAGE' WHERE order_id = 99`,
      [now - 10],
    );
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('cancelled');
    expect(body[0].cancelReason).toBe('SLIPPAGE');
  });

  it('drops a resolved order once it ages out of the window, so the list stays a lifecycle view', async () => {
    await seedPendingOrder();
    // Two hours ago — past the one-hour window the route keeps resolved orders for.
    await getPool().query(`UPDATE "order" SET status = 'executed', resolved_at = $1 WHERE order_id = 99`, [
      Math.floor(Date.now() / 1000) - 7200,
    ]);
    const res = await fetch(`${server.baseUrl}/orders/${TRADER}`);
    expect(await res.json()).toEqual([]);
  });

  it('keeps a pending order regardless of age — it has not resolved, so it never ages out', async () => {
    // seedPendingOrder's requested_at is far older than the resolved-order window; a
    // pending order must survive it, or a trader whose keeper is stuck would watch their
    // own open order disappear from the UI.
    await seedPendingOrder();
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('pending');
  });

  it('flags a fresh pending order as not expired', async () => {
    await seedPendingOrder();
    // Pull the request time up to now: within the fill window, so it can still fill.
    await getPool().query(`UPDATE "order" SET requested_at = $1 WHERE order_id = 99`, [Math.floor(Date.now() / 1000)]);
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('pending');
    expect(body[0].expired).toBe(false);
  });

  /**
   * A market open past the fill window stays visible: its collateral is locked and only the
   * trader's openTradeMarketTimeout gets it back, so the row (and its reclaim button) must
   * remain. This is the counterpart to the automation case below — same age, opposite fate,
   * because only one of them has a recovery path.
   */
  it('keeps a stale MARKET order (it is reclaimable) but marks it expired', async () => {
    await seedPendingOrder(); // kind 'open', requested_at far in the past
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].kind).toBe('open');
    expect(body[0].expired).toBe(true);
  });

  /**
   * An automation order is a triggered resting-limit order: its collateral is on the limit
   * order, not here, and openTradeMarketTimeout reverts NoTradeToTimeoutFound — there is no
   * per-order recovery and nothing on chain ever resolves it. Left in, it sits "waiting for
   * keeper" forever. Once past the fill window it is dropped, which is the only way those
   * dead rows leave the UI.
   */
  it('drops a stale AUTOMATION order — it can never fill and has no recovery path', async () => {
    await seedPendingOrder();
    await getPool().query(`UPDATE "order" SET kind = 'automation_open' WHERE order_id = 99`);
    const res = await fetch(`${server.baseUrl}/orders/${TRADER}`);
    expect(await res.json()).toEqual([]);
  });

  it('keeps a FRESH automation order — it may still fill', async () => {
    await seedPendingOrder();
    await getPool().query(`UPDATE "order" SET kind = 'automation_open', requested_at = $1 WHERE order_id = 99`, [
      Math.floor(Date.now() / 1000),
    ]);
    const body = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    expect(body).toHaveLength(1);
    expect(body[0].kind).toBe('automation_open');
    expect(body[0].expired).toBe(false);
  });

  it('orders are scoped per-trader (filter proven both ways)', async () => {
    await seedPendingOrder();
    const mine = await (await fetch(`${server.baseUrl}/orders/${TRADER}`)).json();
    const theirs = await (await fetch(`${server.baseUrl}/orders/${OTHER_TRADER}`)).json();
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
