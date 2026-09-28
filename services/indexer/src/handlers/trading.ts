import { ponder } from 'ponder:registry';
import { order } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';
import {
  onOpenLimitPlaced,
  onOpenLimitUpdated,
  onOpenLimitCanceled,
  automationOpenOrderDetails,
} from '../lib/limitOrders.js';
import { toMeta as meta } from '../lib/event.js';
import { onOracleFeeChargedLimitCancelled } from '../lib/fees.js';
import { onTpUpdated, onSlUpdated, onTopUpCollateral } from '../lib/positions.js';

// --- Limit / stop entries (see src/lib/limitOrders.ts for which event fires when) ----

ponder.on('Trading:OpenLimitPlacedV2', async ({ event, context }) => {
  await onOpenLimitPlaced(context.db, event.args, meta(event));
});

ponder.on('Trading:OpenLimitUpdated', async ({ event, context }) => {
  await onOpenLimitUpdated(context.db, event.args, meta(event));
});

ponder.on('Trading:OracleFeeChargedLimitCancelled', async ({ event, context }) => {
  await onOracleFeeChargedLimitCancelled(context.db, event.args, meta(event));
});

ponder.on('Trading:OpenLimitCanceled', async ({ event, context }) => {
  await onOpenLimitCanceled(context.db, event.args, meta(event));
});

// --- Order requests (phase 1 of the two-phase flow) ------------------------
// Note: none of these "initiated" events carry collateral/leverage/buy — the
// Trade payload only appears in the execution event (MarketOpenExecuted).
// GET /orders/:address therefore cannot show collateral/leverage for a still
// -pending open order; see docs/decisions/phase-4-indexer-api.md.

ponder.on('Trading:MarketOpenOrderInitiated', async ({ event, context }) => {
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'open',
      tradeId: null,
      index: null,
      buy: null,
      collateral: null,
      leverage: null,
      status: 'pending',
      requestedAt: Number(event.block.timestamp),
      requestedAtBlock: event.block.number,
      requestTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});

ponder.on('Trading:MarketCloseOrderInitiatedV2', async ({ event, context }) => {
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'close',
      tradeId: event.args.tradeId,
      index: null,
      buy: null,
      collateral: null,
      leverage: null,
      status: 'pending',
      requestedAt: Number(event.block.timestamp),
      requestedAtBlock: event.block.number,
      requestTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});

ponder.on('Trading:AutomationOpenOrderInitiated', async ({ event, context }) => {
  const details = await automationOpenOrderDetails(
    context.db,
    event.args.trader,
    event.args.pairIndex,
    event.args.index,
  );
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'automation_open',
      tradeId: null,
      index: event.args.index,
      ...details,
      status: 'pending',
      requestedAt: Number(event.block.timestamp),
      requestedAtBlock: event.block.number,
      requestTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});

ponder.on('Trading:AutomationCloseOrderInitiated', async ({ event, context }) => {
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'automation_close',
      tradeId: event.args.tradeId,
      index: null,
      buy: null,
      collateral: null,
      leverage: null,
      status: 'pending',
      requestedAt: Number(event.block.timestamp),
      requestedAtBlock: event.block.number,
      requestTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});

// --- Timeouts (design §7: "Keeper down -> openTradeMarketTimeout, trader
// reclaims collateral") ------------------------------------------------------

ponder.on('Trading:MarketOpenTimeoutExecutedV2', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'timeout',
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'MarketOpenTimeoutExecutedV2',
  );
});

ponder.on('Trading:MarketCloseTimeoutExecutedV2', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'timeout',
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'MarketCloseTimeoutExecutedV2',
  );
});

// --- Position updates that don't open/close a trade -------------------------

ponder.on('Trading:TpUpdated', async ({ event, context }) => {
  await onTpUpdated(context.db, event.args);
});

ponder.on('Trading:SlUpdated', async ({ event, context }) => {
  await onSlUpdated(context.db, event.args);
});

ponder.on('Trading:TopUpCollateralExecuted', async ({ event, context }) => {
  await onTopUpCollateral(context.db, event.args);
});

// --- Collateral removal (its own sub-flow, own orderId) ---------------------

ponder.on('Trading:RemoveCollateralInitiated', async ({ event, context }) => {
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'remove_collateral',
      tradeId: event.args.tradeId,
      index: null,
      buy: null,
      collateral: event.args.removeAmount,
      leverage: null,
      status: 'pending',
      requestedAt: Number(event.block.timestamp),
      requestedAtBlock: event.block.number,
      requestTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({});
});
