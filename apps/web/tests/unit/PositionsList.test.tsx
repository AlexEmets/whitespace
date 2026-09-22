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
  // Human decimals, exactly as /positions/:address emits them (services/api format.ts).
  collateral: '1000.000000', // 1,000.00 USDW
  leverage: '10.00', // 10.00x
  openPrice: '100.000000000000000000', // 100.00
  tp: '0',
  sl: '0',
  openedAt: 0,
  tradeId: '7',
};

/** Raw PRECISION_18 liquidation price the mocked contract read returns: 90,909.09…, i.e.
 * roughly a 10% adverse move on a 10x long opened at 100.00 in these fixtures. The exact
 * figure is the contract's to decide — this suite only asserts the component renders what
 * the chain returned rather than computing anything itself. */
const LIQ_PRICE_RAW = 90909090909090909090n;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  // PositionsList reads the liquidation price straight off OstiumPairInfos via
  // useLiquidationPrice. Mocked at the wagmi boundary rather than at the hook, so the
  // hook's own arg-gating (it must not fire with a zero price/collateral/leverage) still
  // runs under test.
  useReadContract: () => ({ data: LIQ_PRICE_RAW, isLoading: false }),
}));

vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: [openPosition], error: null, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    // maxLeverage is PRECISION_2 on-chain but reaches us as /markets' human decimal:
    // "100.00" is 100x, not the raw 10000.
    markets: [{ pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x0', maxLeverage: '100.00', maxOpenInterest: '0.000000', openInterest: { long: '0.000000', short: '0.000000' } }],
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/usePrice', () => ({
  // Mark price +10% vs the 100.00 open price above.
  usePrice: () => ({
    data: { mark: '110.000000000000000000', index: '110.000000000000000000', degraded: false, healthyVenues: 4, updatedAt: 0 },
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
  it('shows the liquidation price the contract returned, not a dash and not its own arithmetic', () => {
    render(<PositionsList />);
    // 90909090909090909090n at 18 decimals. Previously this cell was hardcoded to an
    // em-dash with "requires on-chain state this app does not read" — the state was always
    // readable; the app simply was not reading it.
    expect(screen.getByTestId('liq-price')).toHaveTextContent('90.91');
  });

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

  /**
   * The row now ends in a single `Close` (terminal_design.pdf), so the default action must
   * be a FULL close — a button labelled Close that silently exited 25% of a leveraged
   * position would be the worst possible default.
   */
  it('closes the whole position from the row button', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 10000 }); // FULL_CLOSE_PERCENT
  });

  /** Partial closing moved behind the chevron rather than being removed: the contract
   * takes a percentage and dropping the capability to match a picture would lose real
   * function. It must stay hidden until asked for, and then submit the exact percentage. */
  it('keeps partial closing available behind the chevron', async () => {
    render(<PositionsList />);
    expect(screen.queryByTestId('close-partial-row')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('close-partial-toggle'));
    fireEvent.click(screen.getByTestId('close-partial-25'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 2500 });
  });
});
