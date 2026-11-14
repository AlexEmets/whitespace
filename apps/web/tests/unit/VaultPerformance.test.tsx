import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultPerformance } from '@/components/VaultPerformance';
import type { VaultPerformance as Perf } from '@/lib/types';

const state = vi.hoisted(() => ({ performance: null as unknown, error: null as Error | null }));
vi.mock('@/hooks/useVaultPerformance', () => ({
  useVaultPerformance: () => ({ performance: state.performance, error: state.error, loading: false }),
}));

const SEP28 = 1_790_589_584;
const NOV14 = 1_794_661_605;

const PERF: Perf = {
  sharePrice: '1.001876331628249814',
  totalAssets: '1234326.916730',
  updatedAt: NOV14,
  windows: {
    '7d': { from: NOV14 - 7 * 86_400, sharePriceThen: '1.0017', change: '0.000116851971447830', apr: '0.006054782846320045' },
    '30d': { from: NOV14 - 30 * 86_400, sharePriceThen: '1.0011', change: '0.000721423365949718', apr: '0.008648326757768129' },
    all: { from: SEP28, sharePriceThen: '1.000000000000000000', change: '0.001876331628249814', apr: '0.014531357826613893' },
  },
  series: [
    { t: SEP28, sharePrice: '1.000000000000000000' },
    { t: NOV14, sharePrice: '1.001876331628249814' },
  ],
};

beforeEach(() => {
  state.performance = null;
  state.error = null;
});

describe('<VaultPerformance>', () => {
  it('shows the 7- and 30-day APR, the return since launch and the share price', () => {
    state.performance = PERF;
    render(<VaultPerformance />);
    expect(screen.getByTestId('vault-apr-7d')).toHaveTextContent('+0.61%');
    expect(screen.getByTestId('vault-apr-30d')).toHaveTextContent('+0.86%');
    expect(screen.getByTestId('vault-since-launch')).toHaveTextContent('+0.19%');
    expect(screen.getByTestId('vault-since-launch')).toHaveTextContent('+1.45% APR since 28 Sep 2026');
    expect(screen.getByTestId('vault-share-price')).toHaveTextContent('1.0019USDW');
    expect(screen.getByTestId('vault-chart')).toHaveTextContent('28 Sep 2026');
  });

  it('colours a negative return as a loss and a positive one as a gain', () => {
    state.performance = { ...PERF, windows: { ...PERF.windows, '7d': { ...PERF.windows['7d']!, apr: '-0.120000000000000000' } } };
    render(<VaultPerformance />);
    expect(within(screen.getByTestId('vault-apr-7d')).getByText('-12.00%')).toHaveClass('neg');
    expect(within(screen.getByTestId('vault-apr-30d')).getByText('+0.86%')).toHaveClass('pos');
  });

  it('gives a window the vault is too young for a dash that says so, not a number from a shorter one', () => {
    state.performance = { ...PERF, windows: { ...PERF.windows, '30d': null } };
    render(<VaultPerformance />);
    const dash = within(screen.getByTestId('vault-apr-30d')).getByTestId('honest-dash');
    expect(dash).toHaveAttribute('title', 'Not available: the vault is younger than 30 days');
    expect(screen.getByTestId('vault-apr-7d')).toHaveTextContent('+0.61%');
  });

  it('says the history could not be loaded when the API fails', () => {
    state.error = new Error('GET /vault/performance -> 500');
    render(<VaultPerformance />);
    for (const id of ['vault-apr-7d', 'vault-apr-30d', 'vault-since-launch', 'vault-share-price']) {
      expect(within(screen.getByTestId(id)).getByTestId('honest-dash')).toHaveAttribute(
        'title',
        'Not available: the vault history could not be loaded',
      );
    }
    expect(screen.queryByTestId('vault-chart')).toBeNull();
  });

  it('waits for a second day of settlements before drawing the chart', () => {
    state.performance = { ...PERF, series: PERF.series.slice(0, 1) };
    render(<VaultPerformance />);
    expect(screen.queryByTestId('vault-chart')).toBeNull();
    expect(screen.getByText('The chart starts once the vault has settled on two different days.')).toBeInTheDocument();
  });
});
