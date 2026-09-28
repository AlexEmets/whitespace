// Response shapes of the endpoints added for spec 2026-09-28-testnet-perfect-design.md §9.2.
// Documented in docs/decisions/phase-4-indexer-api.md ("Orders, fees, PnL and settlements").
//
// Conventions (spec §9): money is a decimal string — prices 18 dp, USDW 6 dp, leverage 2 dp;
// uint256 identifiers are integer strings; addresses and hashes are lowercase hex; times are
// unix seconds as numbers.

/** GET /limit-orders/:address — one open LIMIT/STOP entry. */
export type LimitOrder = {
  id: string; // `${trader}-${pairIndex}-${index}`
  trader: string;
  pairIndex: number;
  index: number; // the limit slot, the argument to updateOpenLimitOrder / cancelOpenLimitOrder
  orderType: 'LIMIT' | 'STOP';
  buy: boolean;
  collateral: string; // 6 dp
  leverage: string; // 2 dp
  triggerPrice: string; // 18 dp
  tp: string; // 18 dp, "0.000000000000000000" = none
  sl: string; // 18 dp, "0.000000000000000000" = none
  placedAt: number;
  updatedAt: number;
  placedTx: string;
};

export type OrderStatus = 'pending' | 'executed' | 'cancelled' | 'timeout';

/** GET /orders/:address/history — every order the trader ever requested, newest first.
 * `source: 'order'` rows went through the oracle round trip and have an orderId;
 * `source: 'limit'` rows are the synchronous limit-order actions (place / update / cancel)
 * and the fill of a resting order. */
export type OrderHistoryEntry = {
  source: 'order' | 'limit';
  id: string; // orderId for 'order', `${txHash}-${logIndex}` for 'limit'
  orderId: string | null;
  kind:
    | 'open'
    | 'close'
    | 'automation_open'
    | 'automation_close'
    | 'remove_collateral'
    | 'limit_placed'
    | 'limit_updated'
    | 'limit_cancelled'
    | 'limit_executed';
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | null; // null: automation/remove-collateral orders
  pairIndex: number;
  tradeId: string | null;
  index: number | null;
  buy: boolean | null;
  collateral: string | null; // 6 dp
  leverage: string | null; // 2 dp
  price: string | null; // 18 dp; limit rows: the trigger price
  tp: string | null; // 18 dp; limit rows only
  sl: string | null; // 18 dp; limit rows only
  status: OrderStatus; // limit rows: 'cancelled' for limit_cancelled, else 'executed'
  cancelReason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  txHash: string; // the request transaction (limit rows: the action's transaction)
};

export type FeeKind = 'oracle' | 'dev' | 'vault_opening' | 'vault_liq' | 'rollover' | 'funding' | 'bond';

/** GET /fees/:address — one fee charge, newest first. */
export type FeeCharge = {
  id: string;
  trader: string;
  tradeId: string | null;
  pairIndex: number | null;
  kind: FeeKind;
  amount: string; // 6 dp; signed for rollover/funding, negative = received by the trader
  at: number;
  blockNumber: string;
  txHash: string;
};

/** GET /pnl/:address — totals over every full and partial close. */
export type PnlSummary = {
  realizedPnl: string; // 6 dp, signed: Σ (usdcSentToTrader − collateral closed)
  fees: string; // 6 dp: Σ oracle + dev + vault_opening + bond + rollover charged to those trades
  funding: string; // 6 dp, signed: Σ funding on those trades (negative = received)
  trades: number; // distinct trades that realised anything
};

/** GET /positions/:address/history — one realised close (full or partial), newest first. */
export type PositionHistoryEntry = {
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral: string; // 6 dp; for a partial close, the part closed
  leverage: string; // 2 dp
  openPrice: string; // 18 dp
  closePrice: string; // 18 dp
  tp: string | null; // 18 dp; null on partial rows
  sl: string | null; // 18 dp; null on partial rows
  tradeId: string; // repeated across a trade's partial closes and its final close
  openedAt: number;
  closedAt: number;
  closeReason: string; // 'close' | 'tp' | 'sl' | 'liq' | …
  percentProfit: string; // percent, 6 dp, signed ("-0.030768" = −0.030768 %)
  usdcSentToTrader: string; // 6 dp
  realizedPnl: string; // 6 dp, signed: usdcSentToTrader − collateral
  closeOrderId: string; // unique per row
  closeTxHash: string;
  percentageClosed: string; // 2 dp percent, "100.00" for a full close
  isPartial: boolean;
};

/** GET /vault/settlements — one settlement, newest first. Columns a settlement's second
 * event has not filled yet are null. */
export type VaultSettlement = {
  settlementId: number;
  settlementType: 'acct' | 'mm' | null;
  settlementTs: number | null;
  totalAssets: string | null; // 6 dp USDW
  totalSupply: string | null; // 6 dp OLP
  shareToAssetsPrice: string; // 18 dp
  settlementOpenPnl: string | null; // 18 dp, signed
  totalClosedPnl: string | null; // 6 dp, signed
  accPnlPerTokenUsed: string | null; // 18 dp, signed
  bufferSize: string | null; // 6 dp, signed
  assetsDeposited: string | null; // 6 dp
  sharesWithdrawn: string | null; // 6 dp
  deltaShares: string | null; // 6 dp, signed
  at: number;
  blockNumber: string;
  txHash: string;
};

/** GET /points/:address — a wallet's season-one points, one row of wallet_points plus its
 * streak state and the missions it has unlocked. Every points figure is a 6-decimal string. */
export type PointsSummary = {
  address: string;
  missions: string; // 6 dp
  time: string; // 6 dp
  streak: string; // 6 dp
  lp: string; // 6 dp
  total: string; // 6 dp
  rank: number | null; // leaderboard position; null if the wallet has earned nothing
  streakDays: number; // current consecutive-day run
  streakLongest: number;
  completedMissions: string[]; // mission ids already unlocked
  updatedAt: number | null; // unix seconds of the last award; null if none
  lpBalance: string; // 6 dp USDW currently tracked in the pool
  lpSince: number | null; // unix seconds the LP balance last changed; anchors the live accrual
};

/** One row of GET /points/leaderboard, ranked by total points descending. */
export type LeaderboardEntry = {
  rank: number;
  address: string;
  missions: string; // 6 dp
  time: string; // 6 dp
  streak: string; // 6 dp
  lp: string; // 6 dp
  total: string; // 6 dp
};

/** Every 400 this API returns. */
export type ApiError = { error: string };
