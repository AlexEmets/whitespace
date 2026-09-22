import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PointsPanel } from '@/components/points/PointsPanel';
import type { ClosedPositionSummary } from '@/lib/types';

/**
 * /points exists to NOT say things, so most of what is worth testing here is absence.
 *
 * The mockup's four figures — 128,904 points, Rank 214, "EPOCH 07 4D 11H", "referral 25%
 * of taker fees" — are asserted against explicitly. A future edit that reintroduces any of
 * them as a placeholder should fail this file rather than ship.
 */

const connected = vi.hoisted(() => ({ value: true }));

const closedTrade = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '100.000000',
  leverage: '10.00', // -> 1,000.00 notional
  openPrice: '65001.000000000000000000',
  closePrice: '64999.000000000000000000',
  tp: '0',
  sl: '0',
  tradeId: '2',
  openedAt: 1788881084,
  closedAt: 1788881094,
  closeReason: 'close',
  usdcSentToTrader: '98.000000',
  realizedPnl: '-2.000000',
} as unknown as ClosedPositionSummary;

vi.mock('wagmi', () => ({
  useAccount: () =>
    connected.value
      ? { address: '0x2b8ba090DEdF879f8045c0dDA5a78762cED90D19' as const, isConnected: true }
      : { address: undefined, isConnected: false },
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [
      {
        pairIndex: 0,
        from: 'BTC',
        to: 'USD',
        feedId: '0x0',
        maxLeverage: '100.00',
        maxOpenInterest: '1000000.000000',
        openInterest: { long: '0.000000', short: '0.000000' },
      },
    ],
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: [], error: null, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/usePositionHistory', () => ({
  usePositionHistory: () => ({ history: connected.value ? [closedTrade] : [], loading: false, error: null }),
}));

// Real on-chain values as read from 1874: a 1.00 USDW flat oracle fee and a market
// currently configured at 0% opening fees.
vi.mock('@/hooks/useMarketFees', () => ({
  useMarketFees: () => ({ makerFeeRaw: 0n, takerFeeRaw: 0n, oracleFeeRaw: 1_000000n, loading: false }),
}));

describe('<PointsPanel>', () => {
  it('states that points are not issued, in the slot the mockup reserved for a total', () => {
    connected.value = true;
    render(<PointsPanel />);
    expect(screen.getByTestId('points-balance')).toHaveTextContent(/not issued/i);
    expect(screen.getByTestId('points-notice')).toHaveTextContent(/nothing on this page is an allocation/i);
    expect(screen.getByTestId('points-notice')).toHaveTextContent(/nothing here is a promised allocation/i);
  });

  it('invents no total, no rank, no epoch and no referral share', () => {
    connected.value = true;
    const { container } = render(<PointsPanel />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('128,904');
    expect(text).not.toMatch(/Rank\s*214/);
    expect(text).not.toMatch(/EPOCH\s*07/i);
    expect(text).not.toMatch(/25%\s*of\s*taker/i);
    // The three unknowable figures are dashes, not numbers.
    for (const id of ['points-rank', 'points-epoch', 'points-referral']) {
      expect(screen.getByTestId(id)).toHaveTextContent('—');
    }
  });

  it('shows traded volume derived from the address\'s own closed positions', () => {
    connected.value = true;
    render(<PointsPanel />);
    // 100.00 collateral x 10.00x = 1,000.00 USDW of opening notional.
    expect(screen.getByTestId('activity-volume')).toHaveTextContent('1,000.00');
    expect(screen.getByTestId('activity-realised')).toHaveTextContent('-2.00');
    expect(screen.getByTestId('activity-trades')).toHaveTextContent('1');
    expect(screen.getByTestId('points-market-0')).toHaveTextContent('BTC-PERP');
  });

  it('leaves fees-paid an explained dash rather than estimating it', () => {
    connected.value = true;
    render(<PointsPanel />);
    const tile = screen.getByTestId('activity-fees-paid');
    expect(tile).toHaveTextContent('—');
    expect(tile.querySelector('[data-testid="honest-dash"]')?.getAttribute('title')).toMatch(/no per-trade fee field/i);
  });

  it('shows the live fee schedule, which is a market property and needs no wallet', () => {
    connected.value = false;
    render(<PointsPanel />);
    expect(screen.getByTestId('fee-oracle')).toHaveTextContent('1.00 USDW');
    expect(screen.getByTestId('fee-maker')).toHaveTextContent('0.00%');
    expect(screen.getByTestId('fee-taker')).toHaveTextContent('0.00%');
    // Funding has no endpoint behind it anywhere in this system.
    expect(screen.getByTestId('fee-funding')).toHaveTextContent('—');
  });

  it('keeps the honesty notice visible while disconnected, and asks for a wallet only for the personal figures', () => {
    connected.value = false;
    render(<PointsPanel />);
    expect(screen.getByTestId('points-notice')).toBeInTheDocument();
    expect(screen.getByTestId('account-state-disconnected')).toHaveTextContent(/connect a wallet/i);
    connected.value = true;
  });
});
