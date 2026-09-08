'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { MarketSummary } from '@/lib/types';

export function useMarkets(): { markets: MarketSummary[]; loading: boolean; error: Error | null } {
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .markets()
      .then((data) => {
        if (!cancelled) setMarkets(data);
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
  }, []);

  return { markets, loading, error };
}
