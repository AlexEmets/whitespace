'use client';

import { api } from '@/lib/api';
import type { FeeCharge, LimitOrderSummary, OrderHistoryEntry, PnlSummary } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/** Resting LIMIT/STOP entries for `address` — the Open Orders tab. */
export function useLimitOrders(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<LimitOrderSummary[]>({
    channel: address ? `limitOrders:${address}` : null,
    enabled: Boolean(address),
    pollMs: 5000,
    fetcher: () => api.limitOrders(address as string),
    extractFromWs: (msg) => (msg.type === 'limitOrders' ? msg.data : null),
  });
  return { limitOrders: data ?? [], error, loading, refetch };
}

/** Every order ever requested — the Order History tab. */
export function useOrderHistory(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<OrderHistoryEntry[]>({
    channel: null,
    enabled: Boolean(address),
    pollMs: 15000,
    fetcher: () => api.orderHistory(address as string),
    extractFromWs: () => null,
  });
  return { orders: data ?? [], error, loading, refetch };
}

/** Every fee event — Funding History derives from the funding and rollover rows. */
export function useFees(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<FeeCharge[]>({
    channel: address ? `fees:${address}` : null,
    enabled: Boolean(address),
    pollMs: 15000,
    fetcher: () => api.fees(address as string),
    extractFromWs: (msg) => (msg.type === 'fees' ? msg.data : null),
  });
  return { fees: data ?? [], error, loading, refetch };
}

/** Realised PnL totals — the Realized PNL tab. */
export function usePnl(address: `0x${string}` | undefined) {
  const { data, error, loading } = useLiveResource<PnlSummary>({
    channel: null,
    enabled: Boolean(address),
    pollMs: 15000,
    fetcher: () => api.pnl(address as string),
    extractFromWs: () => null,
  });
  return { pnl: data, error, loading };
}
