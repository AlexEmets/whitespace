'use client';

import { api } from '@/lib/api';
import type { PositionSummary } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

export function usePositions(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<PositionSummary[]>({
    channel: address ? `positions:${address}` : null,
    enabled: Boolean(address),
    pollMs: 5000,
    fetcher: () => api.positions(address as string),
    extractFromWs: (msg) => (msg.type === 'positions' ? msg.data : null),
  });
  return { positions: data ?? [], error, loading, refetch };
}
