import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { market, order, position, limitOrder, liquidation, pointsEvent, walletPoints } from '../ponder.schema.js';
import {
  onMarketCloseExecuted,
  onLimitCloseExecuted,
  onTpUpdated,
  onSlUpdated,
  onTopUpCollateral,
  onRemoveCollateralExecuted,
} from '../src/lib/positions.js';
import { onLimitOpenExecuted } from '../src/lib/limitOrders.js';

// Wiring tests: the scoring rules themselves are proven in points.test.ts; this file proves
// the position lifecycle actually calls the engine, so a close writes points, a mid-life edit
// unlocks its mission, and a limit/stop fill unlocks the right one.

const trader = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19';
const E18 = 10n ** 18n;
const P = 1_000_000n;
// Position is 100 USDW at 10x => 1,000 USDW notional; opened at t=1000, closed at t=2000 =>
// held 1,000s (past both the 5-min time floor and the 10-min streak threshold).
const NOTIONAL = 1_000_000_000n;
const HELD = 1_000;
const R = { at: 2_000, txHash: '0xcc' as `0x${string}` };
const EXPECTED_TIME = (NOTIONAL * BigInt(HELD)) / 36_000_000n; // 27,777 (0.027777 pts)

function seed(ctx: FakeDb, over: Record<string, unknown> = {}) {
  ctx.seed(market, { pairIndex: 0, openInterestLong: 1_000_000_000n, openInterestShort: 0n });
  ctx.seed(position, {
    tradeId: 2n,
    trader,
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: 100_000_000n,
    leverage: 1000,
    openPrice: 60_000n * E18,
    tp: 70_000n * E18,
    sl: 50_000n * E18,
    isDayTrade: false,
    openOrderId: 2n,
    openTxHash: '0x01',
    openedAt: 1_000,
    openedAtBlock: 10n,
    ...over,
  });
  ctx.seed(order, { orderId: 3n, status: 'pending' });
}

const marketClose = (over: Record<string, bigint> = {}) => ({
  orderId: 3n,
  tradeId: 2n,
  price: 61_000n * E18,
  percentProfit: 166_666n,
  usdcSentToTrader: 116_000_000n,
  percentageClosed: 10000n,
  ...over,
});

describe('points wiring', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
    seed(ctx);
  });

  it('a full market close writes time-in-market and a day-streak award', async () => {
    await onMarketCloseExecuted(ctx.db, marketClose(), R);
    expect(ctx.get(walletPoints, { trader })).toMatchObject({
      timeRaw: EXPECTED_TIME,
      streakRaw: 10n * P,
      missionsRaw: 0n,
      totalRaw: EXPECTED_TIME + 10n * P,
    });
    expect(ctx.get(pointsEvent, { id: 'time-3' })).toMatchObject({ component: 'time', pointsRaw: EXPECTED_TIME });
  });

  it('a partial close unlocks the partial-close mission and scores the closed part', async () => {
    await onMarketCloseExecuted(ctx.db, marketClose({ percentageClosed: 5000n }), R);
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-partial_close` })).toMatchObject({ pointsRaw: 50n * P });
    // half the notional held the full time
    expect(ctx.get(walletPoints, { trader })).toMatchObject({ timeRaw: (NOTIONAL / 2n * BigInt(HELD)) / 36_000_000n });
  });

  it('a liquidating market close unlocks the survive-liquidation mission', async () => {
    ctx.seed(liquidation, { orderId: 3n, tradeId: 2n, trader, liquidationFee: 1n, at: R.at, txHash: R.txHash });
    await onMarketCloseExecuted(ctx.db, marketClose(), R);
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-survive_liquidation` })).toMatchObject({ pointsRaw: 50n * P });
  });

  it('a take-profit close unlocks the take-profit mission', async () => {
    await onLimitCloseExecuted(
      ctx.db,
      { orderId: 3n, tradeId: 2n, orderType: 0, price: 70_000n * E18, percentProfit: 1n, usdcSentToTrader: 1n },
      R,
    );
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-take_profit_hit` })).toMatchObject({ pointsRaw: 75n * P });
    expect(ctx.get(walletPoints, { trader })).toMatchObject({ timeRaw: EXPECTED_TIME, streakRaw: 10n * P });
  });

  it('a stop-loss close unlocks the stop-loss mission', async () => {
    await onLimitCloseExecuted(
      ctx.db,
      { orderId: 3n, tradeId: 2n, orderType: 1, price: 50_000n * E18, percentProfit: -1n, usdcSentToTrader: 1n },
      R,
    );
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-stop_loss_hit` })).toMatchObject({ pointsRaw: 75n * P });
  });

  it('a TP or SL edit unlocks the edit mission exactly once', async () => {
    await onTpUpdated(ctx.db, { tradeId: 2n, newTp: 1n }, R);
    await onSlUpdated(ctx.db, { tradeId: 2n, newSl: 2n }, R);
    expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 50n * P }); // edit_tp_sl, once
  });

  it('adding and removing margin both count as the margin-edit mission (once)', async () => {
    await onTopUpCollateral(ctx.db, { tradeId: 2n, topUpAmount: 1n, newLeverage: 1001 }, R);
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-margin_edit` })).toMatchObject({ pointsRaw: 50n * P });
    // a later removal does not double-award
    await onRemoveCollateralExecuted(
      ctx.db,
      { orderId: 3n, tradeId: 2n, removeAmount: 1n, leverage: 1000, tp: 1n, sl: 2n },
      R,
    );
    expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 50n * P });
  });

  it('filling a resting LIMIT unlocks limit_filled; a STOP unlocks stop_triggered', async () => {
    ctx.seed(limitOrder, { id: `${trader}-0-0`, trader, pairIndex: 0, index: 0, orderType: 'LIMIT' });
    const meta = { txHash: '0xaa' as `0x${string}`, logIndex: 0, blockNumber: 5n, timestamp: 3_000 };
    await onLimitOpenExecuted(ctx.db, { orderId: 7n, limitIndex: 0n, t: { trader, pairIndex: 0 } }, 7n, meta);
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-limit_filled` })).toMatchObject({ pointsRaw: 75n * P });

    ctx.seed(limitOrder, { id: `${trader}-0-1`, trader, pairIndex: 0, index: 1, orderType: 'STOP' });
    const meta2 = { txHash: '0xbb' as `0x${string}`, logIndex: 0, blockNumber: 6n, timestamp: 3_100 };
    await onLimitOpenExecuted(ctx.db, { orderId: 8n, limitIndex: 1n, t: { trader, pairIndex: 0 } }, 8n, meta2);
    expect(ctx.get(pointsEvent, { id: `mission-${trader}-stop_triggered` })).toMatchObject({ pointsRaw: 75n * P });
  });

  it('a sub-5-minute scalp closes without writing any points', async () => {
    await onMarketCloseExecuted(ctx.db, marketClose(), { at: 1_100, txHash: '0xdd' }); // held 100s
    expect(ctx.rows(pointsEvent)).toEqual([]);
    expect(ctx.rows(walletPoints)).toEqual([]);
  });
});
