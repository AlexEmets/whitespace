import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PointsPanel } from '@/components/points/PointsPanel';
import type { PointsSummary } from '@/lib/types';

/**
 * The dashboard renders confirmed totals from GET /points/:address and layers a live estimate
 * over them. These tests pin the confirmed rendering and the structure; the live-accrual maths
 * has its own unit test (livePoints.test.ts), so here the open position is held under the floor
 * and the pool balance's anchor is "now", making both live deltas zero and the assertions exact.
 */

const connected = vi.hoisted(() => ({ value: true }));
const nowSec = Math.floor(Date.now() / 1000);

const points: PointsSummary = {
  address: '0x2b8ba090dedf879f8045c0dda5a78762ced90d19',
  missions: '500.000000',
  time: '214.600000',
  streak: '128.000000',
  lp: '96.400000',
  total: '939.000000',
  rank: 1,
  streakDays: 5,
  streakLongest: 6,
  completedMissions: ['first_market_trade', 'limit_filled'],
  updatedAt: nowSec,
  lpBalance: '8500.000000',
  lpSince: nowSec,
};

vi.mock('wagmi', () => ({
  useAccount: () =>
    connected.value
      ? { address: '0x2b8ba090DEdF879f8045c0dDA5a78762cED90D19' as const, isConnected: true }
      : { address: undefined, isConnected: false },
}));

vi.mock('@/hooks/usePoints', () => ({
  usePoints: () => ({ points: connected.value ? points : undefined, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({
    // Held under the 5-minute floor, so the live time delta is exactly zero.
    positions: connected.value
      ? [
          {
            pairIndex: 0,
            index: 0,
            buy: true,
            collateral: '1240.000000',
            leverage: '10.00',
            openPrice: '60000.000000000000000000',
            tp: '0',
            sl: '0',
            openedAt: nowSec - 60,
            tradeId: '2',
          },
        ]
      : [],
    error: null,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [
      { pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x0', maxLeverage: '100.00', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } },
    ],
    loading: false,
    error: null,
  }),
}));

describe('<PointsPanel>', () => {
  it('shows the season total, rank and streak multiplier', () => {
    connected.value = true;
    render(<PointsPanel />);
    expect(screen.getByTestId('points-total')).toHaveTextContent(/939\.00/);
    expect(screen.getByTestId('points-rank')).toHaveTextContent('#1');
    expect(screen.getByTestId('points-multiplier')).toHaveTextContent('×1.33'); // day 5
  });

  it('shows mission progress and the confirmed component totals', () => {
    connected.value = true;
    render(<PointsPanel />);
    expect(screen.getByTestId('missions-progress')).toHaveTextContent('2/12');
    expect(screen.getByTestId('card-missions')).toHaveTextContent('500');
    expect(screen.getByTestId('streak-days')).toHaveTextContent('5');
  });

  it('renders the two live counters at their confirmed value when nothing is accruing', () => {
    connected.value = true;
    render(<PointsPanel />);
    expect(screen.getByTestId('time-live')).toHaveTextContent(/214\.6/);
    expect(screen.getByTestId('lp-live')).toHaveTextContent(/96\.4/);
  });

  it('lists every mission with the earned ones marked', () => {
    connected.value = true;
    render(<PointsPanel />);
    const card = screen.getByTestId('card-missions');
    expect(card).toHaveTextContent('First market trade');
    expect(card).toHaveTextContent('Survive a liquidation');
    // The completed ones render a "+points"; the earned mission shows its value with a plus.
    expect(card).toHaveTextContent('+50');
  });

  it('says how far the next tier is, not only which tier this is', () => {
    connected.value = true;
    render(<PointsPanel />);
    // 939 points: Trader (500–2,000), 1,061 short of Pro.
    const tier = screen.getByTestId('points-tier');
    expect(tier).toHaveTextContent('Trader');
    expect(tier).toHaveTextContent('1,061 pts to Pro');
  });

  it('lays the four ways to earn out as rows, each with what is accruing against its daily cap', () => {
    connected.value = true;
    render(<PointsPanel />);
    expect(screen.getByTestId('earn-missions')).toHaveTextContent('2 of 12 done · up to 850');
    expect(screen.getByTestId('card-time')).toHaveTextContent(/Accruing [\d.]+ · max 100 \/ day/);
    expect(screen.getByTestId('card-streak')).toHaveTextContent('Day 5 of 7 · ×1.33');
    expect(screen.getByTestId('card-lp')).toHaveTextContent(/Accruing [\d.]+ · max 50 \/ day/);
  });

  it('states every anti-farm rule once, in one line at the foot', () => {
    connected.value = true;
    render(<PointsPanel />);
    const rules = screen.getByTestId('points-note');
    expect(rules).toHaveTextContent('under 5 min');
    expect(rules).toHaveTextContent('each mission counts once per wallet');
    expect(screen.queryByText(/Anti-farm/)).not.toBeInTheDocument();
  });

  it('asks for a wallet when disconnected but still shows what can be earned', () => {
    connected.value = false;
    render(<PointsPanel />);
    expect(screen.getByTestId('account-state-disconnected')).toHaveTextContent(/connect a wallet/i);
    expect(screen.getByTestId('card-missions')).toHaveTextContent('First market trade');
    connected.value = true;
  });
});
