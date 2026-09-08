import { onchainTable, index } from 'ponder';

// ---------------------------------------------------------------------------
// Scale reference (see docs/decisions/phase-4-indexer-api.md and the phase-4
// task's hard constraints): prices are PRECISION_18, collateral/USDW amounts
// and vault assets are PRECISION_6, leverage and percentages-of-100 are
// PRECISION_2. Every monetary/price column below uses Ponder's `bigint`
// column type, which Ponder backs with Postgres NUMERIC (arbitrary
// precision) rather than Drizzle's default 8-byte bigint — see
// docs/decisions/phase-4-indexer-api.md for how this was confirmed. No
// column here is ever a float/real.
// ---------------------------------------------------------------------------

/** One row per configured market (pair). Seeded from PairAdded + a bounded
 * `pairs(uint16)` read (PairAdded doesn't carry feed/maxLeverage/group/fee —
 * see abis/pairsStorage.ts), kept current by PairMaxLeverageUpdated /
 * PairFeedUpdated / MaxOpenInterestUpdated, and by open-interest deltas
 * accumulated from trade open/close events (there is no on-chain
 * OI-delta event). */
export const market = onchainTable('market', (t) => ({
  pairIndex: t.integer().primaryKey(),
  fromSymbol: t.text().notNull(),
  toSymbol: t.text().notNull(),
  feedId: t.hex().notNull(),
  oracle: t.text().notNull(),
  groupIndex: t.integer().notNull(),
  feeIndex: t.integer().notNull(),
  maxLeverage: t.integer().notNull(), // PRECISION_2
  maxOpenInterest: t.bigint().notNull(), // PRECISION_6
  openInterestLong: t.bigint().notNull(), // PRECISION_6
  openInterestShort: t.bigint().notNull(), // PRECISION_6
  updatedAtBlock: t.bigint().notNull(),
  updatedAt: t.integer().notNull(), // unix seconds
}));

/** Phase 1 of the two-phase order flow: a price was requested for an order. */
export const priceRequest = onchainTable(
  'price_request',
  (t) => ({
    orderId: t.bigint().primaryKey(),
    pairIndex: t.integer(),
    orderType: t.integer().notNull(),
    feedId: t.hex().notNull(),
    requestedAt: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pairIdx: index().on(table.pairIndex),
  }),
);

/** Phase 2 of the two-phase order flow: a signed price report was delivered.
 * Also the raw tick stream candles are aggregated from. */
export const priceReport = onchainTable(
  'price_report',
  (t) => ({
    orderId: t.bigint().primaryKey(),
    pairIndex: t.integer().notNull(),
    price: t.bigint().notNull(), // PRECISION_18, signed
    nativeFee: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pairTsIdx: index().on(table.pairIndex, table.blockTimestamp),
  }),
);

/** Orders that have been requested but not yet resolved (executed /
 * cancelled / timed out). GET /orders/:address filters status='pending'. */
export const order = onchainTable(
  'order',
  (t) => ({
    orderId: t.bigint().primaryKey(),
    trader: t.hex().notNull(),
    pairIndex: t.integer().notNull(),
    kind: t.text().notNull(), // 'open' | 'close' | 'automation_open' | 'automation_close'
    tradeId: t.bigint(),
    index: t.integer(),
    buy: t.boolean(),
    collateral: t.bigint(), // PRECISION_6, open orders only
    leverage: t.integer(), // PRECISION_2, open orders only
    status: t.text().notNull(), // 'pending' | 'executed' | 'cancelled' | 'timeout'
    requestedAt: t.integer().notNull(),
    requestedAtBlock: t.bigint().notNull(),
    requestTxHash: t.hex().notNull(),
    resolvedAt: t.integer(),
    resolvedTxHash: t.hex(),
    cancelReason: t.text(), // human label from src/lib/enums.ts, e.g. 'SLIPPAGE'
  }),
  (table) => ({
    traderStatusIdx: index().on(table.trader, table.status),
  }),
);

/** Currently open positions, keyed by tradeId (globally unique — see the
 * tradeId note in src/lib/tradeId.ts). Using tradeId rather than the
 * contract's (trader, pairIndex, index) slot as the primary key means a
 * close event (which only carries tradeId, not the slot) can `db.find` /
 * `db.delete` this row directly with no secondary lookup table. The slot
 * itself is not a stable identity: the contract reuses (trader, pairIndex,
 * index) once a trade closes, so it can only ever describe "whatever trade
 * currently occupies this slot," never a specific trade's history — that's
 * exactly why closedPosition also keys on tradeId. */
export const position = onchainTable(
  'position',
  (t) => ({
    tradeId: t.bigint().primaryKey(),
    trader: t.hex().notNull(),
    pairIndex: t.integer().notNull(),
    index: t.integer().notNull(),
    buy: t.boolean().notNull(),
    collateral: t.bigint().notNull(), // PRECISION_6
    leverage: t.integer().notNull(), // PRECISION_2
    openPrice: t.bigint().notNull(), // PRECISION_18
    tp: t.bigint().notNull(), // PRECISION_18
    sl: t.bigint().notNull(), // PRECISION_18
    isDayTrade: t.boolean().notNull(),
    openOrderId: t.bigint().notNull(),
    openTxHash: t.hex().notNull(),
    openedAt: t.integer().notNull(),
    openedAtBlock: t.bigint().notNull(),
  }),
  (table) => ({
    traderIdx: index().on(table.trader),
    slotIdx: index().on(table.trader, table.pairIndex, table.index),
  }),
);

/** Closed/liquidated positions (history), keyed by tradeId. */
export const closedPosition = onchainTable(
  'closed_position',
  (t) => ({
    tradeId: t.bigint().primaryKey(),
    trader: t.hex().notNull(),
    pairIndex: t.integer().notNull(),
    index: t.integer().notNull(),
    buy: t.boolean().notNull(),
    collateral: t.bigint().notNull(), // PRECISION_6, at open
    leverage: t.integer().notNull(), // PRECISION_2, at open
    openPrice: t.bigint().notNull(), // PRECISION_18
    closePrice: t.bigint().notNull(), // PRECISION_18
    tp: t.bigint().notNull(), // PRECISION_18
    sl: t.bigint().notNull(), // PRECISION_18
    // 'close' (trader-initiated market close), 'tp', 'sl', 'liq'
    // (LimitOrder.LIQ), 'day_trade', 'other' — derived from
    // IOstiumTradingStorage.LimitOrder on LimitCloseExecuted, or 'close' for
    // MarketCloseExecutedV2.
    closeReason: t.text().notNull(),
    percentProfit: t.bigint().notNull(), // PRECISION_18, signed, straight from the event
    usdcSentToTrader: t.bigint().notNull(), // PRECISION_6
    percentageClosed: t.integer().notNull(), // PRECISION_2, 10000 = 100%
    openOrderId: t.bigint().notNull(),
    closeOrderId: t.bigint().notNull(),
    openedAt: t.integer().notNull(),
    closedAt: t.integer().notNull(),
    closeTxHash: t.hex().notNull(),
  }),
  (table) => ({
    traderIdx: index().on(table.trader),
    pairIdx: index().on(table.pairIndex),
  }),
);

/** LP vault activity: deposit/withdraw requests and claims (the vault is an
 * async, settlement-based model — see abis/vault.ts). */
export const lpActivity = onchainTable(
  'lp_activity',
  (t) => ({
    id: t.text().primaryKey(), // `${kind}-${owner}-${settlementId}-${logIndex}`
    owner: t.hex().notNull(),
    kind: t.text().notNull(), // 'deposit_requested'|'withdraw_requested'|'deposit_claimed'|'withdraw_claimed'
    settlementId: t.integer().notNull(),
    amount: t.bigint().notNull(), // assets (PRECISION_6) or shares, per event
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
  }),
);

/** OHLCV candles, one row per (pairIndex, interval, bucketStart). Populated
 * from every price tick (price reports + executed trade prices). */
export const candle = onchainTable(
  'candle',
  (t) => ({
    id: t.text().primaryKey(), // `${pairIndex}-${interval}-${bucketStart}`
    pairIndex: t.integer().notNull(),
    interval: t.text().notNull(),
    bucketStart: t.integer().notNull(), // unix seconds
    open: t.bigint().notNull(), // PRECISION_18
    high: t.bigint().notNull(), // PRECISION_18
    low: t.bigint().notNull(), // PRECISION_18
    close: t.bigint().notNull(), // PRECISION_18
    volume: t.bigint().notNull(), // PRECISION_6 (quote notional, see report)
  }),
  (table) => ({
    pairIntervalStartIdx: index().on(table.pairIndex, table.interval, table.bucketStart),
  }),
);

/** Singleton-per-chain sync heartbeat, updated on every block via the
 * `ChainHeartbeat` block interval source in ponder.config.ts. Backs
 * GET /health's indexedBlock/lagSeconds. */
export const syncStatus = onchainTable('sync_status', (t) => ({
  chainId: t.integer().primaryKey(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.integer().notNull(),
}));
