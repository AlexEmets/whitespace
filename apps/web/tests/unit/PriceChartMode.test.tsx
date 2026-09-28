import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHART_MODE_STORAGE_KEY, closeLinePath, PriceChart } from '@/components/PriceChart';
import type { Candle } from '@/lib/types';

const CANDLES: Candle[] = [
  { t: 1_790_000_000, o: '100.000000000000000000', h: '110.000000000000000000', l: '95.000000000000000000', c: '105.000000000000000000', v: '0' },
  { t: 1_790_000_060, o: '105.000000000000000000', h: '108.000000000000000000', l: '99.000000000000000000', c: '101.000000000000000000', v: '0' },
  { t: 1_790_000_120, o: '101.000000000000000000', h: '112.000000000000000000', l: '100.000000000000000000', c: '111.000000000000000000', v: '0' },
];

vi.mock('@/hooks/useCandles', () => ({
  useCandles: () => ({ candles: CANDLES, loading: false, error: null }),
}));
vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({ data: { mark: '111.000000000000000000', index: '111.000000000000000000', degraded: false } }),
}));

beforeEach(() => {
  window.localStorage.clear();
});

describe('closeLinePath', () => {
  it('draws one segment per close and closes the area down to the baseline', () => {
    const path = closeLinePath(
      [
        { x: 10, y: 50 },
        { x: 20, y: 40 },
        { x: 30, y: 45.25 },
      ],
      100,
    );
    expect(path?.line).toBe('M10.0 50.0 L20.0 40.0 L30.0 45.3');
    expect(path?.area).toBe('M10.0 50.0 L20.0 40.0 L30.0 45.3 L30.0 100.0 L10.0 100.0 Z');
  });

  it('has nothing to draw for an empty series', () => {
    expect(closeLinePath([], 100)).toBeNull();
  });
});

describe('<PriceChart> chart type', () => {
  it('opens on candles', () => {
    render(<PriceChart pairIndex={0} />);
    expect(screen.getByTestId('chart-candles')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('chart-mode-candles')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to a line through the closes and back', () => {
    render(<PriceChart pairIndex={0} />);
    fireEvent.click(screen.getByTestId('chart-mode-line'));
    expect(screen.queryByTestId('chart-candles')).not.toBeInTheDocument();
    const line = screen.getByTestId('chart-line');
    // One area path, one line path through three closes, and the live dot.
    expect(line.querySelectorAll('path')).toHaveLength(2);
    expect(line.querySelectorAll('path')[1]!.getAttribute('d')!.match(/[ML]/g)).toHaveLength(3);
    expect(line.querySelector('circle')).not.toBeNull();
    expect(screen.getByTestId('chart-mode-line')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('chart-mode-candles'));
    expect(screen.getByTestId('chart-candles')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-line')).not.toBeInTheDocument();
  });

  it('remembers the choice for the next visit', () => {
    const { unmount } = render(<PriceChart pairIndex={0} />);
    fireEvent.click(screen.getByTestId('chart-mode-line'));
    expect(window.localStorage.getItem(CHART_MODE_STORAGE_KEY)).toBe('line');
    unmount();

    render(<PriceChart pairIndex={0} />);
    expect(screen.getByTestId('chart-line')).toBeInTheDocument();
  });

  it('falls back to candles when storage holds anything else', () => {
    window.localStorage.setItem(CHART_MODE_STORAGE_KEY, 'bars');
    render(<PriceChart pairIndex={0} />);
    expect(screen.getByTestId('chart-candles')).toBeInTheDocument();
  });
});
