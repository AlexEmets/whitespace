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
} from './types';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  }
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
};
