import { ponder } from 'ponder:registry';
import { order, position } from '../../ponder.schema.js';
import { updateIfExists } from '../lib/db.js';

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
  await context.db
    .insert(order)
    .values({
      orderId: event.args.orderId,
      trader: event.args.trader,
      pairIndex: event.args.pairIndex,
      kind: 'automation_open',
      tradeId: null,
      index: event.args.index,
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
  await updateIfExists(
    context.db,
    position,
    { tradeId: event.args.tradeId },
    { tp: event.args.newTp },
    'TpUpdated',
  );
});

ponder.on('Trading:SlUpdated', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    position,
    { tradeId: event.args.tradeId },
    { sl: event.args.newSl },
    'SlUpdated',
  );
});

ponder.on('Trading:TopUpCollateralExecuted', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    position,
    { tradeId: event.args.tradeId },
    (row: { collateral: bigint }) => ({
      collateral: row.collateral + event.args.topUpAmount,
      leverage: event.args.newLeverage,
    }),
    'TopUpCollateralExecuted',
  );
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

ponder.on('Trading:RemoveCollateralRejected', async ({ event, context }) => {
  await updateIfExists(
    context.db,
    order,
    { orderId: event.args.orderId },
    {
      status: 'cancelled',
      cancelReason: event.args.reason, // free-text from the contract, not an enum
      resolvedAt: Number(event.block.timestamp),
      resolvedTxHash: event.transaction.hash,
    },
    'RemoveCollateralRejected',
  );
});
