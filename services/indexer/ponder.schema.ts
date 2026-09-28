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

/** Resting LIMIT/STOP entries (spec 2026-09-28 §9.1), one row per occupied
 * (trader, pairIndex, index) limit slot. Written by OpenLimitPlacedV2, patched by
 * OpenLimitUpdated, deleted by OpenLimitCanceled and LimitOpenExecuted. The contract
 * reuses a freed slot (firstEmptyOpenLimitIndex), so the id describes the slot, not
 * one order's history — that lives in `order_event`. Read directly by the automation
 * bot, so it must never hold a row the chain no longer has. */
export const limitOrder = onchainTable(
  'limit_order',
  (t) => ({
    id: t.text().primaryKey(), // `${trader}-${pairIndex}-${index}`, trader lowercase
    trader: t.hex().notNull(),
    pairIndex: t.integer().notNull(),
    index: t.integer().notNull(),
    orderType: t.text().notNull(), // 'LIMIT' | 'STOP'
    buy: t.boolean().notNull(),
    collateral: t.bigint().notNull(), // PRECISION_6
    leverage: t.integer().notNull(), // PRECISION_2
    triggerPrice: t.bigint().notNull(), // PRECISION_18, the order's openPrice/targetPrice
    tp: t.bigint().notNull(), // PRECISION_18
    sl: t.bigint().notNull(), // PRECISION_18
    placedAt: t.integer().notNull(),
    updatedAt: t.integer().notNull(),
    placedTx: t.hex().notNull(),
  }),
  (table) => ({
    traderIdx: index().on(table.trader),
  }),
);

/** Append-only history of limit-order actions, one row per log. Complements `order`
 * (which holds everything that went through the two-phase oracle flow and therefore has
 * an orderId): placing, updating and cancelling a limit order are synchronous and have
 * no orderId, so without this table they would leave no trace once `limit_order` drops
 * the row. */
export const orderEvent = onchainTable(
  'order_event',
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    trader: t.hex().notNull(),
    pairIndex: t.integer().notNull(),
    index: t.integer().notNull(),
    kind: t.text().notNull(), // 'limit_placed' | 'limit_updated' | 'limit_cancelled' | 'limit_executed'
    orderType: t.text(), // 'LIMIT' | 'STOP'; null only if the placement predates startBlock
    buy: t.boolean(),
    collateral: t.bigint(), // PRECISION_6
    leverage: t.integer(), // PRECISION_2
    triggerPrice: t.bigint(), // PRECISION_18
    tp: t.bigint(), // PRECISION_18
    sl: t.bigint(), // PRECISION_18
    orderId: t.bigint(), // limit_executed only: the automation order that filled it
    tradeId: t.bigint(), // limit_executed only
    at: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    traderAtIdx: index().on(table.trader, table.at),
  }),
);

/** Close orders that turned out to be liquidations, keyed by the close orderId, from
 * VaultLiqFeeCharged. A MARKET close can liquidate (closeTradeMarketCallback checks
 * tradeValue < liqMarginValue), and MarketCloseExecutedV2 says nothing about it — it even
 * reports the liquidation fee as `usdcSentToTrader` while the trader is actually sent 0.
 * VaultLiqFeeCharged fires earlier in the same callback, so the close handler reads this
 * row to label the close 'liq'. */
export const liquidation = onchainTable('liquidation', (t) => ({
  orderId: t.bigint().primaryKey(),
  tradeId: t.bigint().notNull(),
  trader: t.hex().notNull(),
  liquidationFee: t.bigint().notNull(), // PRECISION_6, what the vault kept
  at: t.integer().notNull(),
  txHash: t.hex().notNull(),
}));

/** Every fee the protocol charged a trader (spec §9.1), one row per charge. See
 * src/lib/fees.ts for the event → kind mapping and the two places a log does not map to
 * exactly one row (FeesChargedV2 → rollover + funding; the bond's OracleFeeCharged is
 * folded into its OracleFeeBondCharged row so the bond is not counted twice). */
export const feeCharge = onchainTable(
  'fee_charge',
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`, plus `-rollover`/`-funding` for FeesChargedV2
    trader: t.hex().notNull(),
    tradeId: t.bigint(), // null for OracleFeeChargedLimitCancelled (no trade exists)
    pairIndex: t.integer(), // null when neither the event nor an indexed row carries it
    kind: t.text().notNull(), // 'oracle'|'dev'|'vault_opening'|'vault_liq'|'rollover'|'funding'|'bond'
    amount: t.bigint().notNull(), // PRECISION_6; signed for rollover/funding (negative = received)
    at: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    traderAtIdx: index().on(table.trader, table.at),
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

/** One row per vault settlement (spec §9.1), keyed by settlementId. Built from the two
 * events a settlement emits in one transaction: AsyncDepositWithdrawExecuted (the
 * deposit/withdraw batch, fires first) and SettlementExecuted (the accounting totals).
 * Each handler fills its own columns, so either may arrive first. */
export const vaultSettlement = onchainTable('vault_settlement', (t) => ({
  id: t.integer().primaryKey(), // settlementId
  settlementType: t.text(), // 'acct' | 'mm' (IOstiumVault.SettlementType)
  settlementTs: t.integer(),
  totalAssets: t.bigint(), // PRECISION_6, USDW in the vault after settlement
  totalSupply: t.bigint(), // PRECISION_6, OLP shares outstanding after settlement
  shareToAssetsPrice: t.bigint().notNull(), // PRECISION_18
  settlementOpenPnl: t.bigint(), // PRECISION_18 USD, signed
  totalClosedPnl: t.bigint(), // PRECISION_6, signed
  accPnlPerTokenUsed: t.bigint(), // PRECISION_18, signed
  bufferSize: t.bigint(), // PRECISION_6, signed
  assetsDeposited: t.bigint(), // PRECISION_6, deposits executed in this settlement
  sharesWithdrawn: t.bigint(), // PRECISION_6, withdrawals executed in this settlement
  deltaShares: t.bigint(), // PRECISION_6, signed net mint (+) / burn (-)
  at: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

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
