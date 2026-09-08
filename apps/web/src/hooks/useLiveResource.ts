'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWsClient } from '@/lib/ws';
import type { WsMessage } from '@/lib/types';

/**
 * Combines an initial + polled REST fetch with a WS subscription for live updates. The
 * poll keeps running even once the socket is connected — it is cheap, and it is the
 * fallback that makes this correct when the socket never connects at all (see design §7:
 * "RPC down" / venue loss are expected conditions, not exceptions). The WS update, when
 * it arrives, just updates state a little sooner than the next poll tick would have.
 */
export function useLiveResource<T>(opts: {
  channel: string | null;
  fetcher: () => Promise<T>;
  extractFromWs: (msg: WsMessage) => T | null;
  pollMs?: number;
  enabled?: boolean;
}): { data: T | null; error: Error | null; loading: boolean; refetch: () => void } {
  const { channel, fetcher, extractFromWs, pollMs = 5000, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => {
    if (!enabled) return;
    fetcherRef
      .current()
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    refetch();
    const interval = setInterval(refetch, pollMs);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pollMs, channel]);

  useEffect(() => {
    if (!enabled || !channel) return;
    const client = getWsClient();
    const unsubscribe = client.subscribe(channel, (msg) => {
      const extracted = extractFromWs(msg);
      if (extracted !== null) {
        setData(extracted);
        setError(null);
        setLoading(false);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, channel]);

  return { data, error, loading, refetch };
}
