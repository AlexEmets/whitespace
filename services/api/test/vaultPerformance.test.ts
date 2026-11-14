import { describe, expect, it } from 'vitest';
import { DAY_SECONDS, MAX_SERIES_DAYS, vaultPerformance, type SettlementPoint } from '../src/vaultPerformance.js';

/**
 * The arithmetic behind GET /vault/performance, without a database: what an LP earned over a
 * window is the share price's change between two settlements, and the APR annualises it over
 * the time that actually passed between them.
 */

const E18 = 10n ** 18n;
const T0 = 1_790_000_000; // 2026-09-21 13:46:40 UTC
const at = (days: number, sharePrice: bigint, totalAssets: bigint | null = 1_000_000_000000n): SettlementPoint => ({
  ts: T0 + Math.round(days * DAY_SECONDS),
  sharePrice,
  totalAssets,
});

describe('vaultPerformance', () => {
  it('is null before the vault has settled once', () => {
    expect(vaultPerformance([])).toBeNull();
  });

  it('reports the latest share price, assets and settlement time', () => {
    const perf = vaultPerformance([at(0, E18), at(1, (E18 * 1005n) / 1000n, 2_500_000_000000n)])!;
    expect(perf.sharePrice).toBe('1.005000000000000000');
    expect(perf.totalAssets).toBe('2500000.000000');
    expect(perf.updatedAt).toBe(T0 + DAY_SECONDS);
  });

  it('measures the 7-day window from the settlement 7 days back, with an exact, simple APR', () => {
    const perf = vaultPerformance([at(0, E18), at(3, (E18 * 1004n) / 1000n), at(7, (E18 * 101n) / 100n)])!;
    expect(perf.windows['7d']).toEqual({
      from: T0,
      sharePriceThen: '1.000000000000000000',
      change: '0.010000000000000000',
      // 1% over 7 days, times 365/7, truncated — never compounded
      apr: '0.521428571428571428',
    });
  });

  it('starts a window at a settlement exactly on its boundary, not the one after it', () => {
    const perf = vaultPerformance([at(0, E18), at(0.5, 2n * E18), at(7, 2n * E18)])!;
    expect(perf.windows['7d']!.from).toBe(T0);
    expect(perf.windows['7d']!.change).toBe('1.000000000000000000');
  });

  it('annualises over the time that passed when settlements paused before the window', () => {
    // nothing settled between day 0 and day 9: the 7-day window reaches back the full 10 days
    const perf = vaultPerformance([at(0, E18), at(10, (E18 * 101n) / 100n)])!;
    expect(perf.windows['7d']!.from).toBe(T0);
    expect(perf.windows['7d']!.apr).toBe('0.365000000000000000');
  });

  it('reads a falling share price as a negative return', () => {
    const perf = vaultPerformance([at(0, E18), at(7, (E18 * 98n) / 100n)])!;
    expect(perf.windows['7d']!.change).toBe('-0.020000000000000000');
    expect(perf.windows['7d']!.apr).toBe('-1.042857142857142857');
  });

  it('has no 30-day figure for a vault younger than 30 days, and nothing since launch from one settlement', () => {
    const young = vaultPerformance([at(0, E18), at(10, (E18 * 101n) / 100n)])!;
    expect(young.windows['30d']).toBeNull();
    expect(young.windows.all).not.toBeNull();
    expect(vaultPerformance([at(0, E18)])!.windows).toEqual({ '7d': null, '30d': null, all: null });
  });

  it('measures "since launch" from the very first settlement', () => {
    const perf = vaultPerformance([at(0, E18), at(20, (E18 * 1001n) / 1000n), at(40, (E18 * 1002n) / 1000n)])!;
    expect(perf.windows.all).toMatchObject({ from: T0, change: '0.002000000000000000' });
    expect(perf.windows['30d']!.from).toBe(T0);
  });

  it('charts the last settlement of each UTC day, oldest first', () => {
    const day0 = Math.ceil(T0 / DAY_SECONDS) * DAY_SECONDS; // a UTC midnight
    const point = (ts: number, p: bigint): SettlementPoint => ({ ts, sharePrice: p, totalAssets: null });
    const perf = vaultPerformance([
      point(day0 + 60, E18),
      point(day0 + 3_600, 2n * E18), // last of day 0
      point(day0 + DAY_SECONDS + 10, 3n * E18), // only one on day 1
    ])!;
    expect(perf.series).toEqual([
      { t: day0 + 3_600, sharePrice: '2.000000000000000000' },
      { t: day0 + DAY_SECONDS + 10, sharePrice: '3.000000000000000000' },
    ]);
    expect(perf.totalAssets).toBeNull();
  });

  it(`keeps the newest ${MAX_SERIES_DAYS} days of the chart`, () => {
    const points = Array.from({ length: MAX_SERIES_DAYS + 5 }, (_, d) => at(d, E18 + BigInt(d)));
    const perf = vaultPerformance(points)!;
    expect(perf.series).toHaveLength(MAX_SERIES_DAYS);
    expect(perf.series[0]!.t).toBe(T0 + 5 * DAY_SECONDS);
    expect(perf.series.at(-1)!.t).toBe(perf.updatedAt);
  });
});
