'use client';

import { useMemo, useState } from 'react';
import { useCandles } from '@/hooks/useCandles';
import { usePrice } from '@/hooks/usePrice';
import { parseRawUnits, formatMoney } from '@/lib/money';
import { PRICE_DECIMALS_NUM } from '@/lib/config';
import type { CandleInterval } from '@/lib/types';
import { DegradedBanner } from './DegradedBanner';

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
// Every interval services/api actually supports (D3) — deliberately not offering the
// mockup's "1W", which is not one of the enum values GET /candles accepts.
const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** Candlestick chart over `/candles`, plus the live mark/index price from the
 * `price:<pairIndex>` WS channel (REST-polled fallback). Interval selection and the log
 * scale toggle are both genuine, wired features; DEPTH/INDICATORS have no backing
 * implementation and are rendered disabled rather than omitted (matching the mockup's
 * intended affordance without pretending they work). */
export function PriceChart({ pairIndex }: { pairIndex: number | null }) {
  const [interval, setInterval] = useState<CandleInterval>('1h');
  const [logScale, setLogScale] = useState(false);
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const from = now - 60 * 60 * 24 * 2; // 2 days back
  const { candles, loading, error } = useCandles(pairIndex, interval, from, now);
  const { data: price } = usePrice(pairIndex);

  const geometry = useMemo(() => {
    if (candles.length === 0) return null;
    const highs = candles.map((c) => parseRawUnits(c.h));
    const lows = candles.map((c) => parseRawUnits(c.l));
    const min = lows.reduce((a, b) => (b < a ? b : a), lows[0] as bigint);
    const max = highs.reduce((a, b) => (b > a ? b : a), highs[0] as bigint);

    // Display-only pixel-position math: converting an exact bigint price to a JS number
    // ratio here is safe because the result never reaches a money formatter or a
    // transaction — only an SVG y-coordinate. See src/lib/money.ts's module doc for the
    // boundary this project draws around bigint-only money handling.
    const toY = (value: bigint) => {
      const v = logScale ? Math.log(Number(value)) : Number(value);
      const lo = logScale ? Math.log(Number(min)) : Number(min);
      const hi = logScale ? Math.log(Number(max)) : Number(max);
      const ratio = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      return CHART_HEIGHT - ratio * CHART_HEIGHT;
    };

    const step = CHART_WIDTH / Math.max(1, candles.length);
    const bodyWidth = Math.max(2, step * 0.6);

    return candles.map((c, i) => {
      const x = i * step + step / 2;
      const open = parseRawUnits(c.o);
      const close = parseRawUnits(c.c);
      const high = parseRawUnits(c.h);
      const low = parseRawUnits(c.l);
      const up = close >= open;
      return {
        key: c.t,
        x,
        wickTop: toY(high),
        wickBottom: toY(low),
        bodyTop: toY(up ? close : open),
        bodyBottom: toY(up ? open : close),
        bodyWidth,
        up,
      };
    });
  }, [candles, logScale]);

  return (
    <div data-testid="price-chart">
      <div className="chart-toolbar">
        <div className="group" data-testid="interval-group">
          {INTERVALS.map((i) => (
            <button key={i} type="button" className={interval === i ? 'active' : ''} onClick={() => setInterval(i)} data-testid={`interval-${i}`}>
              {i.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="group">
          <button type="button" disabled title="Not implemented">
            Depth
          </button>
          <button type="button" disabled title="Not implemented">
            Indicators
          </button>
          <button type="button" className={logScale ? 'active' : ''} onClick={() => setLogScale((v) => !v)} data-testid="log-scale-toggle">
            Log scale
          </button>
        </div>
      </div>

      <div className="market-header" style={{ borderBottom: 'none', padding: '0.5rem 1.2rem' }}>
        <span className="last-price" data-testid="mark-price">
          {price ? <>{formatMoney(price.mark, PRICE_DECIMALS_NUM)}</> : '—'}
        </span>
        {price ? (
          <span className="stat-cell" data-testid="index-price">
            index {formatMoney(price.index, PRICE_DECIMALS_NUM)}
          </span>
        ) : null}
      </div>
      {price && price.degraded ? <DegradedBanner healthyVenues={price.healthyVenues} /> : null}

      <div className="chart-area">
        {loading ? <p>Loading candles…</p> : null}
        {error ? <p className="error-text">Failed to load candles: {error.message}</p> : null}
        {!loading && !error && candles.length === 0 ? <p>No candle data yet.</p> : null}
        {geometry ? (
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label="Price chart" data-testid="price-svg">
            {geometry.map((candle) => (
              <g key={candle.key} stroke={candle.up ? 'var(--long)' : 'var(--short)'} fill={candle.up ? 'var(--long)' : 'var(--short)'}>
                <line x1={candle.x} x2={candle.x} y1={candle.wickTop} y2={candle.wickBottom} strokeWidth={1} />
                <rect
                  x={candle.x - candle.bodyWidth / 2}
                  y={Math.min(candle.bodyTop, candle.bodyBottom)}
                  width={candle.bodyWidth}
                  height={Math.max(1, Math.abs(candle.bodyBottom - candle.bodyTop))}
                />
              </g>
            ))}
          </svg>
        ) : null}
      </div>
    </div>
  );
}
