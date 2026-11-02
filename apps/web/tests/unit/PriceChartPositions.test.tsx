import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceChart } from '@/components/PriceChart';
import type { PositionLevel } from '@/lib/positionLevels';
import type { Candle } from '@/lib/types';

/**
 * The trader's own levels drawn over the chart: entry, take-profit, stop-loss and
 * liquidation, each a line across the plot with its price on the axis. The candles span
 * 95–112, so a level outside that has nowhere on the plot to go.
 */

const E18 = 10n ** 18n;

const CANDLES: Candle[] = [
  { t: 1_790_000_000, o: '100.000000000000000000', h: '110.000000000000000000', l: '95.000000000000000000', c: '105.000000000000000000', v: '0' },
  { t: 1_790_000_060, o: '105.000000000000000000', h: '108.000000000000000000', l: '99.000000000000000000', c: '101.000000000000000000', v: '0' },
  { t: 1_790_000_120, o: '101.000000000000000000', h: '112.000000000000000000', l: '100.000000000000000000', c: '111.000000000000000000', v: '0' },
];

const levels = vi.hoisted(() => ({ list: [] as PositionLevel[] }));

vi.mock('@/hooks/useCandles', () => ({
  useCandles: () => ({ candles: CANDLES, loading: false, error: null }),
}));
vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({ data: { mark: '111.000000000000000000', index: '111.000000000000000000', degraded: false } }),
}));
vi.mock('@/hooks/usePositionLevels', () => ({
  usePositionLevels: () => levels.list,
}));

const level = (kind: PositionLevel['kind'], price: bigint, tag: string, index = 0): PositionLevel => ({
  key: `0:${index}:${kind}`,
  kind,
  price,
  tag,
});

beforeEach(() => {
  window.localStorage.clear();
  levels.list = [];
});

describe('<PriceChart> position levels', () => {
  it('draws the entry, take-profit, stop-loss and liquidation as lines with their price on the axis', () => {
    levels.list = [
      level('entry', 100n * E18, 'Long 10.00x'),
      level('tp', 108n * E18, 'TP'),
      level('sl', 97n * E18, 'SL'),
      level('liq', 96n * E18, 'Liq.'),
    ];
    render(<PriceChart pairIndex={0} />);

    const entry = screen.getByTestId('position-level-entry');
    expect(entry.querySelector('line')).not.toBeNull();
    expect(entry).toHaveTextContent('Long 10.00x');
    expect(entry).toHaveTextContent('100.00');
    expect(screen.getByTestId('position-level-tp')).toHaveTextContent('108.00');
    expect(screen.getByTestId('position-level-sl')).toHaveTextContent('97.00');
    expect(screen.getByTestId('position-level-liq')).toHaveTextContent('Liq.');
    expect(screen.getByTestId('position-level-liq')).toHaveTextContent('96.00');
  });

  it('leaves off a level the visible price range does not reach', () => {
    levels.list = [level('entry', 100n * E18, 'Long 10.00x'), level('tp', 200n * E18, 'TP')];
    render(<PriceChart pairIndex={0} />);
    expect(screen.getByTestId('position-level-entry')).toBeInTheDocument();
    expect(screen.queryByTestId('position-level-tp')).not.toBeInTheDocument();
  });

  it('hides the axis label a level chip sits on, as it does for the live price', () => {
    levels.list = [level('entry', 100n * E18, 'Long 10.00x')];
    render(<PriceChart pairIndex={0} />);
    expect(within(screen.getByTestId('price-axis')).queryByText('100.00')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('position-level-entry')).getByText('100.00')).toBeInTheDocument();
  });

  it('draws one set of levels per position when a market holds several', () => {
    levels.list = [level('entry', 100n * E18, 'Long 10.00x', 0), level('entry', 104n * E18, 'Short 5.00x', 1)];
    render(<PriceChart pairIndex={0} />);
    expect(screen.getAllByTestId('position-level-entry')).toHaveLength(2);
  });

  it('draws no levels for a trader with no position here, and draws them once one opens', () => {
    const { rerender } = render(<PriceChart pairIndex={0} />);
    expect(screen.queryByTestId('position-levels')).not.toBeInTheDocument();

    levels.list = [level('entry', 100n * E18, 'Long 10.00x')];
    rerender(<PriceChart pairIndex={0} />);
    expect(screen.getByTestId('position-levels')).toBeInTheDocument();
  });
});
