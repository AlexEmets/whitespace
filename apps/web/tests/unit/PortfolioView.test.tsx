import { render, screen } from '@testing-library/react';
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
    expect(screen.getByTestId('tile-account-value')).toHaveTextContent('1,450.00');
    expect(screen.getByTestId('def-total')).toHaveTextContent('1,450.00 USDW');
  });

  it('breaks the total down into rows that reconcile against it', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    expect(screen.getByTestId('def-wallet')).toHaveTextContent('1,000.00');
    expect(screen.getByTestId('def-margin')).toHaveTextContent('100.00');
    expect(screen.getByTestId('def-unrealised')).toHaveTextContent('+100.00');
    expect(screen.getByTestId('def-lp')).toHaveTextContent('250.00');
  });

  it('shows realised PnL from the closed-trade payout, signed', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    expect(screen.getByTestId('tile-realised')).toHaveTextContent('-0.31');
    expect(screen.getByTestId('history-pnl')).toHaveTextContent('-0.31');
  });

  it('renders the open position with its live mark and unrealised PnL', () => {
    hasPrice.value = true;
    render(<PortfolioView />);
    const row = screen.getByTestId('portfolio-position-0-0');
    expect(row).toHaveTextContent('BTC-USD');
    expect(row).toHaveTextContent('110.00');
    expect(screen.getByTestId('portfolio-position-pnl')).toHaveTextContent('+100.00');
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
   * where they belong — and it is now the only place in the chrome that offers them.
   */
  it('offers deposit and withdraw beside the balances they move', () => {
    render(<PortfolioView />);

    expect(screen.getByTestId('portfolio-funding')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-deposit-button')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-withdraw-button')).toBeInTheDocument();
  });

  /** "Request deposit" was once read as "request USDW" and submitted from an empty
   * wallet. The section has to say which way each control moves money, and point at the
   * faucet for the direction neither of them covers. */
  it('names the direction of each control and sends minting to the faucet', () => {
    render(<PortfolioView />);
    const funding = screen.getByTestId('portfolio-funding');

    expect(funding).toHaveTextContent(/deposit.*from your wallet into the LP vault/i);
    expect(funding).toHaveTextContent(/withdraw.*redeems those shares back into USDW/i);
    expect(funding.querySelector('a[href="/faucet"]')).not.toBeNull();
  });

  it('refuses to print an account total when a mark price is missing', () => {
    hasPrice.value = false;
    render(<PortfolioView />);
    // Not "1,350.00" — a sum that silently drops unrealised PnL is a different number
    // wearing the same label.
    expect(screen.getByTestId('tile-account-value')).not.toHaveTextContent('1,3');
    expect(screen.getByTestId('tile-account-value')).toHaveTextContent('—');
    expect(screen.getByTestId('tile-unrealised')).toHaveTextContent('—');
    hasPrice.value = true;
  });
});
