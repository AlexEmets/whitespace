/**
 * Response shapes for the read API (services/api), fixed by D3 in
 * docs/superpowers/plans/2026-09-08-phases-2-7-full-product.md and the phase-5 task
 * brief. Every field that carries money is typed `string` (the raw scaled-integer decimal
 * string, per D3: "never a JSON number") — parse it with `src/lib/money.ts`, never with
 * `Number()` or `parseFloat()`.
 *
 * The `/orders/:address` and WS payload shapes for order status are not fully specified
 * by D3 beyond "pending (requested, not yet executed) orders" — the fields below are
 * this app's documented assumption, reconciled against the two-phase lifecycle described
 * in design §5.1 and the `CancelReason` enum in IOstiumTradingCallbacks.sol. See
 * docs/decisions/phase-5-frontend.md for the note to reconcile with the API team.
 */

export interface HealthResponse {
  status: string;
  chainId: number;
  indexedBlock: number;
  lagSeconds: number;
}

/**
 * The native-WBT faucet's response (services/api POST /faucet/wbt). `ok` is the success
 * signal — a declined claim (cooldown, out-of-funds, bad address) still returns a body
 * with `ok: false` and a human-readable `error`, and a cooldown adds `retryAfterSeconds`.
 * `amountWei` is the raw 18-decimal wei string, never a JSON number.
 */
export interface WbtFaucetResult {
  ok: boolean;
  txHash?: string;
  amountWei?: string;
  from?: string;
  error?: string;
  retryAfterSeconds?: number;
}

export interface MarketSummary {
  pairIndex: number;
  from: string;
  to: string;
  feedId: string;
  maxLeverage: string;
  maxOpenInterest: string;
  openInterest: { long: string; short: string };
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface PositionSummary {
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral: string;
  leverage: string;
  openPrice: string;
  tp: string;
  sl: string;
  openedAt: number;
  tradeId: string;
}

export interface ClosedPositionSummary extends PositionSummary {
  closePrice: string;
  closedAt: number;
  realisedPnl: string;
}

export type OrderStatus = 'pending' | 'executed' | 'cancelled';

export interface OrderSummary {
  orderId: string;
  pairIndex: number;
  kind: string;
  /**
   * Null while an OPEN order is still pending, and that is not a defect in the API.
   * `MarketOpenOrderInitiated` carries no Trade payload — the side, collateral and
   * leverage only exist on chain once `MarketOpenExecuted` fires. Close and
   * remove-collateral orders record them at request time and so have them throughout.
   *
   * These were typed as non-null, which is why nothing flagged the two consumers that
   * mishandled them: `<Money value={null}>` threw at runtime, and `o.buy ? 'Long' :
   * 'Short'` silently labelled a pending long as a short. A type that promises more than
   * the wire delivers removes exactly the check that would have caught both.
   */
  buy: boolean | null;
  collateral: string | null;
  leverage: string | null;
  requestedAt: number;
  /** Block the request landed in, as digits. In BLOCKS because that is the unit
   * `openTradeMarketTimeout` compares against when deciding whether the trader may
   * reclaim their collateral. */
  requestedAtBlock: string | null;
  status: OrderStatus;
  /** Unix seconds when the order stopped being pending; null while it still is. */
  resolvedAt: number | null;
  /** Non-null only once status is 'cancelled'. Raw IOstiumTradingCallbacks.CancelReason
   * name, e.g. "SLIPPAGE". */
  cancelReason: string | null;
  /** Non-null only once status is 'executed'. */
  tradeId: string | null;
}

export interface PriceResponse {
  index: string;
  mark: string;
  /** The two-sided quote behind the index, human decimals like every other money field.
   * Null on the chain fallback — a settled report is one price, not a book — and null
   * whenever the publisher has no two-sided aggregate. Never substitute `mark`: "no
   * spread" and "spread unknown" price a fill differently. */
  bid: string | null;
  ask: string | null;
  updatedAt: number;
  /** NAMES of the currently healthy venues (`["bybit","okx"]`), not a count — that is what
   * `/price/:pairIndex` has always sent. This was typed as `number` and every consumer
   * believed it; DegradedBanner rendered the array where it meant to print a tally. Null
   * on the chain fallback, which carries no venue health at all. */
  healthyVenues: string[] | null;
  /** How many healthy sources THIS market needs before opens are allowed. Not a constant:
   * a market fed by fewer sources by design carries its own minimum, so copy that says
   * "minimum 3" is wrong for it. Null on the chain fallback, and on a publisher predating
   * the field — render the requirement only when it is known. */
  minHealthyVenues: number | null;
  degraded: boolean | null;
  /** Which source answered. `chain` means the price is the last settled report and is
   * frozen until someone trades — the caller should treat it as stale, not live. */
  source: 'publisher' | 'chain';
}

/** GET /limit-orders/:address — a resting LIMIT/STOP entry (spec 2026-09-28 §9.2). */
export interface LimitOrderSummary {
  pairIndex: number;
  index: number;
  orderType: 'LIMIT' | 'STOP';
  buy: boolean;
  collateral: string;
  leverage: string;
  /** The order's trigger (its `openPrice` on chain). */
  triggerPrice: string;
  tp: string;
  sl: string;
  placedAt: number;
  updatedAt: number;
}

/** GET /orders/:address/history — every market order and every limit-order event, newest
 * first. A limit fill appears twice: as `automation_open` (the fill request) and as
 * `limit_executed` (the resting order leaving the book). */
export interface OrderHistoryEntry {
  source: 'order' | 'limit';
  id: string;
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
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | null;
  pairIndex: number;
  tradeId: string | null;
  index: number | null;
  buy: boolean | null;
  collateral: string | null;
  leverage: string | null;
  price: string | null;
  tp: string | null;
  sl: string | null;
  status: 'pending' | 'executed' | 'cancelled' | 'timeout';
  cancelReason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  txHash: string;
}

export type FeeKind = 'oracle' | 'dev' | 'vault_opening' | 'vault_liq' | 'rollover' | 'funding' | 'bond';

/** GET /fees/:address — one fee event. `amount` is USDW, signed for funding
 * (negative = the trader received it). */
export interface FeeCharge {
  id: string;
  tradeId: string | null;
  pairIndex: number | null;
  kind: FeeKind;
  amount: string;
  at: number;
  txHash: string;
}

/** GET /pnl/:address — totals over closed positions. */
export interface PnlSummary {
  realizedPnl: string;
  fees: string;
  funding: string;
  trades: number;
}

/** GET /points/:address — a wallet's season-one points. Every points figure is a raw
 * 6-decimal string, parsed with src/lib/money.ts like every other money field. */
export interface PointsSummary {
  address: string;
  missions: string;
  time: string;
  streak: string;
  lp: string;
  total: string;
  rank: number | null;
  streakDays: number;
  streakLongest: number;
  completedMissions: string[];
  updatedAt: number | null;
}

/** GET /points/leaderboard — one ranked wallet. */
export interface LeaderboardEntry {
  rank: number;
  address: string;
  missions: string;
  time: string;
  streak: string;
  lp: string;
  total: string;
}

export type WsMessage =
  | { channel: `price:${string}`; type: 'price'; data: PriceResponse }
  | { channel: `positions:${string}`; type: 'positions'; data: PositionSummary[] }
  | { channel: `orders:${string}`; type: 'orders'; data: OrderSummary[] }
  | { channel: `candles:${string}:${CandleInterval}`; type: 'candle'; data: Candle }
  | { channel: `limitOrders:${string}`; type: 'limitOrders'; data: LimitOrderSummary[] }
  | { channel: `fees:${string}`; type: 'fees'; data: FeeCharge[] };
