import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Leaderboard } from '@/components/points/Leaderboard';
import type { LeaderboardEntry } from '@/lib/types';

/**
 * The public season-one leaderboard on /points: everyone sees the top wallets, a connected
 * wallet finds itself in it. Only the data hook is faked; the formatting and the row logic
 * are the real ones.
 */

const board = vi.hoisted(() => ({
  entries: null as LeaderboardEntry[] | null,
  loading: false,
  error: null as Error | null,
}));

vi.mock('@/hooks/useLeaderboard', () => ({
  useLeaderboard: () => ({ entries: board.entries, loading: board.loading, error: board.error }),
}));

const addr = (n: number) => `0x${n.toString(16).padStart(4, '0')}${'ab'.repeat(16)}${n.toString(16).padStart(4, '0')}`;

function entry(rank: number, overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    rank,
    address: addr(rank),
    missions: '500.000000',
    time: '10.554807',
    streak: '40.833000',
    lp: '1.441586',
    total: (1000 - rank).toFixed(6),
    ...overrides,
  };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i + 1));

beforeEach(() => {
  board.entries = many(100);
  board.loading = false;
  board.error = null;
});

describe('<Leaderboard>', () => {
  it('shows the top ten, each with its rank, a shortened wallet and its total', () => {
    render(<Leaderboard />);
    const rows = screen.getAllByTestId('leaderboard-row');
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[0]).toHaveTextContent('0x0001…0001');
    expect(rows[0]).toHaveTextContent('999.00');
    expect(rows[9]).toHaveTextContent('0x000a…000a');
  });

  it('breaks each total into missions, time, streak and liquidity, rounded to whole points', () => {
    board.entries = [
      entry(1, { missions: '600.000000', time: '10.554807', streak: '40.833000', lp: '1.441586', total: '652.829393' }),
    ];
    render(<Leaderboard />);
    const row = screen.getByTestId('leaderboard-row');
    expect(within(row).getByTestId('lb-missions')).toHaveTextContent('600');
    expect(within(row).getByTestId('lb-time')).toHaveTextContent('11');
    expect(within(row).getByTestId('lb-streak')).toHaveTextContent('41');
    expect(within(row).getByTestId('lb-lp')).toHaveTextContent('1');
    expect(within(row).getByTestId('lb-total')).toHaveTextContent('652.83');
  });

  it('expands to every ranked wallet and folds back to the top ten', () => {
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 100' }));
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(100);

    fireEvent.click(screen.getByRole('button', { name: 'Show top 10' }));
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
  });

  it('offers no expand button when ten or fewer wallets are ranked', () => {
    board.entries = many(10);
    render(<Leaderboard />);
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks the connected wallet in the top ten, whatever the address casing', () => {
    render(<Leaderboard me={addr(3).toUpperCase().replace('0X', '0x') as `0x${string}`} />);
    const rows = screen.getAllByTestId('leaderboard-row');
    expect(rows[2]).toHaveAttribute('data-me', 'true');
    expect(rows[2]).toHaveTextContent('You');
    expect(rows.filter((r) => r.getAttribute('data-me') === 'true')).toHaveLength(1);
    expect(screen.queryByTestId('leaderboard-me')).not.toBeInTheDocument();
  });

  it('pins the connected wallet under the top ten when it ranks lower', () => {
    render(<Leaderboard me={addr(37) as `0x${string}`} />);
    const mine = screen.getByTestId('leaderboard-me');
    expect(mine).toHaveTextContent('37');
    expect(mine).toHaveTextContent('You');
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
  });

  it('does not repeat the pinned row once the list is expanded', () => {
    render(<Leaderboard me={addr(37) as `0x${string}`} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 100' }));
    expect(screen.queryByTestId('leaderboard-me')).not.toBeInTheDocument();
    const mine = screen.getAllByTestId('leaderboard-row').filter((r) => r.getAttribute('data-me') === 'true');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toHaveTextContent('37');
  });

  it('marks no row for a wallet outside the top 100, or with no wallet connected', () => {
    const { rerender } = render(<Leaderboard me={addr(500) as `0x${string}`} />);
    const marked = () => screen.getAllByTestId('leaderboard-row').filter((r) => r.getAttribute('data-me') === 'true');
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
    expect(marked()).toHaveLength(0);
    expect(screen.queryByText('You')).not.toBeInTheDocument();
    expect(screen.queryByTestId('leaderboard-me')).not.toBeInTheDocument();

    rerender(<Leaderboard />);
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
    expect(marked()).toHaveLength(0);
  });

  it('says it is loading before the first answer', () => {
    board.entries = null;
    board.loading = true;
    render(<Leaderboard />);
    expect(screen.getByTestId('leaderboard')).toHaveTextContent('Reading the leaderboard');
    expect(screen.queryByTestId('leaderboard-row')).not.toBeInTheDocument();
  });

  it('says the leaderboard is unavailable when the API fails, rather than showing an empty board', () => {
    board.entries = null;
    board.error = new Error('GET /points/leaderboard -> 502');
    render(<Leaderboard />);
    expect(screen.getByTestId('leaderboard')).toHaveTextContent('Could not load the leaderboard');
    expect(screen.getByTestId('leaderboard')).not.toHaveTextContent('No points');
  });

  it('keeps the last good board on screen when a later poll fails', () => {
    board.error = new Error('GET /points/leaderboard -> 502');
    render(<Leaderboard />);
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(10);
    expect(screen.getByTestId('leaderboard')).not.toHaveTextContent('Could not load the leaderboard');
  });

  it('invites the first trade when nobody has points yet', () => {
    board.entries = [];
    render(<Leaderboard />);
    expect(screen.getByTestId('leaderboard')).toHaveTextContent('No points earned yet this season');
    expect(screen.queryByTestId('leaderboard-row')).not.toBeInTheDocument();
  });
});
