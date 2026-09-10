'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { PriceResponse } from '@/lib/types';

/**
 * Mark prices for an arbitrary *set* of markets at once.
 *
 * `usePrice` is deliberately one-market-per-call, which is why `PositionsList` pushes it
 * down into a per-row child component. The portfolio needs the opposite shape: a single
 * account-level unrealised-PnL figure summed across every market the trader is in, which
 * cannot be assembled from a variable number of hook calls without breaking the rules of
 * hooks. So this fetches the whole set inside one effect instead of calling `usePrice` in
 * a loop.
 *
 * REST-polled only, no WS subscription: `useLiveResource`'s socket path is per-channel and
 * the poll is already its documented fallback for exactly this reason. A portfolio
 * valuation refreshed every few seconds is the right cadence; the terminal is where
 * tick-level freshness matters.
 */
export function useMarkPrices(pairIndexes: number[], pollMs = 5000): {
  prices: Record<number, PriceResponse>;
  loading: boolean;
  error: Error | null;
} {
  const [prices, setPrices] = useState<Record<number, PriceResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Sorted + joined so the effect keys off the *contents* of the set, not the identity of
  // the array a caller rebuilds on every render.
  const key = useMemo(() => [...new Set(pairIndexes)].sort((a, b) => a - b).join(','), [pairIndexes]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const indexes = key === '' ? [] : key.split(',').map(Number);

    if (indexes.length === 0) {
      setPrices({});
      setLoading(false);
      return;
    }

    async function load() {
      try {
        const settled = await Promise.all(
          indexes.map(async (pairIndex) => [pairIndex, await api.price(pairIndex)] as const),
        );
        if (cancelledRef.current) return;
        setPrices(Object.fromEntries(settled));
        setError(null);
      } catch (err: unknown) {
        if (cancelledRef.current) return;
        // One failed market invalidates the account total, so the error is surfaced rather
        // than leaving a stale partial map that a caller would sum as if it were complete.
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    }

    setLoading(true);
    void load();
    const interval = setInterval(() => void load(), pollMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [key, pollMs]);

  return { prices, loading, error };
}
