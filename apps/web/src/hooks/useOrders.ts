'use client';

import { api } from '@/lib/api';
import type { OrderSummary } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/** Pending/executed/cancelled orders for `address` — the two-phase order lifecycle
 * (design §5.1). Consumers must render `pending` honestly rather than implying the trade
 * already happened; see components/OrdersList.tsx. */
export function useOrders(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<OrderSummary[]>({
    channel: address ? `orders:${address}` : null,
    enabled: Boolean(address),
    pollMs: 3000,
    fetcher: () => api.orders(address as string),
    extractFromWs: (msg) => (msg.type === 'orders' ? msg.data : null),
  });
  return { orders: data ?? [], error, loading, refetch };
}
