'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Candle, CandleInterval } from '@/lib/types';
import { collateralToRaw, priceToRaw } from '@/lib/money';

const FULL_WINDOW_SECONDS = 24 * 3600;

/** Seconds per interval, for turning a candle count into a real elapsed span. Only the
 * intervals this hook asks for — the full table lives in @whitespace/shared/candles. */
const INTERVAL_SECONDS: Record<string, number> = { '1h': 3600, '5m': 300, '1m': 60 };

/**
 * Progressively finer series, tried in order until one has enough points.
 *
 * A market listed an hour ago has no 1h candles to speak of, and asking for a day of them
 * returns a series too short to derive anything from — which is why newly listed markets
 * showed a dash where every other market showed a number. Falling back to a finer
 * interval keeps the figure real (it is still measured from actual candles) while
 * shortening the window to what the market has actually existed for.
 *
 * The lookbacks shrink with the interval on purpose: there is no point pulling 1m candles
 * across a whole day when this path is only reached for markets that have not been alive
 * that long.
 */
const ATTEMPTS: { interval: CandleInterval; lookbackSeconds: number }[] = [
  { interval: '1h', lookbackSeconds: 25 * 3600 },
  { interval: '5m', lookbackSeconds: 6 * 3600 },
  { interval: '1m', lookbackSeconds: 2 * 3600 },
];

export interface Market24h {
  /** Signed bps change across `windowSeconds`. */
  changeBps: bigint;
  /** Sum of candle volumes across `windowSeconds` (raw collateral units, per Candle.v). */
  volume: bigint;
  /** How much time these figures actually cover. Less than a day for a market younger
   * than one, so callers must label the number with this rather than assuming "24h". */
  windowSeconds: number;
  /** True when the window is short because the market has not existed for a full day. */
  truncated: boolean;
}

/** "24h", "2h", "35m" — the span a Market24h actually describes, for UI labels. */
export function formatWindowLabel(windowSeconds: number): string {
  if (windowSeconds >= FULL_WINDOW_SECONDS) return '24h';
  const hours = Math.floor(windowSeconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.round(windowSeconds / 60))}m`;
}

function summarise(candles: Candle[], interval: CandleInterval): Market24h | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return null;

  // With two or more candles the reference is the earliest CLOSE — "what it was then
  // versus now". With exactly one, the only earlier price inside the series is that
  // candle's OPEN, which is the honest reference for a market minutes old rather than
  // grounds for showing nothing.
  const reference = candles.length >= 2 ? priceToRaw(first.c) : priceToRaw(first.o);
  const lastClose = priceToRaw(last.c);
  if (reference === 0n) return null;

  const changeBps = ((lastClose - reference) * 10_000n) / reference;
  const volume = candles.reduce((sum, c) => sum + collateralToRaw(c.v), 0n);
  const windowSeconds = last.t + (INTERVAL_SECONDS[interval] ?? 0) - first.t;

  return { changeBps, volume, windowSeconds, truncated: windowSeconds < FULL_WINDOW_SECONDS };
}

/**
 * Change and volume over the last 24h, or over the market's whole life when that is
 * shorter, computed from real `/markets/:pairIndex/candles` data rather than invented.
 * The read API has no dedicated stats field, so this derives it client-side from the same
 * candle series the chart uses.
 *
 * Returns null only while loading or when there is genuinely no candle data at all —
 * never a placeholder value, and no longer a dash merely because the market is young.
 * Callers must render `windowSeconds` (via `formatWindowLabel`) instead of hardcoding
 * "24h", or a two-hour-old market will be captioned with a day it has not lived.
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

    (async () => {
      // A single candle is usable but worse than two at a finer interval, so it is held
      // as a fallback and only returned once every attempt has failed to do better.
      let fallback: Market24h | null = null;

      for (const { interval, lookbackSeconds } of ATTEMPTS) {
        let candles: Candle[];
        try {
          candles = await api.candles(pairIndex, interval, now - lookbackSeconds, now);
        } catch {
          return null;
        }
        if (cancelled) return null;

        if (candles.length >= 2) return summarise(candles, interval);
        if (candles.length === 1 && fallback === null) fallback = summarise(candles, interval);
      }
      return fallback;
    })().then((value) => {
      if (!cancelled) setResult(value);
    });

    return () => {
      cancelled = true;
    };
  }, [pairIndex]);

  return result;
}
