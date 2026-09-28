'use client';

import { api } from '@/lib/api';
import type { PointsSummary } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/**
 * A wallet's confirmed season points from GET /points/:address. Poll-only (no WS channel):
 * the confirmed totals move only when a trade or claim settles, so a slow poll is enough —
 * the second-by-second motion on the page is the client-side accrual in src/lib/livePoints.ts
 * layered on top of this.
 */
export function usePoints(address: `0x${string}` | undefined) {
  const { data, error, loading, refetch } = useLiveResource<PointsSummary>({
    channel: null,
    enabled: Boolean(address),
    pollMs: 15000,
    fetcher: () => api.points(address as string),
    extractFromWs: () => null,
  });
  return { points: data, error, loading, refetch };
}
