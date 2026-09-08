'use client';

import { api } from '@/lib/api';
import type { PriceResponse } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/** Live price for a market: REST `/price/:pairIndex` + WS `price:<pairIndex>`. Carries
 * `degraded`/`healthyVenues` straight through — callers (the open-position control) must
 * check `degraded` themselves; this hook does not hide it. */
export function usePrice(pairIndex: number | null) {
  return useLiveResource<PriceResponse>({
    channel: pairIndex === null ? null : `price:${pairIndex}`,
    enabled: pairIndex !== null,
    pollMs: 3000,
    fetcher: () => api.price(pairIndex as number),
    extractFromWs: (msg) => (msg.type === 'price' ? msg.data : null),
  });
}
