import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FillsList } from '@/components/FillsList';

// Rows exactly as services/api's GET /positions/:address/history sends them
// (routes/positions.ts): the PnL field is `realizedPnl`, and every close carries a unique
// `closeOrderId` — a trade closed in parts appears once per part with the same tradeId.
let historyState: Record<string, unknown>[] = [];

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000aa' }),
}));
vi.mock('@/hooks/usePositionHistory', () => ({
  usePositionHistory: () => ({ history: historyState, loading: false, error: null }),
}));
vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [
      { pairIndex: 0, from: 'BTC', to: 'USD' },
      { pairIndex: 1, from: 'ETH', to: 'USD' },
    ],
  }),
}));

function row(overrides: Record<string, unknown>) {
  return {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '100.000000',
    leverage: '10.00',
    openPrice: '80000.000000000000000000',
    closePrice: '81000.000000000000000000',
    tp: '0.000000000000000000',
    sl: '0.000000000000000000',
    tradeId: '7',
    openedAt: 1_790_000_000,
    closedAt: 1_790_003_600,
    closeReason: 'MARKET',
    percentProfit: '12.500000',
    usdcSentToTrader: '112.500000',
    realizedPnl: '12.500000',
    closeOrderId: '41',
    closeTxHash: '0xabc',
    percentageClosed: '100.00',
    isPartial: false,
    ...overrides,
  };
}

beforeEach(() => {
  historyState = [];
});

describe('<FillsList>', () => {
  it("reads the API's realizedPnl field instead of crashing on a name it does not send", () => {
    historyState = [row({})];
    render(<FillsList />);
    const table = screen.getByTestId('fills-table');
    expect(table).toHaveTextContent('+12.50');
  });

  it('names the market of every close', () => {
    historyState = [row({ closeOrderId: '41' }), row({ pairIndex: 1, closeOrderId: '42', buy: false, realizedPnl: '-3.000000' })];
    render(<FillsList />);
    expect(screen.getByTestId('fill-row-41')).toHaveTextContent('BTC-PERP');
    expect(screen.getByTestId('fill-row-42')).toHaveTextContent('ETH-PERP');
    expect(screen.getByTestId('fill-row-42')).toHaveTextContent('Short');
  });

  it('colours a loss as a loss', () => {
    historyState = [row({ realizedPnl: '-3.000000', closeOrderId: '43' })];
    render(<FillsList />);
    const pnl = screen.getByTestId('fill-pnl-43');
    expect(pnl).toHaveTextContent('-3.00');
    expect(pnl).toHaveClass('neg');
  });

  it('keys each partial close separately, so two parts of one trade are two rows', () => {
    historyState = [
      row({ closeOrderId: '50', isPartial: true, percentageClosed: '50.00' }),
      row({ closeOrderId: '51', isPartial: false }),
    ];
    render(<FillsList />);
    expect(screen.getByTestId('fill-row-50')).toBeInTheDocument();
    expect(screen.getByTestId('fill-row-51')).toBeInTheDocument();
  });

  it('offers a share button on a close it can make a card for', () => {
    historyState = [row({ closeOrderId: '41' })];
    render(<FillsList />);
    expect(screen.getByTestId('fill-share-41')).toHaveAttribute('aria-label', 'Share this BTC-PERP trade');
  });

  it('offers no share button on a close missing its PnL', () => {
    historyState = [row({ closeOrderId: '44', realizedPnl: undefined, usdcSentToTrader: undefined })];
    render(<FillsList />);
    expect(screen.queryByTestId('fill-share-44')).not.toBeInTheDocument();
  });
});
