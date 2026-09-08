import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionsList } from '@/components/PositionsList';
import type { CloseTradeParams } from '@/hooks/useCloseTrade';
import type { PositionSummary } from '@/lib/types';

const closeTradeMock = vi.fn(async (_params: CloseTradeParams) => ({ hash: '0xclose' as const, receipt: {} }));

const openPosition: PositionSummary = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '1000000000', // 1,000.00 USDW
  leverage: '1000', // 10.00x
  openPrice: '100000000000000000000', // 100.00
  tp: '0',
  sl: '0',
  openedAt: 0,
  tradeId: '7',
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: [openPosition], error: null, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [{ pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x0', maxLeverage: '10000', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } }],
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/usePrice', () => ({
  // Mark price +10% vs the 100.00 open price above.
  usePrice: () => ({
    data: { mark: '110000000000000000000', index: '110000000000000000000', degraded: false, healthyVenues: 4, updatedAt: 0 },
    error: null,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCloseTrade', () => ({
  useCloseTrade: () => ({ closeTrade: closeTradeMock, isPending: false }),
  FULL_CLOSE_PERCENT: 10000,
}));

beforeEach(() => {
  closeTradeMock.mockClear();
});

describe('<PositionsList>', () => {
  it('shows the exact estimated unrealised PnL for a 10x long, +10% price move', () => {
    render(<PositionsList />);
    // notional = 1,000 * 10x = 10,000; +10% price move * 10x leverage = +100% of
    // collateral = +1,000.00 USDW.
    expect(screen.getByTestId('unrealized-pnl')).toHaveTextContent('+1,000.00');
  });

  it('closes the full position by default and calls closeTradeMarket with the live mark price', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock).toHaveBeenCalledWith({
      pairIndex: 0,
      index: 0,
      closePercentage: 10000,
      marketPriceRaw: 110000000000000000000n,
      slippageBps: 50n,
    });
    expect(await screen.findByTestId('close-pending')).toHaveTextContent(/pending keeper execution/i);
  });

  it('supports a partial close percentage', async () => {
    render(<PositionsList />);
    fireEvent.change(screen.getByTestId('close-percent-input'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('close-position-button'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 2500 });
  });
});
