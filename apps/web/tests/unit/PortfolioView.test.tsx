import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortfolioView, sumAccountValue, totalUnrealisedPnl } from '@/components/portfolio/PortfolioView';
import type { ClosedPositionSummary, PositionSummary, PriceResponse } from '@/lib/types';

/**
 * The headless browser used to drive these pages has no wallet, so it can only ever show
 * the disconnected state. This file is where the connected path is actually exercised:
 * every hook is mocked with the exact shapes the live API and the live contracts return,
 * and the assertions are on the arithmetic the trader reads off the screen.
 */

const openPosition: PositionSummary = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '100.000000', // 100.00 USDW
  leverage: '10.00', // 10.00x -> 1,000.00 notional
  openPrice: '100.000000000000000000',
  tp: '0',
  sl: '0',
  openedAt: 1788881000,
  tradeId: '4',
};

const closedTrade = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '999.000000',
  leverage: '10.00',
  openPrice: '65001.000000000000000000',
  closePrice: '64999.000000000000000000',
  tp: '0',
  sl: '0',
  tradeId: '2',
  openedAt: 1788881084,
  closedAt: 1788881094,
  closeReason: 'close',
  percentProfit: '-0.000000000000030768',
  usdcSentToTrader: '998.692628',
  realizedPnl: '-0.307372',
} as unknown as ClosedPositionSummary;

const markPrice: PriceResponse = {
  index: '110.000000000000000000',
  mark: '110.000000000000000000', // +10% vs the 100.00 open price
  bid: '109.990000000000000000',
  ask: '110.010000000000000000',
  updatedAt: 0,
  // Venue NAMES, not a count — that is what /price/:pairIndex actually sends.
  healthyVenues: ['binance', 'bybit', 'okx', 'whitebit'],
  minHealthyVenues: 3,
  degraded: false,
  source: 'publisher',
};

const hasPrice = vi.hoisted(() => ({ value: true }));

/**
 * The write-side hooks are here because the page now renders the Funding section, and
 * `FundingButtons` mounts a (closed) `FundingModal` whose `useErc20`/`useVault` hooks run
 * on every render regardless.
 *
 * Mocked at the wagmi boundary rather than by stubbing out `FundingButtons`, so the real
 * component stays in the tree and the "deposit and withdraw are reachable from here"
 * assertion below is about the actual buttons, not a test double of them.
 */
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x2b8ba090DEdF879f8045c0dDA5a78762cED90D19' as const, isConnected: true }),
  useReadContract: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  usePublicClient: () => undefined,
  useWriteContract: () => ({ writeContractAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: [openPosition], error: null, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], error: null, loading: false, refetch: vi.fn() }),
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

vi.mock('@/hooks/useMarkPrices', () => ({
  useMarkPrices: () => ({ prices: hasPrice.value ? { 0: markPrice } : {}, loading: false, error: null }),
}));

// The vault position and the wallet balance are raw on-chain bigints (6 decimals), which
// is exactly what usePortfolioBalances promises its callers.
vi.mock('@/hooks/usePortfolioBalances', () => ({
  usePortfolioBalances: () => ({
    walletRaw: 1_000_000000n, // 1,000.00 USDW
    vaultSharesRaw: 250_000000n,
    vaultAssetsRaw: 250_000000n, // 250.00 USDW
    vaultTotalAssetsRaw: 100_000_000000n,
    loading: false,
    error: null,
  }),
}));

// Mocked one level below useTradeStats so the real normalisation and aggregation run.
vi.mock('@/hooks/usePositionHistory', () => ({
  usePositionHistory: () => ({ history: [closedTrade], loading: false, error: null }),
}));

describe('portfolio arithmetic', () => {
  it('returns null unrealised PnL if any open market has no live price', () => {
    expect(totalUnrealisedPnl([openPosition], {})).toBeNull();
  });

  it('sums unrealised PnL across positions when every market is priced', () => {
    // 100 collateral x 10x = 1,000 notional; +10% move = +100.00 USDW.
    expect(totalUnrealisedPnl([openPosition], { 0: markPrice })).toBe(100_000000n);
  });

  it('propagates a missing component instead of treating it as zero', () => {
    expect(sumAccountValue([1n, null, 3n])).toBeNull();
    expect(sumAccountValue([1_000000n, 2_000000n])).toBe(3_000000n);
  });
});

describe('<PortfolioView> connected', () => {
  it('shows account value as the sum of its four parts', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    // 1,000.00 wallet + 100.00 margin + 100.00 unrealised + 250.00 LP = 1,450.00
    expect(screen.getByTestId('account-value')).toHaveTextContent('1,450.00');
  });

  it('prints each part beside the bar, so the total reconciles against them', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    expect(screen.getByTestId('part-wallet')).toHaveTextContent('1,000.00');
    expect(screen.getByTestId('part-margin')).toHaveTextContent('100.00');
    expect(screen.getByTestId('part-margin')).toHaveTextContent('1 open · 1,000.00 notional');
    expect(screen.getByTestId('part-unrealised')).toHaveTextContent('+100.00');
    expect(screen.getByTestId('part-lp')).toHaveTextContent('250.00');
  });

  it('splits the bar by the same parts, in proportion', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    const bar = screen.getByTestId('account-bar');
    // 1,000 / 1,450 = 69.0%, 100 / 1,450 = 6.9%, 250 / 1,450 = 17.2%
    expect(bar).toHaveAttribute(
      'aria-label',
      'Wallet 69.0%, Margin in positions 6.9%, Unrealised PnL 6.9%, LP vault 17.2%',
    );
    expect(bar.querySelectorAll('[data-part]')).toHaveLength(4);
  });

  it('shows how the closed trades went: realised PnL, win rate, volume and holding time', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    expect(screen.getByTestId('perf-realised')).toHaveTextContent('-0.31');
    expect(screen.getByTestId('perf-realised')).toHaveTextContent('1 close');
    expect(screen.getByTestId('perf-winrate')).toHaveTextContent('0%');
    expect(screen.getByTestId('perf-winrate')).toHaveTextContent('0 wins · 1 losses');
    // 999 collateral x 10x
    expect(screen.getByTestId('perf-volume')).toHaveTextContent('9,990.00');
    expect(screen.getByTestId('perf-hold')).toHaveTextContent('10s');
    expect(screen.getByTestId('perf-hold')).toHaveTextContent('best -0.31 · worst -0.31');
    expect(screen.getByTestId('pnl-sparkline')).toHaveAttribute('aria-label', 'Realised PnL over 1 closes, ending at -0.31 USDW');
  });

  it('opens on the positions tab, with the live mark and unrealised PnL', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    expect(screen.getByTestId('portfolio-tab-positions')).toHaveAttribute('aria-selected', 'true');
    const row = screen.getByTestId('portfolio-position-0-0');
    // `-PERP`, not `-USD`: terminal_design.pdf names markets by instrument, and
    // lib/markets.ts is now the single place that decides it.
    expect(row).toHaveTextContent('BTC-PERP');
    expect(row).toHaveTextContent('110.00');
    expect(screen.getByTestId('portfolio-position-pnl')).toHaveTextContent('+100.00');
  });

  it('counts each tab so there is a reason to open one', () => {
    render(<PortfolioView />);
    expect(screen.getByTestId('portfolio-tab-positions')).toHaveTextContent('Positions1');
    expect(screen.getByTestId('portfolio-tab-orders')).toHaveTextContent('Orders0');
    expect(screen.getByTestId('portfolio-tab-history')).toHaveTextContent('History1');
  });

  it('switches to the trade history', () => {
    render(<PortfolioView />);
    fireEvent.click(screen.getByTestId('portfolio-tab-history'));
    expect(screen.getByTestId('portfolio-tab-history')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('portfolio-tab-positions')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('history-pnl')).toHaveTextContent('-0.31');
    expect(screen.queryByTestId('portfolio-position-0-0')).not.toBeInTheDocument();
  });

  it('says so when there are no orders in flight', () => {
    render(<PortfolioView />);
    fireEvent.click(screen.getByTestId('portfolio-tab-orders'));
    expect(screen.getByTestId('account-state-empty')).toHaveTextContent('No orders in flight');
  });

  it('moves between tabs with the arrow keys, wrapping at the ends', () => {
    render(<PortfolioView />);
    const positions = screen.getByTestId('portfolio-tab-positions');
    fireEvent.keyDown(positions, { key: 'ArrowRight' });
    expect(screen.getByTestId('portfolio-tab-orders')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('portfolio-tab-orders')).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId('portfolio-tab-orders'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('portfolio-tab-positions'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('portfolio-tab-vault')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the tab panel labelled by the tab that is showing', () => {
    render(<PortfolioView />);
    fireEvent.click(screen.getByTestId('portfolio-tab-history'));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'portfolio-tab-history');
  });

  it('keeps the liquidation price an explained dash rather than an approximation', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    const dashes = screen.getAllByTestId('honest-dash');
    expect(dashes.length).toBeGreaterThan(0);
    expect(dashes.some((d) => (d.getAttribute('title') ?? '').includes('funding/rollover'))).toBe(true);
  });

  /**
   * Deposit and withdraw moved here from the header (owner decision 2026-09-21). The
   * portfolio is the page that already reports the two balances they move, so this is
   * where they belong — now on the LP vault tab, one click from the vault figure.
   */
  it('offers deposit and withdraw beside the balances they move', () => {
    render(<PortfolioView />);
    fireEvent.click(screen.getByTestId('portfolio-tab-vault'));

    const funding = screen.getByTestId('portfolio-funding');
    expect(funding).toBeInTheDocument();
    expect(screen.getByTestId('funding-free')).toHaveTextContent('1,000.00 USDW');
    expect(screen.getByTestId('funding-vault')).toHaveTextContent('250.00 USDW');
    expect(screen.getByTestId('portfolio-deposit-button')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-withdraw-button')).toBeInTheDocument();
  });

  it('opens the vault tab from the LP vault figure', () => {
    render(<PortfolioView />);
    expect(screen.queryByTestId('portfolio-funding')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('part-lp-manage'));
    expect(screen.getByTestId('portfolio-tab-vault')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('portfolio-funding')).toBeInTheDocument();
  });

  /** "Request deposit" was once read as "request USDW" and submitted from an empty
   * wallet. The section has to say which way each control moves money, and point at the
   * faucet for the direction neither of them covers. */
  it('names the direction of each control and sends minting to the faucet', () => {
    render(<PortfolioView />);
    fireEvent.click(screen.getByTestId('portfolio-tab-vault'));
    const funding = screen.getByTestId('portfolio-funding');

    expect(funding).toHaveTextContent(/deposit.*from your wallet into the LP vault/i);
    expect(funding).toHaveTextContent(/withdraw.*redeems those shares back into USDW/i);
    expect(funding.querySelector('a[href="/faucet"]')).not.toBeNull();
  });

  it('refuses to print an account total or a split when a mark price is missing', () => {
    hasPrice.value = false;
    render(<PortfolioView />);
    // Not "1,350.00" — a sum that silently drops unrealised PnL is a different number
    // wearing the same label.
    expect(screen.getByTestId('account-value')).not.toHaveTextContent('1,3');
    expect(screen.getByTestId('account-value')).toHaveTextContent('—');
    expect(screen.getByTestId('part-unrealised')).toHaveTextContent('—');
    expect(screen.getByTestId('account-bar')).toHaveAttribute(
      'aria-label',
      'Split unavailable: a part of the account could not be read',
    );
    expect(screen.getByTestId('account-bar').querySelectorAll('[data-part]')).toHaveLength(0);
    hasPrice.value = true;
  });
});
