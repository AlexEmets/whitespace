import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { formatWindowLabel, useMarket24h } from '@/hooks/useMarket24h';
import { api } from '@/lib/api';
import type { Candle, CandleInterval } from '@/lib/types';

/**
 * A market listed minutes ago has no day of candles to average, and this hook used to
 * return null in that case — so every freshly listed market showed a dash for change and
 * volume while BTC showed real numbers. The rule these tests pin is: fall back to a finer
 * interval and report the window actually covered, rather than either hiding the figure
 * or passing an hour of change off as a day's.
 */

const candle = (t: number, o: string, c: string, v = '1.000000'): Candle => ({ t, o, h: c, l: o, c, v });

/** Serves a different series per interval, mimicking a market with limited history. */
function mockCandles(byInterval: Partial<Record<CandleInterval, Candle[]>>) {
  return vi.spyOn(api, 'candles').mockImplementation(async (_pair, interval) => byInterval[interval] ?? []);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatWindowLabel', () => {
  it('reports a full day as 24h and anything shorter as its real span', () => {
    expect(formatWindowLabel(24 * 3600)).toBe('24h');
    expect(formatWindowLabel(25 * 3600)).toBe('24h');
    expect(formatWindowLabel(2 * 3600)).toBe('2h');
    expect(formatWindowLabel(35 * 60)).toBe('35m');
    // Never "0m" — a window that exists is at least a minute as far as a label goes.
    expect(formatWindowLabel(20)).toBe('1m');
  });
});

describe('useMarket24h', () => {
  it('uses hourly candles and reports an untruncated window for an established market', async () => {
    const base = 1_790_000_000;
    const candles = Array.from({ length: 25 }, (_, i) => candle(base + i * 3600, '100.0', i === 24 ? '110.0' : '100.0'));
    mockCandles({ '1h': candles });

    const { result } = renderHook(() => useMarket24h(0));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(result.current!.truncated).toBe(false);
    expect(formatWindowLabel(result.current!.windowSeconds)).toBe('24h');
    // First close 100 -> last close 110 is +1000 bps.
    expect(result.current!.changeBps).toBe(1000n);
  });

  it('falls back to a finer interval when the market is too young for hourly candles', async () => {
    const base = 1_790_000_000;
    mockCandles({
      '1h': [candle(base, '100.0', '100.0')], // only one hourly candle exists
      '5m': [
        candle(base, '100.0', '100.0'),
        candle(base + 300, '100.0', '101.0'),
        candle(base + 600, '101.0', '102.0'),
      ],
    });

    const { result } = renderHook(() => useMarket24h(1));
    await waitFor(() => expect(result.current).not.toBeNull());

    // 5m series preferred over the lone 1h candle: two points beat one.
    expect(result.current!.truncated).toBe(true);
    expect(result.current!.windowSeconds).toBe(900); // 600 elapsed + one 5m candle
    expect(formatWindowLabel(result.current!.windowSeconds)).toBe('15m');
    // Earliest close 100 -> latest close 102.
    expect(result.current!.changeBps).toBe(200n);
  });

  it("uses a lone candle's open as the reference rather than showing nothing", async () => {
    const base = 1_790_000_000;
    mockCandles({ '1m': [candle(base, '100.0', '105.0')] });

    const { result } = renderHook(() => useMarket24h(3));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(result.current!.changeBps).toBe(500n);
    expect(result.current!.truncated).toBe(true);
    expect(result.current!.windowSeconds).toBe(60);
  });

  it('returns null when there is genuinely no candle data, rather than a placeholder', async () => {
    const spy = mockCandles({});
    const { result } = renderHook(() => useMarket24h(2));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3)); // all three intervals tried
    expect(result.current).toBeNull();
  });

  it('stops at the first interval that has enough history, without fetching finer ones', async () => {
    const base = 1_790_000_000;
    const spy = mockCandles({ '1h': [candle(base, '100.0', '100.0'), candle(base + 3600, '100.0', '99.0')] });

    const { result } = renderHook(() => useMarket24h(0));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current!.changeBps).toBe(-100n);
  });
});
