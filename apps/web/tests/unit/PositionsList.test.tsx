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
/** Accrued funding 1.50 and rollover 0.25 USDW owed by the trader (contract sign). */
const FUNDING_OWED = 1_500_000n;
const ROLLOVER_OWED = 250_000n;
/** The pair's minimum collateral × leverage (PRECISION_6); tests raise it to hit the floor. */
const minLevPos = vi.hoisted(() => ({ value: 1_500_000000n }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  // PositionsList reads the liquidation price straight off OstiumPairInfos via
  // useLiquidationPrice. Mocked at the wagmi boundary rather than at the hook, so the
  // hook's own arg-gating (it must not fire with a zero price/collateral/leverage) still
  // runs under test.
  useReadContract: ({ functionName }: { functionName: string }) => {
    if (functionName === 'getTradeFundingFee') return { data: [FUNDING_OWED, 0n], isLoading: false };
    if (functionName === 'getTradeRolloverFee') return { data: ROLLOVER_OWED, isLoading: false };
    if (functionName === 'openTradesInfo') return { data: [7n, 0n, 1000, 0, 0, 0, false], isLoading: false };
    if (functionName === 'maxSl_P') return { data: 75, isLoading: false };
    if (functionName === 'pairMinLevPos') return { data: minLevPos.value, isLoading: false };
    return { data: LIQ_PRICE_RAW, isLoading: false };
  },
}));

const actions = {
  pending: null,
  updateTp: vi.fn(async () => ({})),
  updateSl: vi.fn(async () => ({})),
  topUpCollateral: vi.fn(async () => ({})),
  removeCollateral: vi.fn(async () => ({})),
  updateLimitOrder: vi.fn(async () => ({})),
  cancelLimitOrder: vi.fn(async () => ({})),
  reclaimTimedOutClose: vi.fn(async () => ({})),
};
vi.mock('@/hooks/useTradingActions', () => ({ useTradingActions: () => actions }));

let allowance = 10_000_000_000n;
const approveMock = vi.fn(async () => {});
vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: 5_000_000_000n,
    allowance,
    approve: approveMock,
    refetchAllowance: vi.fn(async () => {}),
  }),
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
  Object.values(actions).forEach((f) => typeof f === 'function' && (f as ReturnType<typeof vi.fn>).mockClear());
  approveMock.mockClear();
  allowance = 10_000_000_000n;
});

describe('<PositionsList>', () => {
  it('shows the liquidation price the contract returned, not a dash and not its own arithmetic', () => {
    render(<PositionsList />);
    // 90909090909090909090n at 18 decimals. Previously this cell was hardcoded to an
    // em-dash with "requires on-chain state this app does not read" — the state was always
    // readable; the app simply was not reading it.
    expect(screen.getByTestId('liq-price')).toHaveTextContent('90.91');
  });

  it('lays out the columns like the reference terminal', () => {
    render(<PositionsList />);
    const headers = Array.from(screen.getByTestId('positions-table').querySelectorAll('th')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual([
      'Instrument', 'Quantity', 'Mark', 'Value', 'Entry', 'Liq. price', 'Margin (usage)', 'Funding', 'UPnL', 'TP / SL', '',
    ]);
  });

  it('values the position at the mark: 100 base units x 110 = 11,000 USDW', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('position-value')).toHaveTextContent('11,000.00');
  });

  it('shows margin with its usage toward liquidation — zero while in profit', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('position-margin')).toHaveTextContent('1,000.00 (0.00%)');
  });

  it('shows accrued funding plus rollover as a cost, negative and red', () => {
    render(<PositionsList />);
    const cell = screen.getByTestId('position-funding');
    expect(cell).toHaveTextContent('-1.75');
    expect(cell).toHaveClass('neg');
  });

  it('shows a dash for absent TP and SL', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('position-tpsl')).toHaveTextContent('— / —');
  });

  // ---------------------------------------------------------------------------------------
  // Managing the position
  // ---------------------------------------------------------------------------------------

  it('sets a take profit within the +900% cap', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-tp-input'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('manage-tp-save'));
    await waitFor(() => expect(actions.updateTp).toHaveBeenCalledWith(0, 0, 150n * 10n ** 18n));
    expect(await screen.findByTestId('manage-message')).toHaveTextContent('Take profit updated.');
  });

  it('refuses a take profit past the cap for this leverage', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    // 10x: cap is 100 + 90 = 190
    fireEvent.change(screen.getByTestId('manage-tp-input'), { target: { value: '191' } });
    expect(screen.getByTestId('manage-tp-error')).toHaveTextContent(/900%/);
    expect(screen.getByTestId('manage-tp-save')).toBeDisabled();
  });

  it('sets a stop loss inside the loss limit and refuses one beyond it', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    // maxSl_P 75 at 10x: the stop may sit at most 7.5 below 100
    fireEvent.change(screen.getByTestId('manage-sl-input'), { target: { value: '92' } });
    expect(screen.getByTestId('manage-sl-error')).toHaveTextContent(/75%/);
    fireEvent.change(screen.getByTestId('manage-sl-input'), { target: { value: '95' } });
    fireEvent.click(screen.getByTestId('manage-sl-save'));
    await waitFor(() => expect(actions.updateSl).toHaveBeenCalledWith(0, 0, 95n * 10n ** 18n));
  });

  it('an empty stop loss removes it', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    expect(screen.getByTestId('manage-sl-save')).toHaveTextContent('Remove SL');
    fireEvent.click(screen.getByTestId('manage-sl-save'));
    await waitFor(() => expect(actions.updateSl).toHaveBeenCalledWith(0, 0, 0n));
  });

  it('adds margin, approving first only when the allowance is short', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('manage-margin-add'));
    await waitFor(() => expect(actions.topUpCollateral).toHaveBeenCalledWith(0, 0, 250_000_000n));
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('approves before adding margin when there is no allowance', async () => {
    allowance = 0n;
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('manage-margin-add'));
    await waitFor(() => expect(actions.topUpCollateral).toHaveBeenCalled());
    expect(approveMock.mock.invocationCallOrder[0]!).toBeLessThan(actions.topUpCollateral.mock.invocationCallOrder[0]!);
  });

  it('refuses to add more margin than the wallet holds', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '5000.01' } });
    expect(screen.getByTestId('manage-margin-add')).toBeDisabled();
  });

  it('requests a margin removal, and refuses to remove all of it', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '1000' } });
    expect(screen.getByTestId('manage-margin-remove')).toBeDisabled();
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('manage-margin-remove'));
    await waitFor(() => expect(actions.removeCollateral).toHaveBeenCalledWith(0, 0, 100_000_000n));
    expect(await screen.findByTestId('manage-message')).toHaveTextContent(/keeper report/);
  });

  /**
   * A liquidation price is a LEVEL, not a loss. Painting it red made four healthy
   * positions read as four margin calls, and it competed with UPnL — the cell whose colour
   * actually means something. Same for Close: exiting is the ordinary thing to do.
   */
  it('keeps the liquidation price and the close button neutral, not red', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('liq-price')).not.toHaveClass('neg');
    expect(screen.getByTestId('unrealized-pnl')).toHaveClass('pos'); // colour still used where it means something
  });

  it('shows the exact estimated unrealised PnL for a 10x long, +10% price move', () => {
    render(<PositionsList />);
    // notional = 1,000 * 10x = 10,000; +10% price move * 10x leverage = +100% of
    // collateral = +1,000.00 USDW.
    expect(screen.getByTestId('unrealized-pnl')).toHaveTextContent('+1,000.00');
  });

  /**
   * Close opens a confirmation rather than acting: leaving a leveraged position deserves one
   * look before the wallet opens, and the dialog is where the size is chosen.
   */
  it('asks before closing: the row button opens the close dialog and signs nothing', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));

    expect(screen.getByTestId('close-dialog')).toBeInTheDocument();
    expect(closeTradeMock).not.toHaveBeenCalled();
  });

  it('starts at a full close and confirms it against the live mark', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    // 1,000 collateral x 10x at 100.00 = 100 BTC; the whole of it.
    expect(screen.getByTestId('close-amount-input')).toHaveValue('100');
    expect(screen.getByTestId('close-share')).toHaveTextContent('100%');
    expect(screen.getByTestId('close-preview-remaining')).toHaveTextContent('None');
    fireEvent.click(screen.getByTestId('close-confirm'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock).toHaveBeenCalledWith({
      pairIndex: 0,
      index: 0,
      closePercentage: 10000,
      marketPriceRaw: 110000000000000000000n,
      slippageBps: 50n,
    });
    expect(await screen.findByTestId('close-pending')).toHaveTextContent(/pending keeper execution/i);
    expect(screen.queryByTestId('close-dialog')).not.toBeInTheDocument();
  });

  it('closes the quick size picked in the dialog', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-quick-25'));
    expect(screen.getByTestId('close-amount-input')).toHaveValue('25');
    expect(screen.getByTestId('close-confirm')).toHaveTextContent('Close 25%');
    fireEvent.click(screen.getByTestId('close-confirm'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 2500 });
  });

  it('closes a typed amount as its share of the position', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.change(screen.getByTestId('close-amount-input'), { target: { value: '40' } });
    expect(screen.getByTestId('close-share')).toHaveTextContent('40%');
    expect(screen.getByTestId('close-preview-remaining')).toHaveTextContent('60 BTC');
    // +1,000.00 unrealised, 40% of it.
    expect(screen.getByTestId('close-preview-pnl')).toHaveTextContent('+400.00 USDW');
    fireEvent.click(screen.getByTestId('close-confirm'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 4000 });
  });

  it('closes the share set on the slider', async () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.change(screen.getByTestId('close-share-slider'), { target: { value: '30' } });
    expect(screen.getByTestId('close-amount-input')).toHaveValue('30');
    fireEvent.click(screen.getByTestId('close-confirm'));

    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]?.[0]).toMatchObject({ closePercentage: 3000 });
  });

  it('cannot confirm with no amount', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.change(screen.getByTestId('close-amount-input'), { target: { value: '' } });
    expect(screen.getByTestId('close-confirm')).toBeDisabled();
  });

  /** BelowMinLevPos, caught before the wallet opens: the dialog does the contract's own
   * arithmetic and says how far the trader can go instead. */
  it('refuses a partial close that would leave less than the market minimum, and says how much is allowed', () => {
    // 6,000 USDW minimum on a 10,000 USDW position: at most 40% can go.
    minLevPos.value = 6_000_000000n;
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-quick-50'));

    expect(screen.getByTestId('close-too-little')).toHaveTextContent(/minimum position of 6,000.00 USDW.*up to 40%, or all of it/);
    expect(screen.getByTestId('close-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('close-quick-100'));
    expect(screen.queryByTestId('close-too-little')).not.toBeInTheDocument();
    expect(screen.getByTestId('close-confirm')).toBeEnabled();
    minLevPos.value = 1_500_000000n;
  });

  it('keeps the dialog open with the reason when the close fails', async () => {
    closeTradeMock.mockRejectedValueOnce(new Error('The close could not be simulated.'));
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-confirm'));

    expect(await screen.findByTestId('close-error')).toHaveTextContent('The close could not be simulated.');
    expect(screen.getByTestId('close-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('close-pending')).not.toBeInTheDocument();
  });

  it('closes nothing on Cancel', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-cancel'));
    expect(screen.queryByTestId('close-dialog')).not.toBeInTheDocument();
    expect(closeTradeMock).not.toHaveBeenCalled();
  });

  it('offers a share button on an open position once it has a mark', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('position-share-0-0')).toHaveAttribute('aria-label', 'Share this BTC-PERP trade');
  });
});
