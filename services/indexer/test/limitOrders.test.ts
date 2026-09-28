import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { limitOrder, orderEvent } from '../ponder.schema.js';
import {
  onOpenLimitPlaced,
  onOpenLimitUpdated,
  onOpenLimitCanceled,
  onLimitOpenExecuted,
  automationOpenOrderDetails,
  limitOrderId,
  type EventMeta,
} from '../src/lib/limitOrders.js';

// Checksummed on purpose: viem decodes addresses checksummed, and the spec (§9) stores
// them lowercase — the id and trader column must not depend on the event's casing.
const TRADER = '0x2B8BA090DEdF879F8045C0DDa5a78762CED90D19' as const;
const trader = TRADER.toLowerCase();

const meta = (logIndex: number, timestamp = 1_000, tx = '0xaa'): EventMeta => ({
  txHash: tx as `0x${string}`,
  logIndex,
  blockNumber: 100n,
  timestamp,
});

const trade = {
  collateral: 50_000_000n,
  openPrice: 60_000n * 10n ** 18n,
  tp: 70_000n * 10n ** 18n,
  sl: 55_000n * 10n ** 18n,
  trader: TRADER,
  leverage: 1000,
  pairIndex: 0,
  index: 2,
  buy: true,
  isDayTrade: false,
};

async function place(ctx: FakeDb, orderType = 1, index = 2, at = 1_000) {
  await onOpenLimitPlaced(ctx.db, { trader: TRADER, pairIndex: 0, index, trade: { ...trade, index }, orderType }, meta(1, at));
}

describe('limit orders', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
  });

  it('keys the slot with a lowercase trader', () => {
    expect(limitOrderId(TRADER, 3, 1)).toBe(`${trader}-3-1`);
  });

  it('OpenLimitPlacedV2 writes the resting order exactly as the spec columns describe', async () => {
    await place(ctx);
    expect(ctx.rows(limitOrder)).toEqual([
      {
        id: `${trader}-0-2`,
        trader,
        pairIndex: 0,
        index: 2,
        orderType: 'LIMIT',
        buy: true,
        collateral: 50_000_000n,
        leverage: 1000,
        triggerPrice: trade.openPrice,
        tp: trade.tp,
        sl: trade.sl,
        placedAt: 1_000,
        updatedAt: 1_000,
        placedTx: '0xaa',
      },
    ]);
    const [ev] = ctx.rows(orderEvent);
    expect(ev).toMatchObject({ id: '0xaa-1', kind: 'limit_placed', orderType: 'LIMIT', trader, triggerPrice: trade.openPrice });
  });

  it('labels a STOP entry STOP', async () => {
    await place(ctx, 2);
    expect(ctx.rows(limitOrder)[0].orderType).toBe('STOP');
  });

  it('a placement into a reused slot replaces a stale row instead of throwing', async () => {
    ctx.seed(limitOrder, {
      id: `${trader}-0-2`,
      trader,
      pairIndex: 0,
      index: 2,
      orderType: 'STOP',
      buy: false,
      collateral: 1n,
      leverage: 200,
      triggerPrice: 1n,
      tp: 0n,
      sl: 0n,
      placedAt: 1,
      updatedAt: 1,
      placedTx: '0x01',
    });
    await place(ctx, 1, 2, 5_000);
    const [row] = ctx.rows(limitOrder);
    expect(row).toMatchObject({ orderType: 'LIMIT', buy: true, collateral: 50_000_000n, placedAt: 5_000, placedTx: '0xaa' });
    expect(ctx.rows(limitOrder)).toHaveLength(1);
  });

  it('OpenLimitUpdated moves price, tp and sl and nothing else', async () => {
    await place(ctx);
    await onOpenLimitUpdated(
      ctx.db,
      { trader: TRADER, pairIndex: 0, index: 2, newPrice: 1n, newTp: 2n, newSl: 3n },
      meta(7, 2_000, '0xbb'),
    );
    const [row] = ctx.rows(limitOrder);
    expect(row).toMatchObject({ triggerPrice: 1n, tp: 2n, sl: 3n, updatedAt: 2_000, placedAt: 1_000, collateral: 50_000_000n, placedTx: '0xaa' });
    const ev = ctx.get(orderEvent, { id: '0xbb-7' });
    expect(ev).toMatchObject({ kind: 'limit_updated', triggerPrice: 1n, tp: 2n, sl: 3n, collateral: 50_000_000n, orderType: 'LIMIT' });
  });

  it('OpenLimitUpdated for an unknown slot records history without inventing a resting order', async () => {
    await onOpenLimitUpdated(
      ctx.db,
      { trader: TRADER, pairIndex: 0, index: 9, newPrice: 1n, newTp: 2n, newSl: 3n },
      meta(7),
    );
    expect(ctx.rows(limitOrder)).toEqual([]);
    expect(ctx.rows(orderEvent)[0]).toMatchObject({ kind: 'limit_updated', index: 9, orderType: null, collateral: null, triggerPrice: 1n });
  });

  it('OpenLimitCanceled removes the resting order and keeps its details in history', async () => {
    await place(ctx);
    await onOpenLimitCanceled(ctx.db, { trader: TRADER, pairIndex: 0, index: 2 }, meta(4, 3_000, '0xcc'));
    expect(ctx.rows(limitOrder)).toEqual([]);
    expect(ctx.get(orderEvent, { id: '0xcc-4' })).toMatchObject({
      kind: 'limit_cancelled',
      collateral: 50_000_000n,
      orderType: 'LIMIT',
      at: 3_000,
    });
  });

  it('OpenLimitCanceled for an unknown slot does not throw', async () => {
    await onOpenLimitCanceled(ctx.db, { trader: TRADER, pairIndex: 0, index: 2 }, meta(4));
    expect(ctx.rows(orderEvent)[0]).toMatchObject({ kind: 'limit_cancelled', collateral: null });
  });

  it('LimitOpenExecuted frees the LIMIT slot (limitIndex), not the new trade slot (t.index)', async () => {
    await place(ctx, 1, 2);
    await place(ctx, 1, 0);
    await onLimitOpenExecuted(
      ctx.db,
      { orderId: 42n, limitIndex: 2n, t: { trader: TRADER, pairIndex: 0 } },
      42n,
      meta(9, 4_000, '0xdd'),
    );
    expect(ctx.rows(limitOrder).map((r) => r.index)).toEqual([0]);
    expect(ctx.get(orderEvent, { id: '0xdd-9' })).toMatchObject({ kind: 'limit_executed', index: 2, orderId: 42n, tradeId: 42n });
  });

  it('only the owning trader and pair are touched', async () => {
    await place(ctx);
    await onOpenLimitCanceled(ctx.db, { trader: '0x00000000000000000000000000000000000000aa', pairIndex: 0, index: 2 }, meta(5));
    await onOpenLimitCanceled(ctx.db, { trader: TRADER, pairIndex: 1, index: 2 }, meta(6));
    expect(ctx.rows(limitOrder)).toHaveLength(1);
  });

  it('an automation open order inherits size and side from the resting order', async () => {
    await place(ctx);
    expect(await automationOpenOrderDetails(ctx.db, TRADER, 0, 2)).toEqual({ buy: true, collateral: 50_000_000n, leverage: 1000 });
    expect(await automationOpenOrderDetails(ctx.db, TRADER, 0, 1)).toEqual({ buy: null, collateral: null, leverage: null });
  });
});
