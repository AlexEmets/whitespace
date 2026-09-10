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
  trader: string;
  buy: boolean;
  collateral: string;
  leverage: string;
  requestedAt: number;
  status: OrderStatus;
  /** Present only once status is 'cancelled'. Raw IOstiumTradingCallbacks.CancelReason
   * name, e.g. "SLIPPAGE". */
  cancelReason?: string;
  /** Present only once status is 'executed'. */
  tradeId?: string;
  executedAt?: number;
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
  degraded: boolean | null;
  /** Which source answered. `chain` means the price is the last settled report and is
   * frozen until someone trades — the caller should treat it as stale, not live. */
  source: 'publisher' | 'chain';
}

export type WsMessage =
  | { channel: `price:${string}`; type: 'price'; data: PriceResponse }
  | { channel: `positions:${string}`; type: 'positions'; data: PositionSummary[] }
  | { channel: `orders:${string}`; type: 'orders'; data: OrderSummary[] }
  | { channel: `candles:${string}:${CandleInterval}`; type: 'candle'; data: Candle };
