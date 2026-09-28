import { ponder } from 'ponder:registry';
import { order, position } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';
import { tradeIdFromOpenOrderId } from '../lib/tradeId.js';
import { cancelReasonLabel } from '../lib/enums.js';
import { recordTick, quoteNotional } from '../lib/candleTick.js';
import { onLimitOpenExecuted } from '../lib/limitOrders.js';
import { toMeta } from '../lib/event.js';
import {
  adjustOpenInterest,
  onMarketCloseExecuted,
  onLimitCloseExecuted,
  onRemoveCollateralExecuted,
  onBondChargedToPosition,
  onVaultLiqFeeCharged,
  onRemoveCollateralRejected,
  type Resolution,
} from '../lib/positions.js';
import { onTradeFee, onFeesChargedV2, onOracleFeeBondCharged } from '../lib/fees.js';

function resolution(event: { block: { timestamp: bigint }; transaction: { hash: `0x${string}` } }): Resolution {
  return { at: Number(event.block.timestamp), txHash: event.transaction.hash };
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

  // The resting order is gone from storage (unregisterOpenLimitOrder), so it must be gone
  // from limit_order too — the automation bot reads that table as its trigger set.
  await onLimitOpenExecuted(context.db, event.args, tradeId, toMeta(event));

  const notional = quoteNotional(t.collateral, t.leverage);
  await adjustOpenInterest(context.db, t.pairIndex, t.buy, notional, 'LimitOpenExecuted->market.OI');
  await recordTick(context.db, t.pairIndex, openedAt, t.openPrice, notional);
});

// --- Closes (logic in src/lib/positions.ts) ---------------------------------

ponder.on('TradingCallbacks:MarketCloseExecutedV2', async ({ event, context }) => {
  await onMarketCloseExecuted(context.db, event.args, resolution(event));
});

ponder.on('TradingCallbacks:LimitCloseExecuted', async ({ event, context }) => {
  await onLimitCloseExecuted(context.db, event.args, resolution(event));
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
  await onRemoveCollateralExecuted(context.db, event.args, resolution(event));
});

ponder.on('TradingCallbacks:RemoveCollateralRejected', async ({ event, context }) => {
  await onRemoveCollateralRejected(context.db, event.args, resolution(event));
});

// --- Oracle-fee bond charged out of a position's own collateral (see
// onBondChargedToPosition). No order row to touch here — MarketCloseCanceled /
// MarketCloseExecutedV2 already resolve it. ---------------------------------------------

ponder.on('TradingCallbacks:OracleFeeBondCharged', async ({ event, context }) => {
  // Before the position update: the fee's fallback amount is the collateral it removed.
  await onOracleFeeBondCharged(context.db, event.args, toMeta(event));
  await onBondChargedToPosition(context.db, event.args);
});

// --- Fees (fee_charge; see src/lib/fees.ts for the event -> kind mapping) --------------

ponder.on('TradingCallbacks:OracleFeeCharged', async ({ event, context }) => {
  await onTradeFee(context.db, 'oracle', event.args, toMeta(event));
});

ponder.on('TradingCallbacks:DevFeeCharged', async ({ event, context }) => {
  await onTradeFee(context.db, 'dev', event.args, toMeta(event));
});

ponder.on('TradingCallbacks:VaultOpeningFeeCharged', async ({ event, context }) => {
  await onTradeFee(context.db, 'vault_opening', event.args, toMeta(event));
});

ponder.on('TradingCallbacks:VaultLiqFeeCharged', async ({ event, context }) => {
  await onTradeFee(context.db, 'vault_liq', event.args, toMeta(event));
  await onVaultLiqFeeCharged(context.db, event.args, resolution(event));
});

ponder.on('TradingCallbacks:FeesChargedV2', async ({ event, context }) => {
  await onFeesChargedV2(context.db, event.args, toMeta(event));
});
