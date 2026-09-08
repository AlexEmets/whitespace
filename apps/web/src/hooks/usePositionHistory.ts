'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ClosedPositionSummary } from '@/lib/types';

/** Closed positions with realised PnL, from GET /positions/:address/history — backs the
 * terminal's "Fills" tab. */
export function usePositionHistory(address: `0x${string}` | undefined) {
  const [history, setHistory] = useState<ClosedPositionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .positionHistory(address)
      .then((data) => {
        if (!cancelled) setHistory(data);
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
  }, [address]);

  return { history, loading, error };
}
