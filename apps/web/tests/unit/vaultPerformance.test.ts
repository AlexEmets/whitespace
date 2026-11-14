import { describe, expect, it } from 'vitest';
import { formatReturn, isLoss, sharePriceGeometry } from '@/lib/vaultPerformance';

describe('formatReturn', () => {
  it('shows a fraction as a signed percentage, rounded half-up in bigint', () => {
    expect(formatReturn('0.006054782846320045')).toBe('+0.61%');
    expect(formatReturn('-1.042857142857142857')).toBe('-104.29%');
    expect(formatReturn('0.000125000000000000')).toBe('+0.01%');
  });

  it('never claims a loss nobody can see: a return that rounds to nothing is 0.00%', () => {
    expect(formatReturn('-0.000000100000000000')).toBe('0.00%');
    expect(formatReturn('0.000000000000000000')).toBe('0.00%');
  });

  it('takes more digits when asked', () => {
    expect(formatReturn('0.000116851971447830', 3)).toBe('+0.012%');
  });
});

describe('isLoss', () => {
  it('is true only below zero', () => {
    expect(isLoss('-0.000000000000000001')).toBe(true);
    expect(isLoss('0.000000000000000000')).toBe(false);
    expect(isLoss('0.01')).toBe(false);
  });
});

describe('sharePriceGeometry', () => {
  const day = 86_400;

  it('has nothing to draw for fewer than two points', () => {
    expect(sharePriceGeometry([], 100, 50)).toBeNull();
    expect(sharePriceGeometry([{ t: 0, sharePrice: '1' }], 100, 50)).toBeNull();
  });

  it('draws steps placed by time, so a pause in settlements stays a long flat stretch', () => {
    const g = sharePriceGeometry(
      [
        { t: 0, sharePrice: '1.000000000000000000' },
        { t: 1 * day, sharePrice: '1.010000000000000000' },
        { t: 4 * day, sharePrice: '1.020000000000000000' },
      ],
      100,
      50,
      0,
    )!;
    // x: day 1 is a quarter of the way, day 4 the end; y: 1.00 at the bottom, 1.02 at the top
    expect(g.line).toBe('M0 50 H25 V25 H100 V0');
    expect(g.area).toBe('M0 50 H25 V25 H100 V0 V50 H0 Z');
  });

  it('keeps par on the chart, so a vault below 1 USDW a share reads as under the line', () => {
    const g = sharePriceGeometry(
      [
        { t: 0, sharePrice: '0.990000000000000000' },
        { t: day, sharePrice: '0.980000000000000000' },
      ],
      100,
      40,
      0,
    )!;
    expect(g.parY).toBe(0); // par is the top of the range
    expect(g.line).toBe('M0 20 H100 V40');
  });
});
