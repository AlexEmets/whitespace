import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { order, position, closedPosition, market, partialClose } from '../ponder.schema.js';
import {
  onMarketCloseExecuted,
  onLimitCloseExecuted,
  onTpUpdated,
  onSlUpdated,
  onTopUpCollateral,
  onRemoveCollateralExecuted,
  onBondChargedToPosition,
  onVaultLiqFeeCharged,
  onRemoveCollateralRejected,
} from '../src/lib/positions.js';

const trader = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19';
const R = { at: 2_000, txHash: '0xcc' as `0x${string}` };
const E18 = 10n ** 18n;

function seed(ctx: FakeDb, over: Record<string, unknown> = {}) {
  ctx.seed(market, { pairIndex: 0, openInterestLong: 1_000_000_000n, openInterestShort: 0n });
  ctx.seed(position, {
    tradeId: 2n,
    trader,
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: 100_000_000n, // 100 USDW
    leverage: 1000, // 10x -> 1 000 USDW notional
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

describe('position lifecycle', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
    seed(ctx);
  });

  describe('MarketCloseExecutedV2', () => {
    it('a full close moves the trade to closed_position as a trader close', async () => {
      await onMarketCloseExecuted(ctx.db, marketClose(), R);
      expect(ctx.rows(position)).toEqual([]);
      expect(ctx.get(closedPosition, { tradeId: 2n })).toMatchObject({
        closeReason: 'close',
        closePrice: 61_000n * E18,
        usdcSentToTrader: 116_000_000n,
        collateral: 100_000_000n,
        percentageClosed: 10000,
        closeOrderId: 3n,
        closedAt: 2_000,
        closeTxHash: '0xcc',
      });
      expect(ctx.get(order, { orderId: 3n })).toMatchObject({ status: 'executed', resolvedAt: 2_000 });
      expect(ctx.get(market, { pairIndex: 0 })!.openInterestLong).toBe(0n);
    });

    it('a partial close scales collateral, keeps leverage and does not close the trade', async () => {
      await onMarketCloseExecuted(ctx.db, marketClose({ percentageClosed: 2500n }), R);
      expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 75_000_000n, leverage: 1000 });
      expect(ctx.rows(closedPosition)).toEqual([]);
      expect(ctx.get(market, { pairIndex: 0 })!.openInterestLong).toBe(750_000_000n);
    });

    it('a market close that liquidated is recorded as a liquidation that paid the trader nothing', async () => {
      // closeTradeMarketCallback: when tradeValue < liqMarginValue the vault keeps the value
      // as a liquidation fee (VaultLiqFeeCharged, emitted first) and the trader is sent 0,
      // yet MarketCloseExecutedV2 still reports that value as usdcSentToTrader.
      await onVaultLiqFeeCharged(ctx.db, { orderId: 3n, tradeId: 2n, trader, amount: 4_000_000n }, R);
      await onMarketCloseExecuted(ctx.db, marketClose({ usdcSentToTrader: 4_000_000n }), R);
      expect(ctx.get(closedPosition, { tradeId: 2n })).toMatchObject({ closeReason: 'liq', usdcSentToTrader: 0n });
    });

    it('a liquidation of a different close order does not relabel this one', async () => {
      await onVaultLiqFeeCharged(ctx.db, { orderId: 8n, tradeId: 2n, trader, amount: 4_000_000n }, R);
      await onMarketCloseExecuted(ctx.db, marketClose(), R);
      expect(ctx.get(closedPosition, { tradeId: 2n })).toMatchObject({ closeReason: 'close', usdcSentToTrader: 116_000_000n });
    });

    it('a partial close records the realised part in partial_close', async () => {
      await onMarketCloseExecuted(
        ctx.db,
        marketClose({ percentageClosed: 2500n, usdcSentToTrader: 29_000_000n, percentProfit: 16_000_000n }),
        R,
      );
      expect(ctx.rows(partialClose)).toEqual([
        {
          orderId: 3n,
          tradeId: 2n,
          trader,
          pairIndex: 0,
          index: 0,
          buy: true,
          collateral: 25_000_000n, // 25 % of 100 USDW
          leverage: 1000,
          openPrice: 60_000n * E18,
          closePrice: 61_000n * E18,
          closeReason: 'close',
          percentProfit: 16_000_000n,
          usdcSentToTrader: 29_000_000n,
          percentageClosed: 2500,
          openedAt: 1_000,
          closedAt: 2_000,
          closeTxHash: '0xcc',
        },
      ]);
    });

    it('a partial close that liquidated is recorded as liq with nothing sent', async () => {
      await onVaultLiqFeeCharged(ctx.db, { orderId: 3n, tradeId: 2n, trader, amount: 1_000_000n }, R);
      await onMarketCloseExecuted(ctx.db, marketClose({ percentageClosed: 5000n, usdcSentToTrader: 1_000_000n }), R);
      expect(ctx.get(partialClose, { orderId: 3n })).toMatchObject({ closeReason: 'liq', usdcSentToTrader: 0n, collateral: 50_000_000n });
    });

    it('a full close writes no partial_close row', async () => {
      await onMarketCloseExecuted(ctx.db, marketClose(), R);
      expect(ctx.rows(partialClose)).toEqual([]);
    });

    it('an unknown trade resolves the order and touches nothing else', async () => {
      await onMarketCloseExecuted(ctx.db, marketClose({ tradeId: 99n }), R);
      expect(ctx.rows(position)).toHaveLength(1);
      expect(ctx.get(order, { orderId: 3n })!.status).toBe('executed');
    });
  });

  describe('LimitCloseExecuted', () => {
    it.each([
      [0, 'tp'],
      [1, 'sl'],
      [2, 'liq'],
    ])('orderType %i closes with reason %s', async (orderType, reason) => {
      await onLimitCloseExecuted(
        ctx.db,
        { orderId: 3n, tradeId: 2n, orderType, price: 1n, percentProfit: 0n, usdcSentToTrader: 0n },
        R,
      );
      expect(ctx.get(closedPosition, { tradeId: 2n })).toMatchObject({ closeReason: reason, percentageClosed: 10000 });
      expect(ctx.rows(position)).toEqual([]);
    });
  });

  it('TpUpdated and SlUpdated overwrite only their own field', async () => {
    await onTpUpdated(ctx.db, { tradeId: 2n, newTp: 1n });
    await onSlUpdated(ctx.db, { tradeId: 2n, newSl: 0n });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ tp: 1n, sl: 0n, collateral: 100_000_000n, leverage: 1000 });
  });

  it('TopUpCollateralExecuted adds the amount actually taken and sets the new leverage', async () => {
    await onTopUpCollateral(ctx.db, { tradeId: 2n, topUpAmount: 25_000_000n, newLeverage: 800 });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 125_000_000n, leverage: 800 });
  });

  it('RemoveCollateralExecuted subtracts, takes leverage/tp/sl from the event and resolves the order', async () => {
    await onRemoveCollateralExecuted(
      ctx.db,
      { orderId: 3n, tradeId: 2n, removeAmount: 20_000_000n, leverage: 1250, tp: 69_000n * E18, sl: 0n },
      R,
    );
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 80_000_000n, leverage: 1250, tp: 69_000n * E18, sl: 0n });
    expect(ctx.get(order, { orderId: 3n })!.status).toBe('executed');
  });

  it('RemoveCollateralRejected cancels the order with the reason and leaves the position alone', async () => {
    await onRemoveCollateralRejected(ctx.db, { orderId: 3n, reason: 7 }, R);
    expect(ctx.get(order, { orderId: 3n })).toMatchObject({
      status: 'cancelled',
      cancelReason: 'price_impact',
      resolvedAt: 2_000,
      resolvedTxHash: '0xcc',
    });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 100_000_000n });
  });

  it('OracleFeeBondCharged overwrites with the absolute post-charge state', async () => {
    await onBondChargedToPosition(ctx.db, { tradeId: 2n, collateral: 99_750_000n, leverage: 1003, tp: 1n, sl: 2n });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 99_750_000n, leverage: 1003, tp: 1n, sl: 2n });
  });

  it('a partial close followed by its bond ends at the event state, whatever the scaled value was', async () => {
    await onMarketCloseExecuted(ctx.db, marketClose({ percentageClosed: 5000n }), R);
    await onBondChargedToPosition(ctx.db, { tradeId: 2n, collateral: 49_750_000n, leverage: 1005, tp: 1n, sl: 2n });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 49_750_000n, leverage: 1005 });
  });

  it('mid-life updates for an unknown trade do not throw', async () => {
    await onTpUpdated(ctx.db, { tradeId: 9n, newTp: 1n });
    await onTopUpCollateral(ctx.db, { tradeId: 9n, topUpAmount: 1n, newLeverage: 1 });
    await onBondChargedToPosition(ctx.db, { tradeId: 9n, collateral: 1n, leverage: 1, tp: 0n, sl: 0n });
    expect(ctx.get(position, { tradeId: 2n })).toMatchObject({ collateral: 100_000_000n });
  });
});
