import { API_BASE_URL } from './config';
import type {
  Candle,
  CandleInterval,
  ClosedPositionSummary,
  FeeCharge,
  HealthResponse,
  LimitOrderSummary,
  OrderHistoryEntry,
  MarketSummary,
  OrderSummary,
  PnlSummary,
  PositionSummary,
  PriceResponse,
  PointsSummary,
  LeaderboardEntry,
  WbtFaucetResult,
} from './types';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Unlike getJson, this does NOT throw on a non-2xx status. The WBT faucet answers a
 * declined claim (cooldown 429, out-of-funds 503, bad address 400) with a JSON body the
 * UI needs to read and show — the body's own `ok` flag is the success signal, not the
 * HTTP status. A network-level failure (the API unreachable, or a non-JSON 5xx) rejects,
 * which the caller reports differently from a structured decline.
 */
async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as T;
}

export const api = {
  health: () => getJson<HealthResponse>('/health'),
  markets: () => getJson<MarketSummary[]>('/markets'),
  market: (pairIndex: number) => getJson<MarketSummary>(`/markets/${pairIndex}`),
  candles: (pairIndex: number, interval: CandleInterval, from: number, to: number) =>
    getJson<Candle[]>(`/markets/${pairIndex}/candles?interval=${interval}&from=${from}&to=${to}`),
  positions: (address: string) => getJson<PositionSummary[]>(`/positions/${address}`),
  positionHistory: (address: string) => getJson<ClosedPositionSummary[]>(`/positions/${address}/history`),
  orders: (address: string) => getJson<OrderSummary[]>(`/orders/${address}`),
  price: (pairIndex: number) => getJson<PriceResponse>(`/price/${pairIndex}`),
  limitOrders: (address: string) => getJson<LimitOrderSummary[]>(`/limit-orders/${address}`),
  orderHistory: (address: string, limit = 100) => getJson<OrderHistoryEntry[]>(`/orders/${address}/history?limit=${limit}`),
  fees: (address: string, limit = 200) => getJson<FeeCharge[]>(`/fees/${address}?limit=${limit}`),
  pnl: (address: string) => getJson<PnlSummary>(`/pnl/${address}`),
  points: (address: string) => getJson<PointsSummary>(`/points/${address}`),
  leaderboard: (limit = 100) => getJson<LeaderboardEntry[]>(`/points/leaderboard?limit=${limit}`),
  /** Ask the server-side faucet to send native WBT (gas) to `address`. The result carries
   * its own `ok` flag; see postJson on why a decline is not an exception here. */
  requestWbt: (address: string) => postJson<WbtFaucetResult>('/faucet/wbt', { address }),
};
