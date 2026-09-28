import { limitOrder, orderEvent } from '../../ponder.schema.js';
import { openOrderTypeLabel } from './enums.js';

// Handler logic for resting LIMIT/STOP entries. Kept out of src/handlers (which import
// the `ponder:registry` virtual module and so cannot load under vitest) so it can be
// exercised against test/fakeDb.ts.
//
// Which events fire, read from the vendored contracts:
//   - OstiumTrading.openTrade with orderType LIMIT/STOP -> OpenLimitPlacedV2 only
//     (OpenLimitPlaced, the V1 event, is never emitted). The event carries the full
//     Trade and the OpenOrderType, so no storage read is needed.
//   - updateOpenLimitOrder -> OpenLimitUpdated(price, tp, sl). Collateral, leverage and
//     direction cannot change.
//   - cancelOpenLimitOrder -> OracleFeeChargedLimitCancelled, then OpenLimitCanceled.
//   - executeAutomationOpenOrderCallback -> LimitOpenExecuted(limitIndex = the freed
//     limit slot; t.index is the NEW trade's slot, which is a different index space).
//     AutomationOpenOrderCanceled does NOT remove the limit order: the callback leaves
//     it in storage and only releases the trigger, so it stays resting and can be
//     triggered again.
//   - TpUpdated/SlUpdated apply to open trades only; a limit order's tp/sl change
//     through OpenLimitUpdated.

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type EventMeta = {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
};

type TradeArg = {
  collateral: bigint;
  openPrice: bigint;
  tp: bigint;
  sl: bigint;
  trader: `0x${string}`;
  leverage: number;
  pairIndex: number;
  index: number;
  buy: boolean;
};

type LimitRow = {
  trader: `0x${string}`;
  pairIndex: number;
  index: number;
  orderType: string;
  buy: boolean;
  collateral: bigint;
  leverage: number;
  triggerPrice: bigint;
  tp: bigint;
  sl: bigint;
};

export function limitOrderId(trader: string, pairIndex: number, index: number): string {
  return `${trader.toLowerCase()}-${pairIndex}-${index}`;
}

function eventId(meta: EventMeta): string {
  return `${meta.txHash}-${meta.logIndex}`;
}

async function recordEvent(
  db: Db,
  meta: EventMeta,
  kind: string,
  slot: { trader: string; pairIndex: number; index: number },
  row: Partial<LimitRow> | null,
  extra: { orderId?: bigint; tradeId?: bigint } = {},
): Promise<void> {
  await db
    .insert(orderEvent)
    .values({
      id: eventId(meta),
      trader: slot.trader.toLowerCase(),
      pairIndex: slot.pairIndex,
      index: slot.index,
      kind,
      orderType: row?.orderType ?? null,
      buy: row?.buy ?? null,
      collateral: row?.collateral ?? null,
      leverage: row?.leverage ?? null,
      triggerPrice: row?.triggerPrice ?? null,
      tp: row?.tp ?? null,
      sl: row?.sl ?? null,
      orderId: extra.orderId ?? null,
      tradeId: extra.tradeId ?? null,
      at: meta.timestamp,
      blockNumber: meta.blockNumber,
      txHash: meta.txHash,
    })
    .onConflictDoNothing();
}

export async function onOpenLimitPlaced(
  db: Db,
  args: { trader: `0x${string}`; pairIndex: number; index: number; trade: TradeArg; orderType: number },
  meta: EventMeta,
): Promise<void> {
  const { trader, pairIndex, index, trade } = args;
  const row = {
    trader: trader.toLowerCase() as `0x${string}`,
    pairIndex,
    index,
    orderType: openOrderTypeLabel(args.orderType),
    buy: trade.buy,
    collateral: trade.collateral,
    leverage: trade.leverage,
    triggerPrice: trade.openPrice,
    tp: trade.tp,
    sl: trade.sl,
  };
  const values = { id: limitOrderId(trader, pairIndex, index), ...row, placedAt: meta.timestamp, updatedAt: meta.timestamp, placedTx: meta.txHash };
  // Upsert, replacing everything: a freed slot is reused by the next placement, so a row
  // left behind by an event outside the indexed range must not survive into the new order.
  const { id: _id, ...patch } = values;
  await db.insert(limitOrder).values(values).onConflictDoUpdate(patch);
  await recordEvent(db, meta, 'limit_placed', { trader, pairIndex, index }, row);
}

export async function onOpenLimitUpdated(
  db: Db,
  args: { trader: `0x${string}`; pairIndex: number; index: number; newPrice: bigint; newTp: bigint; newSl: bigint },
  meta: EventMeta,
): Promise<void> {
  const { trader, pairIndex, index } = args;
  const id = limitOrderId(trader, pairIndex, index);
  const existing = (await db.find(limitOrder, { id })) as LimitRow | null;
  const patch = { triggerPrice: args.newPrice, tp: args.newTp, sl: args.newSl };
  if (existing) {
    await db.update(limitOrder, { id }).set({ ...patch, updatedAt: meta.timestamp });
  } else {
    console.warn(`[indexer] OpenLimitUpdated: no limit_order ${id} (placed before startBlock?) — history only`);
  }
  await recordEvent(db, meta, 'limit_updated', { trader, pairIndex, index }, existing ? { ...existing, ...patch } : patch);
}

export async function onOpenLimitCanceled(
  db: Db,
  args: { trader: `0x${string}`; pairIndex: number; index: number },
  meta: EventMeta,
): Promise<void> {
  const { trader, pairIndex, index } = args;
  const id = limitOrderId(trader, pairIndex, index);
  const existing = (await db.find(limitOrder, { id })) as LimitRow | null;
  if (existing) await db.delete(limitOrder, { id });
  await recordEvent(db, meta, 'limit_cancelled', { trader, pairIndex, index }, existing);
}

export async function onLimitOpenExecuted(
  db: Db,
  args: { orderId: bigint; limitIndex: bigint; t: { trader: `0x${string}`; pairIndex: number } },
  tradeId: bigint,
  meta: EventMeta,
): Promise<void> {
  const index = Number(args.limitIndex);
  const { trader, pairIndex } = args.t;
  const id = limitOrderId(trader, pairIndex, index);
  const existing = (await db.find(limitOrder, { id })) as LimitRow | null;
  if (existing) await db.delete(limitOrder, { id });
  await recordEvent(db, meta, 'limit_executed', { trader, pairIndex, index }, existing, {
    orderId: args.orderId,
    tradeId,
  });
}

/** AutomationOpenOrderInitiated carries only the slot. Copy what the resting order says
 * onto the automation order's row, so an in-flight limit fill shows its size and side. */
export async function automationOpenOrderDetails(
  db: Db,
  trader: string,
  pairIndex: number,
  index: number,
): Promise<{ buy: boolean | null; collateral: bigint | null; leverage: number | null }> {
  const row = (await db.find(limitOrder, { id: limitOrderId(trader, pairIndex, index) })) as LimitRow | null;
  return { buy: row?.buy ?? null, collateral: row?.collateral ?? null, leverage: row?.leverage ?? null };
}

