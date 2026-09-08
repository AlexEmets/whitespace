'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Candle, CandleInterval } from '@/lib/types';
import { getWsClient } from '@/lib/ws';

/** Historical candles from REST, with the in-progress candle updated live over WS
 * (`candles:<pairIndex>:<interval>`). */
export function useCandles(pairIndex: number | null, interval: CandleInterval, from: number, to: number) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (pairIndex === null) return;
    let cancelled = false;
    setLoading(true);
    api
      .candles(pairIndex, interval, from, to)
      .then((data) => {
        if (!cancelled) setCandles(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pairIndex, interval, from, to]);

  useEffect(() => {
    if (pairIndex === null) return;
    const channel = `candles:${pairIndex}:${interval}`;
    const client = getWsClient();
    const unsubscribe = client.subscribe(channel, (msg) => {
      if (msg.type !== 'candle') return;
      const next = msg.data;
      setCandles((prev) => {
        if (prev.length > 0 && prev[prev.length - 1]?.t === next.t) {
          return [...prev.slice(0, -1), next];
        }
        return [...prev, next];
      });
    });
    return unsubscribe;
  }, [pairIndex, interval]);

  return { candles, loading, error };
}
