import { feeCharge, position, order, closedPosition } from '../../ponder.schema.js';
import { logId, type EventMeta } from './event.js';

// fee_charge (spec §9.1): one row per fee the protocol charged. Event -> kind:
//
//   OracleFeeCharged (callbacks)         'oracle'  — at open (registerTrade) and when a
//                                                     market open is cancelled; in the latter
//                                                     the event's `tradeId` slot carries the
//                                                     open orderId (== the tradeId it would
//                                                     have had), stored as-is.
//   OracleFeeChargedLimitCancelled       'oracle'  — cancelOpenLimitOrder; no trade, so
//                                                     trade_id is null, pair_index from the event.
//   DevFeeCharged                        'dev'
//   VaultOpeningFeeCharged               'vault_opening'
//   VaultLiqFeeCharged                   'vault_liq'
//   FeesChargedV2                        'rollover' AND 'funding' — one log, two amounts, so
//                                                     two rows with ids suffixed -rollover /
//                                                     -funding. Both int256 in the contract and
//                                                     stored signed: getTradeValuePure SUBTRACTS
//                                                     them from the trade's value, so positive =
//                                                     paid by the trader, negative = received.
//                                                     Zero amounts are kept: a close that paid no
//                                                     funding is still a fact the history shows.
//   OracleFeeBondCharged                 'bond'    — _chargeBondFromPosition emits
//                                                     OracleFeeCharged(bond) immediately followed
//                                                     by OracleFeeBondCharged, which has no amount.
//                                                     Recording both would count the bond twice,
//                                                     so the bond row takes the preceding log's
//                                                     amount and that 'oracle' row is removed.
//
// BuilderFeeCharged is not recorded: the spec's kinds have no builder fee, and this
// deployment's frontend never sets a builder.

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type FeeKind = 'oracle' | 'dev' | 'vault_opening' | 'vault_liq' | 'rollover' | 'funding' | 'bond';

type FeeRow = {
  id: string;
  trader: `0x${string}`;
  tradeId: bigint | null;
  pairIndex: number | null;
  kind: FeeKind;
  amount: bigint;
};

/** The pair a tradeId belongs to, from whatever the indexer already holds. The open-time
 * fees fire BEFORE MarketOpenExecuted/LimitOpenExecuted inserts the position, so the open
 * order row (orderId == tradeId, see src/lib/tradeId.ts) is the fallback there. */
export async function pairIndexForTrade(db: Db, tradeId: bigint): Promise<number | null> {
  const pos = (await db.find(position, { tradeId })) as { pairIndex: number } | null;
  if (pos) return pos.pairIndex;
  const ord = (await db.find(order, { orderId: tradeId })) as { pairIndex: number } | null;
  if (ord) return ord.pairIndex;
  const closed = (await db.find(closedPosition, { tradeId })) as { pairIndex: number } | null;
  return closed?.pairIndex ?? null;
}

async function insertFee(db: Db, meta: EventMeta, row: FeeRow): Promise<void> {
  await db
    .insert(feeCharge)
    .values({
      ...row,
      trader: row.trader.toLowerCase(),
      at: meta.timestamp,
      blockNumber: meta.blockNumber,
      txHash: meta.txHash,
    })
    .onConflictDoNothing();
}

/** OracleFeeCharged, DevFeeCharged, VaultOpeningFeeCharged, VaultLiqFeeCharged. */
export async function onTradeFee(
  db: Db,
  kind: 'oracle' | 'dev' | 'vault_opening' | 'vault_liq',
  args: { tradeId: bigint; trader: `0x${string}`; amount: bigint },
  meta: EventMeta,
): Promise<void> {
  await insertFee(db, meta, {
    id: logId(meta),
    trader: args.trader,
    tradeId: args.tradeId,
    pairIndex: await pairIndexForTrade(db, args.tradeId),
    kind,
    amount: args.amount,
  });
}

export async function onOracleFeeChargedLimitCancelled(
  db: Db,
  args: { trader: `0x${string}`; pairIndex: number; amount: bigint },
  meta: EventMeta,
): Promise<void> {
  await insertFee(db, meta, {
    id: logId(meta),
    trader: args.trader,
    tradeId: null,
    pairIndex: args.pairIndex,
    kind: 'oracle',
    amount: args.amount,
  });
}

export async function onFeesChargedV2(
  db: Db,
  args: { tradeId: bigint; trader: `0x${string}`; rolloverFees: bigint; fundingFees: bigint },
  meta: EventMeta,
): Promise<void> {
  const pairIndex = await pairIndexForTrade(db, args.tradeId);
  const base = { trader: args.trader, tradeId: args.tradeId, pairIndex };
  await insertFee(db, meta, { ...base, id: `${logId(meta)}-rollover`, kind: 'rollover', amount: args.rolloverFees });
  await insertFee(db, meta, { ...base, id: `${logId(meta)}-funding`, kind: 'funding', amount: args.fundingFees });
}

/** Must run BEFORE the handler applies the event's new collateral to `position`: the
 * fallback amount is the collateral the bond removed. */
export async function onOracleFeeBondCharged(
  db: Db,
  args: { tradeId: bigint; trader: `0x${string}`; collateral: bigint },
  meta: EventMeta,
): Promise<void> {
  const prevId = `${meta.txHash}-${meta.logIndex - 1}`;
  const prev = (await db.find(feeCharge, { id: prevId })) as FeeRow | null;

  let amount: bigint | null = null;
  if (prev && prev.kind === 'oracle' && prev.tradeId === args.tradeId) {
    amount = prev.amount;
    await db.delete(feeCharge, { id: prevId });
  } else {
    const pos = (await db.find(position, { tradeId: args.tradeId })) as { collateral: bigint } | null;
    if (pos && pos.collateral > args.collateral) amount = pos.collateral - args.collateral;
  }
  if (amount === null) {
    console.warn(`[indexer] OracleFeeBondCharged: bond amount for trade ${args.tradeId} unknown — not recorded`);
    return;
  }
  await insertFee(db, meta, {
    id: logId(meta),
    trader: args.trader,
    tradeId: args.tradeId,
    pairIndex: await pairIndexForTrade(db, args.tradeId),
    kind: 'bond',
    amount,
  });
}
