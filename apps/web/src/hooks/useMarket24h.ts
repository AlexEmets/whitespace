'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { collateralToRaw, priceToRaw } from '@/lib/money';

export interface Market24h {
  /** Signed bps change from 24h-ago close to the latest close. */
  changeBps: bigint;
  /** Sum of candle volumes over the fetched window (raw, collateral-equivalent units as
   * the API defines `v` — see src/lib/types.ts Candle.v). */
  volume: bigint;
}

/**
 * 24h change and volume, computed from real `/markets/:pairIndex/candles` data (1h
 * candles over the last 25h) rather than invented. The read API has no dedicated "24h
 * stats" field, so this derives it client-side from the same candle series the chart
 * uses. Returns null while loading or if there is not yet enough candle history to
 * derive a real number — never a placeholder value.
 */
export function useMarket24h(pairIndex: number | null): Market24h | null {
  const [result, setResult] = useState<Market24h | null>(null);

  useEffect(() => {
    if (pairIndex === null) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    const from = now - 25 * 3600;

    api
      .candles(pairIndex, '1h', from, now)
      .then((candles) => {
        if (cancelled) return;
        if (candles.length < 2) {
          setResult(null);
          return;
        }
        const first = candles[0];
        const last = candles[candles.length - 1];
        if (!first || !last) {
          setResult(null);
          return;
        }
        const firstClose = priceToRaw(first.c);
        const lastClose = priceToRaw(last.c);
        const changeBps = firstClose === 0n ? 0n : ((lastClose - firstClose) * 10_000n) / firstClose;
        const volume = candles.reduce((sum, c) => sum + collateralToRaw(c.v), 0n);
        setResult({ changeBps, volume });
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [pairIndex]);

  return result;
}
