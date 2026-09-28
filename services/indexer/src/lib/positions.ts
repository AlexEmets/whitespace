import { order, position, closedPosition, market, liquidation } from '../../ponder.schema.js';
import { updateIfExists, findOrWarn } from './db.js';
import { limitOrderLabel } from './enums.js';
import { recordTick, quoteNotional } from './candleTick.js';

// Handler logic for everything that changes or ends an open position, kept here (not in
// src/handlers, which cannot load outside Ponder's runtime) so test/positions.test.ts can
// drive it against test/fakeDb.ts.

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const FULL_CLOSE_PCT = 10000n; // PRECISION_2, 10000 = 100%

type MarketRow = { openInterestLong: bigint; openInterestShort: bigint };

type PositionRow = {
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
};

export type Resolution = { at: number; txHash: `0x${string}` };

export async function adjustOpenInterest(
  db: Db,
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

async function markExecuted(db: Db, orderId: bigint, r: Resolution, context: string): Promise<void> {
  await updateIfExists(
    db,
    order,
    { orderId },
    { status: 'executed', resolvedAt: r.at, resolvedTxHash: r.txHash },
    context,
  );
}

async function writeClosed(
  db: Db,
  tradeId: bigint,
  pos: PositionRow,
  fields: {
    closePrice: bigint;
    closeReason: string;
    percentProfit: bigint;
    usdcSentToTrader: bigint;
    percentageClosed: number;
    closeOrderId: bigint;
  },
  r: Resolution,
): Promise<void> {
  await db.delete(position, { tradeId });
  await db
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
      tp: pos.tp,
      sl: pos.sl,
      ...fields,
      openOrderId: pos.openOrderId,
      openedAt: pos.openedAt,
      closedAt: r.at,
      closeTxHash: r.txHash,
    })
    .onConflictDoUpdate({});
}

// MarketCloseExecutedV2 supports partial closes (percentageClosed < 10000): the position
// stays open with reduced collateral and is NOT written to closedPosition (that table
// models "this trade is over", which a partial close isn't) — see
// docs/decisions/phase-4-indexer-api.md for the scope note on partial-close realized-PnL
// history.
export async function onMarketCloseExecuted(
  db: Db,
  args: {
    orderId: bigint;
    tradeId: bigint;
    price: bigint;
    percentProfit: bigint;
    usdcSentToTrader: bigint;
    percentageClosed: bigint;
  },
  r: Resolution,
): Promise<void> {
  const { orderId, tradeId, price, percentProfit, usdcSentToTrader, percentageClosed } = args;
  await markExecuted(db, orderId, r, 'MarketCloseExecutedV2->order');

  const pos = await findOrWarn<PositionRow>(db, position, { tradeId }, 'MarketCloseExecutedV2->position');
  if (!pos) return;

  const originalNotional = quoteNotional(pos.collateral, pos.leverage);
  const closedNotional = (originalNotional * percentageClosed) / FULL_CLOSE_PCT;
  await adjustOpenInterest(db, pos.pairIndex, pos.buy, -closedNotional, 'MarketCloseExecutedV2->market.OI');
  await recordTick(db, pos.pairIndex, r.at, price, closedNotional);

  if (percentageClosed >= FULL_CLOSE_PCT) {
    // A market close can liquidate; the event does not say so, VaultLiqFeeCharged (earlier
    // in the same callback) does. The trader is then sent nothing — the event's
    // usdcSentToTrader is the value the vault kept. (A liquidation whose value was exactly
    // 0 emits no fee event and stays 'close'; usdcSentToTrader is 0 either way.)
    const liquidated = (await db.find(liquidation, { orderId })) != null;
    await writeClosed(
      db,
      tradeId,
      pos,
      {
        closePrice: price,
        closeReason: liquidated ? 'liq' : 'close',
        percentProfit,
        usdcSentToTrader: liquidated ? 0n : usdcSentToTrader,
        percentageClosed: Number(percentageClosed),
        closeOrderId: orderId,
      },
      r,
    );
  } else {
    // Mirrors TradingStorage.unregisterTrade(..., collateralToClose) with
    // collateralToClose = collateral * closePercentage / 100e2; leverage is unchanged.
    const removedCollateral = (pos.collateral * percentageClosed) / FULL_CLOSE_PCT;
    await db.update(position, { tradeId }).set({ collateral: pos.collateral - removedCollateral });
  }
}

// LimitCloseExecuted (TP/SL/LIQ) is always a full close. The contract reports orderType
// LIQ whenever the trade turned out to be under maintenance, whatever trigger fired it.
export async function onLimitCloseExecuted(
  db: Db,
  args: {
    orderId: bigint;
    tradeId: bigint;
    orderType: number;
    price: bigint;
    percentProfit: bigint;
    usdcSentToTrader: bigint;
  },
  r: Resolution,
): Promise<void> {
  const { orderId, tradeId, orderType, price, percentProfit, usdcSentToTrader } = args;
  await markExecuted(db, orderId, r, 'LimitCloseExecuted->order');

  const pos = await findOrWarn<PositionRow>(db, position, { tradeId }, 'LimitCloseExecuted->position');
  if (!pos) return;

  const notional = quoteNotional(pos.collateral, pos.leverage);
  await adjustOpenInterest(db, pos.pairIndex, pos.buy, -notional, 'LimitCloseExecuted->market.OI');
  await recordTick(db, pos.pairIndex, r.at, price, notional);

  await writeClosed(
    db,
    tradeId,
    pos,
    {
      closePrice: price,
      closeReason: limitOrderLabel(orderType), // 'liq' for liquidations, 'tp', 'sl', ...
      percentProfit,
      usdcSentToTrader,
      percentageClosed: 10000,
      closeOrderId: orderId,
    },
    r,
  );
}

/** VaultLiqFeeCharged: remember that this close order liquidated the trade. */
export async function onVaultLiqFeeCharged(
  db: Db,
  args: { orderId: bigint; tradeId: bigint; trader: `0x${string}`; amount: bigint },
  r: Resolution,
): Promise<void> {
  await db
    .insert(liquidation)
    .values({
      orderId: args.orderId,
      tradeId: args.tradeId,
      trader: args.trader.toLowerCase(),
      liquidationFee: args.amount,
      at: r.at,
      txHash: r.txHash,
    })
    .onConflictDoNothing();
}

// --- Mid-life changes ---------------------------------------------------------------

export async function onTpUpdated(db: Db, args: { tradeId: bigint; newTp: bigint }): Promise<void> {
  await updateIfExists(db, position, { tradeId: args.tradeId }, { tp: args.newTp }, 'TpUpdated');
}

export async function onSlUpdated(db: Db, args: { tradeId: bigint; newSl: bigint }): Promise<void> {
  await updateIfExists(db, position, { tradeId: args.tradeId }, { sl: args.newSl }, 'SlUpdated');
}

/** topUpAmount is the amount actually taken — the contract adjusts it when rounding the
 * new leverage up — so adding it reproduces the stored collateral exactly. */
export async function onTopUpCollateral(
  db: Db,
  args: { tradeId: bigint; topUpAmount: bigint; newLeverage: number },
): Promise<void> {
  await updateIfExists(
    db,
    position,
    { tradeId: args.tradeId },
    (row: { collateral: bigint }) => ({
      collateral: row.collateral + args.topUpAmount,
      leverage: args.newLeverage,
    }),
    'TopUpCollateralExecuted',
  );
}

export async function onRemoveCollateralExecuted(
  db: Db,
  args: { orderId: bigint; tradeId: bigint; removeAmount: bigint; leverage: number; tp: bigint; sl: bigint },
  r: Resolution,
): Promise<void> {
  const { orderId, tradeId, removeAmount, leverage, tp, sl } = args;
  await markExecuted(db, orderId, r, 'RemoveCollateralExecuted->order');
  await updateIfExists(
    db,
    position,
    { tradeId },
    (row: { collateral: bigint }) => ({ collateral: row.collateral - removeAmount, leverage, tp, sl }),
    'RemoveCollateralExecuted->position',
  );
}

// Oracle-fee bond charged out of a position's own collateral (a cancelled close or a
// partial close) — OstiumTradingCallbacks._chargeBondFromPosition. Carries the position's
// resulting absolute state, so this simply overwrites rather than subtracting a delta like
// RemoveCollateralExecuted above: for the partial-close path the contract re-reads the
// trade from storage AFTER the close has already scaled collateral down, so `collateral`
// here is already the final post-close, post-charge value regardless of handler ordering.
export async function onBondChargedToPosition(
  db: Db,
  args: { tradeId: bigint; collateral: bigint; leverage: number; tp: bigint; sl: bigint },
): Promise<void> {
  const { tradeId, collateral, leverage, tp, sl } = args;
  await updateIfExists(db, position, { tradeId }, { collateral, leverage, tp, sl }, 'OracleFeeBondCharged->position');
}
