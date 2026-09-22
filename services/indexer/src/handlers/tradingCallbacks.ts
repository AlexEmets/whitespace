import { ponder } from 'ponder:registry';
import { order, position, closedPosition, market } from '../../ponder.schema.js';
import { updateIfExists, findOrWarn } from '../lib/db.js';
import { tradeIdFromOpenOrderId } from '../lib/tradeId.js';
import { limitOrderLabel, cancelReasonLabel } from '../lib/enums.js';
import { recordTick, quoteNotional } from '../lib/candleTick.js';

const FULL_CLOSE_PCT = 10000n; // PRECISION_2, 10000 = 100%

type MarketRow = { openInterestLong: bigint; openInterestShort: bigint };

async function adjustOpenInterest(
  db: Parameters<typeof updateIfExists>[0],
  pairIndex: number,
  buy: boolean,
  deltaNotional: bigint,
  context: string,
): Promise<void> {
  await updateIfExists(
    db,
    market,
    { pairIndex },
    (row: MarketRow) =>
      buy
        ? { openInterestLong: row.openInterestLong + deltaNotional }
        : { openInterestShort: row.openInterestShort + deltaNotional },
    context,
  );
}

// --- Opens -------------------------------------------------------------------
// tradeId === the open order's orderId — see src/lib/tradeId.ts for why.

ponder.on('TradingCallbacks:MarketOpenExecuted', async ({ event, context }) => {
  const t = event.args.t;
  const tradeId = tradeIdFromOpenOrderId(event.args.orderId);
  const openedAt = Number(event.block.timestamp);

  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    { status: 'executed', resolvedAt: openedAt, resolvedTxHash: event.transaction.hash },
    'MarketOpenExecuted->order',
  );

  await context.db
    .insert(position)
    .values({
      tradeId,
      trader: t.trader,
      pairIndex: t.pairIndex,
      index: t.index,
      buy: t.buy,
      collateral: t.collateral,
      leverage: t.leverage,
      openPrice: t.openPrice,
      tp: t.tp,
      sl: t.sl,
      isDayTrade: t.isDayTrade,
      openOrderId: event.args.orderId,
      openTxHash: event.transaction.hash,
      openedAt,
      openedAtBlock: event.block.number,
    })
    .onConflictDoUpdate({});

  const notional = quoteNotional(t.collateral, t.leverage);
  await adjustOpenInterest(context.db, t.pairIndex, t.buy, notional, 'MarketOpenExecuted->market.OI');
  await recordTick(context.db, t.pairIndex, openedAt, t.openPrice, notional);
});

ponder.on('TradingCallbacks:LimitOpenExecuted', async ({ event, context }) => {
  const t = event.args.t;
  const tradeId = tradeIdFromOpenOrderId(event.args.orderId);
  const openedAt = Number(event.block.timestamp);

  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    { status: 'executed', resolvedAt: openedAt, resolvedTxHash: event.transaction.hash },
    'LimitOpenExecuted->order',
  );

  await context.db
    .insert(position)
    .values({
      tradeId,
      trader: t.trader,
      pairIndex: t.pairIndex,
      index: t.index,
      buy: t.buy,
      collateral: t.collateral,
      leverage: t.leverage,
      openPrice: t.openPrice,
      tp: t.tp,
      sl: t.sl,
      isDayTrade: t.isDayTrade,
      openOrderId: event.args.orderId,
      openTxHash: event.transaction.hash,
      openedAt,
      openedAtBlock: event.block.number,
    })
    .onConflictDoUpdate({});

  const notional = quoteNotional(t.collateral, t.leverage);
  await adjustOpenInterest(context.db, t.pairIndex, t.buy, notional, 'LimitOpenExecuted->market.OI');
  await recordTick(context.db, t.pairIndex, openedAt, t.openPrice, notional);
});

// --- Closes ------------------------------------------------------------------
// MarketCloseExecutedV2 supports partial closes (percentageClosed < 10000):
// the position stays open with reduced collateral and is NOT written to
// closedPosition (that table models "this trade is over", which a partial
// close isn't) — see docs/decisions/phase-4-indexer-api.md for the scope
// note on partial-close realized-PnL history. LimitCloseExecuted (TP/SL/LIQ)
// has no percentage field in the interface — it is always a full close.

ponder.on('TradingCallbacks:MarketCloseExecutedV2', async ({ event, context }) => {
  const { orderId, tradeId, price, percentProfit, usdcSentToTrader, percentageClosed } = event.args;
  const closedAt = Number(event.block.timestamp);

  await updateIfExists(
    context.db,
    order,
    { orderId },
    { status: 'executed', resolvedAt: closedAt, resolvedTxHash: event.transaction.hash },
    'MarketCloseExecutedV2->order',
  );

  const pos = await findOrWarn<{
    trader: `0x${string}`;
    pairIndex: number;
    index: number;
    buy: boolean;
    collateral: bigint;
    leverage: number;
    openPrice: bigint;
    tp: bigint;
    sl: bigint;
    openOrderId: bigint;
    openedAt: number;
  }>(context.db, position, { tradeId }, 'MarketCloseExecutedV2->position');
  if (!pos) return;

  const originalNotional = quoteNotional(pos.collateral, pos.leverage);
  const closedNotional = (originalNotional * percentageClosed) / FULL_CLOSE_PCT;
  await adjustOpenInterest(context.db, pos.pairIndex, pos.buy, -closedNotional, 'MarketCloseExecutedV2->market.OI');
  await recordTick(context.db, pos.pairIndex, closedAt, price, closedNotional);

  if (percentageClosed >= FULL_CLOSE_PCT) {
    await context.db.delete(position, { tradeId });
    await context.db
      .insert(closedPosition)
      .values({
        tradeId,
        trader: pos.trader,
        pairIndex: pos.pairIndex,
        index: pos.index,
        buy: pos.buy,
        collateral: pos.collateral,
        leverage: pos.leverage,
        openPrice: pos.openPrice,
        closePrice: price,
        tp: pos.tp,
        sl: pos.sl,
        closeReason: 'close',
        percentProfit,
        usdcSentToTrader,
        percentageClosed: Number(percentageClosed),
        openOrderId: pos.openOrderId,
        closeOrderId: orderId,
        openedAt: pos.openedAt,
        closedAt,
        closeTxHash: event.transaction.hash,
      })
      .onConflictDoUpdate({});
  } else {
    const removedCollateral = (pos.collateral * percentageClosed) / FULL_CLOSE_PCT;
    await context.db
      .update(position, { tradeId })
      .set({ collateral: pos.collateral - removedCollateral });
  }
});

ponder.on('TradingCallbacks:LimitCloseExecuted', async ({ event, context }) => {
  const { orderId, tradeId, orderType, price, percentProfit, usdcSentToTrader } = event.args;
  const closedAt = Number(event.block.timestamp);

  await updateIfExists(
    context.db,
    order,
    { orderId },
    { status: 'executed', resolvedAt: closedAt, resolvedTxHash: event.transaction.hash },
    'LimitCloseExecuted->order',
  );

  const pos = await findOrWarn<{
    trader: `0x${string}`;
    pairIndex: number;
    index: number;
    buy: boolean;
    collateral: bigint;
    leverage: number;
    openPrice: bigint;
    tp: bigint;
    sl: bigint;
    openOrderId: bigint;
    openedAt: number;
  }>(context.db, position, { tradeId }, 'LimitCloseExecuted->position');
  if (!pos) return;

  const notional = quoteNotional(pos.collateral, pos.leverage);
  await adjustOpenInterest(context.db, pos.pairIndex, pos.buy, -notional, 'LimitCloseExecuted->market.OI');
  await recordTick(context.db, pos.pairIndex, closedAt, price, notional);

  await context.db.delete(position, { tradeId });
  await context.db
    .insert(closedPosition)
    .values({
      tradeId,
      trader: pos.trader,
      pairIndex: pos.pairIndex,
      index: pos.index,
      buy: pos.buy,
      collateral: pos.collateral,
      leverage: pos.leverage,
      openPrice: pos.openPrice,
      closePrice: price,
      tp: pos.tp,
      sl: pos.sl,
      closeReason: limitOrderLabel(orderType), // 'liq' for liquidations, 'tp', 'sl', ...
      percentProfit,
      usdcSentToTrader,
      percentageClosed: 10000,
      openOrderId: pos.openOrderId,
      closeOrderId: orderId,
      openedAt: pos.openedAt,
      closedAt,
      closeTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});

// --- Cancellations -------------------------------------------------------

ponder.on('TradingCallbacks:MarketOpenCanceled', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'cancelled',
      cancelReason: cancelReasonLabel(event.args.cancelReason),
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'MarketOpenCanceled',
  );
});

ponder.on('TradingCallbacks:MarketCloseCanceled', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'cancelled',
      cancelReason: cancelReasonLabel(event.args.cancelReason),
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'MarketCloseCanceled',
  );
});

ponder.on('TradingCallbacks:AutomationOpenOrderCanceled', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'cancelled',
      cancelReason: cancelReasonLabel(event.args.cancelReason),
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'AutomationOpenOrderCanceled',
  );
});

ponder.on('TradingCallbacks:AutomationCloseOrderCanceled', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'cancelled',
      cancelReason: cancelReasonLabel(event.args.cancelReason),
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'AutomationCloseOrderCanceled',
  );
});

// --- Collateral removal executed (Callbacks side of the Trading-initiated
// remove-collateral sub-flow) ------------------------------------------------

ponder.on('TradingCallbacks:RemoveCollateralExecuted', async ({ event, context }) => {
  const { orderId, tradeId, removeAmount, leverage, tp, sl } = event.args;
  const resolvedAt = Number(event.block.timestamp);

  await updateIfExists(
    context.db,
    order,
    { orderId },
    { status: 'executed', resolvedAt, resolvedTxHash: event.transaction.hash },
    'RemoveCollateralExecuted->order',
  );

  await updateIfExists(
    context.db,
    position,
    { tradeId },
    (row: { collateral: bigint }) => ({
      collateral: row.collateral - removeAmount,
      leverage,
      tp,
      sl,
    }),
    'RemoveCollateralExecuted->position',
  );
});

// --- Oracle-fee bond charged out of a position's own collateral (a cancelled close or a
// partial close) — OstiumTradingCallbacks._chargeBondFromPosition. Carries the position's
// resulting absolute state, so this simply overwrites rather than subtracting a delta like
// RemoveCollateralExecuted above: for the partial-close path the contract re-reads the trade
// from storage AFTER the close has already scaled collateral down, so `collateral` here is
// already the final post-close, post-charge value regardless of handler ordering. No order
// row to touch here — MarketCloseCanceled/MarketCloseExecutedV2 already resolve it. ------

ponder.on('TradingCallbacks:OracleFeeBondCharged', async ({ event, context }) => {
  const { tradeId, collateral, leverage, tp, sl } = event.args;

  await updateIfExists(
    context.db,
    position,
    { tradeId },
    { collateral, leverage, tp, sl },
    'OracleFeeBondCharged->position',
  );
});
