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
}): { data: T | null; error: Error | null; stale: boolean; loading: boolean; refetch: () => void } {
  const { channel, fetcher, extractFromWs, pollMs = 5000, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Bumped whenever the channel changes. A response started for the previous channel (the
  // previous wallet, say) can resolve after the switch; without this it overwrote the new
  // channel's data with the old one's.
  const generation = useRef(0);

  const refetch = useCallback(() => {
    if (!enabled) return;
    const gen = generation.current;
    fetcherRef
      .current()
      .then((next) => {
        if (gen !== generation.current) return;
        setData(next);
        setFetchError(null);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        setFetchError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
  }, [enabled]);

  useEffect(() => {
    generation.current += 1;
    setData(null);
    setFetchError(null);
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
        setFetchError(null);
        setLoading(false);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, channel]);

  // A failed refresh does not throw away what the last good one returned. Every table used to
  // swap itself for "Failed to load…" on one bad poll, which during an API or indexer outage
  // hid the Close and Reclaim buttons — the escape paths that must keep working when the read
  // side is down. `error` now means "nothing to show"; `stale` means "showing the last data".
  return {
    data,
    error: data === null ? fetchError : null,
    stale: data !== null && fetchError !== null,
    loading,
    refetch,
  };
}
