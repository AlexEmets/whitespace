import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionsList } from '@/components/PositionsList';
import type { CloseTradeParams } from '@/hooks/useCloseTrade';
import type { PositionSummary } from '@/lib/types';

const closeTradeMock = vi.fn(async (_params: CloseTradeParams) => ({
  hash: '0xclose' as const,
  receipt: {},
  orderId: 77n as bigint | undefined,
}));
let ordersMock: Record<string, unknown>[] = [];

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

/** Per-trade liquidation levels a stacked position's batched reads return, by trade index. */
let legLiqRaw: Record<number, bigint> = {};
const PER_TRADE_READS = new Set(['getTradeLiquidationPrice', 'getTradeFundingFee', 'getTradeRolloverFee']);

vi.mock('wagmi', () => ({
  // A stacked position reads every trade's liquidation level and fees in one batch; anything
  // else batched here (pending order ids) has nothing to report in these tests.
  useReadContracts: ({ contracts }: { contracts?: { functionName: string; args?: readonly unknown[] }[] }) => {
    if (!contracts?.length || !contracts.every((c) => PER_TRADE_READS.has(c.functionName))) return { data: [] };
    return {
      data: contracts.map((c) => ({
        status: 'success',
        result:
          c.functionName === 'getTradeFundingFee'
            ? [FUNDING_OWED, 0n]
            : c.functionName === 'getTradeRolloverFee'
              ? ROLLOVER_OWED
              : (legLiqRaw[c.args![2] as number] ?? LIQ_PRICE_RAW),
      })),
    };
  },
  useBlockNumber: () => ({ data: 1n }),
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  // PositionsList reads the liquidation price straight off WhitespacePairInfos via
  // useLiquidationPrice. Mocked at the wagmi boundary rather than at the hook, so the
  // hook's own arg-gating (it must not fire with a zero price/collateral/leverage) still
  // runs under test.
  useReadContract: ({ functionName }: { functionName: string }) => {
    if (functionName === 'getTradeFundingFee') return { data: [FUNDING_OWED, 0n], isLoading: false };
    if (functionName === 'getTradeRolloverFee') return { data: ROLLOVER_OWED, isLoading: false };
    if (functionName === 'openTradesInfo') return { data: [7n, 0n, 1000, 0, 0, 0, false], isLoading: false };
    if (functionName === 'maxSl_P') return { data: 75, isLoading: false };
    if (functionName === 'pairMinLevPos') return { data: minLevPos.value, isLoading: false };
    if (functionName === 'getPendingOrderIds') return { data: [], isLoading: false };
    if (functionName === 'marketOrdersTimeout') return { data: 30, isLoading: false };
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

let oracleFeeRaw: bigint | null = 1_000_000n;
vi.mock('@/hooks/useMarketFees', () => ({ useMarketFees: () => ({ oracleFeeRaw, takerFeeRaw: 0n }) }));

vi.mock('@/hooks/useOrders', () => ({ useOrders: () => ({ orders: ordersMock, error: null, loading: false }) }));

let positionsMock: PositionSummary[] = [openPosition];
vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: positionsMock, error: null, loading: false, refetch: vi.fn() }),
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

let quoteInputsState: Record<string, bigint> | null = null;
vi.mock('@/hooks/useQuote', () => ({ useQuoteInputs: () => ({ inputs: quoteInputsState, unavailable: [], loading: false }) }));

vi.mock('@/hooks/useCloseTrade', () => ({
  useCloseTrade: () => ({ closeTrade: closeTradeMock, isPending: false }),
  FULL_CLOSE_PERCENT: 10000,
}));

beforeEach(() => {
  closeTradeMock.mockClear();
  Object.values(actions).forEach((f) => typeof f === 'function' && (f as ReturnType<typeof vi.fn>).mockClear());
  approveMock.mockClear();
  allowance = 10_000_000_000n;
  quoteInputsState = null;
  oracleFeeRaw = 1_000_000n;
  openPosition.sl = '0';
  ordersMock = [];
  positionsMock = [openPosition];
  legLiqRaw = {};
});

describe('<PositionsList>', () => {
  it('shows the liquidation price the contract returned, not a dash and not its own arithmetic', () => {
    render(<PositionsList />);
    // 90909090909090909090n at 18 decimals. Previously this cell was hardcoded to an
    // em-dash with "requires on-chain state this app does not read" — the state was always
    // readable; the app simply was not reading it.
    expect(screen.getByTestId('liq-price')).toHaveTextContent('90.91');
  });

  /**
   * Eleven single-figure columns made the table ~1,150px wide, so on the laptops most
   * traders use (1280–1536px) UPnL — the figure they open the tab for — sat behind a
   * horizontal scroll. Pairs now share a two-line cell and the columns run by importance,
   * so what a narrow screen hides is the least needed: funding, last.
   */
  it('runs the columns by importance, UPnL straight after the instrument', () => {
    render(<PositionsList />);
    const headers = Array.from(screen.getByTestId('positions-table').querySelectorAll('th')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual([
      'Instrument', 'UPnL', 'Size / Value', 'Entry / Mark', 'Liq. price', 'Margin', 'TP / SL', 'Funding', '',
    ]);
  });

  it('shows UPnL with its return on the margin beneath it', () => {
    render(<PositionsList />);
    const cell = screen.getByTestId('unrealized-pnl');
    // +1,000.00 on 1,000.00 of margin.
    expect(cell).toHaveTextContent('+1,000.00');
    expect(cell).toHaveTextContent('+100.00%');
  });

  it('names the side and leverage under the instrument', () => {
    render(<PositionsList />);
    const row = screen.getByTestId('position-row-0-0');
    expect(row.querySelector('td')).toHaveTextContent(/BTC-PERP\s*Long 10\.00x/);
  });

  /** On a phone the rows become cards, and a figure without its column header needs a name. */
  it('labels every figure for the card layout on narrow screens', () => {
    render(<PositionsList />);
    const cells = Array.from(screen.getByTestId('position-row-0-0').querySelectorAll('td'));
    const labels = cells.slice(1, -1).map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['UPnL', 'Size / Value', 'Entry / Mark', 'Liq. price', 'Margin', 'TP / SL', 'Funding']);
  });

  it('keeps TP/SL and margin behind a compact control with a spoken name', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('manage-toggle')).toHaveAccessibleName('TP/SL and margin');
  });

  it('values the position at the mark: 100 base units x 110 = 11,000 USDW', () => {
    render(<PositionsList />);
    expect(screen.getByTestId('position-value')).toHaveTextContent('11,000.00');
  });

  it('shows margin with its usage toward liquidation — zero while in profit', () => {
    render(<PositionsList />);
    const margin = screen.getByTestId('position-margin');
    expect(margin).toHaveTextContent('1,000.00');
    expect(margin).toHaveTextContent('0.00% used');
  });

  it('shows accrued funding plus rollover as a cost, negative and red', () => {
    render(<PositionsList />);
    const cell = screen.getByTestId('position-funding');
    expect(cell).toHaveTextContent('-1.75');
    expect(cell).toHaveClass('neg');
  });

  it('shows a dash for absent TP and SL', () => {
    render(<PositionsList />);
    const tpsl = screen.getByTestId('position-tpsl');
    expect(tpsl).toHaveTextContent('TP —');
    expect(tpsl).toHaveTextContent('SL —');
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

  // 10x long at 100.00 with maxSl_P 75: the stop may sit no lower than 92.50. A stop at 93.00 is
  // fine now, but removing 500 of the 1,000 margin takes the position to 20x, where the floor
  // is 96.25 — the keeper report would delete the stop. Refuse, and say why.
  it('refuses a margin removal that would delete the stop loss, and says so', () => {
    openPosition.sl = '93.000000000000000000';
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '500' } });
    expect(screen.getByTestId('manage-margin-remove')).toBeDisabled();
    expect(screen.getByTestId('manage-remove-drops-sl')).toHaveTextContent('20.00x');
  });

  it('allows a smaller removal that keeps the stop loss inside the limit', () => {
    openPosition.sl = '93.000000000000000000';
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '10' } });
    expect(screen.getByTestId('manage-margin-remove')).toBeEnabled();
    expect(screen.queryByTestId('manage-remove-drops-sl')).toBeNull();
  });

  it('shows the oracle fee a removal costs, and refuses when the wallet cannot pay it', () => {
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '100' } });
    expect(screen.getByTestId('manage-remove-fee')).toHaveTextContent('1.00 USDW');
    expect(screen.getByTestId('manage-margin-remove')).toBeEnabled();

    oracleFeeRaw = 6_000_000_000n; // more than the 5,000 USDW balance
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '101' } });
    expect(screen.getByTestId('manage-remove-no-fee')).toBeInTheDocument();
    expect(screen.getByTestId('manage-margin-remove')).toBeDisabled();
  });

  it('approves the fee first when the allowance does not cover it', async () => {
    allowance = 0n;
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('manage-toggle'));
    fireEvent.change(screen.getByTestId('manage-margin-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('manage-margin-remove'));
    await waitFor(() => expect(actions.removeCollateral).toHaveBeenCalled());
    expect(approveMock).toHaveBeenCalledTimes(1);
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
    // A spinner and one word while the close waits for its report — no keeper prose.
    const note = await screen.findByTestId('close-pending');
    expect(note).toHaveTextContent(/^Closing…$/);
    expect(note.querySelector('.spinner')).not.toBeNull();
    expect(note).not.toHaveTextContent(/keeper/i);
    expect(screen.queryByTestId('close-dialog')).not.toBeInTheDocument();
  });

  // A 1% half-spread under the 110.00 mark: closing the long sells at ~108.90, outside a
  // flat 0.5%. The close must go out with a tolerance that covers the quoted fill, and the
  // dialog must show that tolerance rather than the flat one.
  it('sends a close with a tolerance that covers the quoted closing price', async () => {
    const M = 110n * 10n ** 18n;
    quoteInputsState = {
      netVolThreshold: 0n, decayRate: 0n, priceImpactK: 0n, buyVolume: 0n, sellVolume: 0n,
      lastUpdateTimestamp: 0n, blockTimestamp: 0n, price: M, askPrice: M, bidPrice: M - M / 100n,
    };
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    expect(screen.getByTestId('close-slippage')).toHaveTextContent('1.01%');
    fireEvent.click(screen.getByTestId('close-confirm'));
    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(1));
    expect(closeTradeMock.mock.calls[0]![0]).toMatchObject({ slippageBps: 101n });
  });

  const closeOrder = (over: Record<string, unknown>) => ({
    orderId: '77', pairIndex: 0, kind: 'close', buy: true, collateral: '1000.000000', leverage: '10.00', requestedAt: 0,
    requestedAtBlock: '1', status: 'pending', expired: false, resolvedAt: null, cancelReason: null, tradeId: '7', ...over,
  });

  async function requestFullClose() {
    const view = render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-confirm'));
    await screen.findByTestId('close-pending');
    return view;
  }

  it('replaces the pending note with the reason when the close is cancelled', async () => {
    const { rerender } = await requestFullClose();
    ordersMock = [closeOrder({ status: 'cancelled', cancelReason: 'SLIPPAGE' })];
    rerender(<PositionsList />);
    expect(screen.getByTestId('close-pending')).toHaveTextContent('Close cancelled: slippage');
    expect(screen.getByTestId('close-pending')).toHaveAttribute('title', expect.stringMatching(/./));
    expect(screen.getByTestId('close-pending').querySelector('.spinner')).toBeNull();
  });

  it('clears the pending note once the close has executed', async () => {
    const { rerender } = await requestFullClose();
    ordersMock = [closeOrder({ status: 'executed' })];
    rerender(<PositionsList />);
    expect(screen.queryByTestId('close-pending')).toBeNull();
  });

  it('points an expired close at the release in Orders', async () => {
    const { rerender } = await requestFullClose();
    ordersMock = [closeOrder({ expired: true })];
    rerender(<PositionsList />);
    expect(screen.getByTestId('close-pending')).toHaveTextContent('Close did not fill — release it in Orders');
    expect(screen.getByTestId('close-pending')).not.toHaveTextContent(/keeper/i);
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

describe('<PositionsList> stacked positions', () => {
  // A second long on the same market: 500 USDW at 20x from 125.00 (size 80), next to the
  // 1,000 at 10x from 100.00 (size 100). Mark is 110.00.
  const second: PositionSummary = {
    ...openPosition,
    index: 1,
    collateral: '500.000000',
    leverage: '20.00',
    openPrice: '125.000000000000000000',
    openedAt: 10,
    tradeId: '8',
  };
  const short: PositionSummary = { ...openPosition, index: 2, buy: false, tradeId: '9' };

  it('shows two longs on one market as one position', () => {
    positionsMock = [openPosition, second];
    render(<PositionsList />);
    const row = screen.getByTestId('position-stack-0-long');
    expect(screen.queryByTestId('position-row-0-0')).toBeNull();
    expect(screen.queryByTestId('position-row-0-1')).toBeNull();
    expect(row).toHaveTextContent('+180.0000'); // 100 + 80 units
    expect(row).toHaveTextContent('13.33x'); // 20,000 notional / 1,500 margin
    expect(row).toHaveTextContent('111.11'); // size-weighted entry, not the mean 112.50
    expect(screen.getByTestId('position-value')).toHaveTextContent('19,800.00'); // 180 × 110
    expect(screen.getByTestId('position-margin')).toHaveTextContent('1,500.00');
    // +1,000 on the first, −1,200 on the second.
    expect(screen.getByTestId('unrealized-pnl')).toHaveTextContent('-200.00');
  });

  it('keeps a short on the same market out of the longs’ position', () => {
    positionsMock = [openPosition, short, second];
    render(<PositionsList />);
    expect(screen.getByTestId('position-stack-0-long')).toBeInTheDocument();
    expect(screen.getByTestId('position-row-0-2')).toBeInTheDocument();
    expect(screen.getAllByTestId('close-position-button')).toHaveLength(2);
  });

  it('shows the nearest liquidation of its trades — the highest, for a long', () => {
    positionsMock = [openPosition, second];
    legLiqRaw = { 0: 90n * 10n ** 18n, 1: 112n * 10n ** 18n + 5n * 10n ** 17n };
    render(<PositionsList />);
    expect(screen.getByTestId('liq-price')).toHaveTextContent('112.50');
  });

  it('adds up the trades’ funding and rollover', () => {
    positionsMock = [openPosition];
    const { unmount } = render(<PositionsList />);
    const one = screen.getByTestId('position-funding').textContent!;
    unmount();
    positionsMock = [openPosition, { ...openPosition, index: 1, tradeId: '8' }];
    render(<PositionsList />);
    const parse = (t: string) => Number(t.replace(/[^0-9.-]/g, ''));
    expect(parse(screen.getByTestId('position-funding').textContent!)).toBeCloseTo(2 * parse(one), 6);
  });

  it('closes every trade by the share picked, and follows all of them', async () => {
    positionsMock = [openPosition, second];
    closeTradeMock.mockResolvedValueOnce({ hash: '0xclose', receipt: {}, orderId: 77n }).mockResolvedValueOnce({ hash: '0xclose', receipt: {}, orderId: 78n });
    const { rerender } = render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    expect(screen.getByTestId('close-amount-input')).toHaveValue('180');
    fireEvent.click(screen.getByTestId('close-confirm'));
    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(2));
    expect(closeTradeMock.mock.calls.map((c) => [c[0].index, c[0].closePercentage])).toEqual([
      [0, 10000],
      [1, 10000],
    ]);
    expect(await screen.findByTestId('close-pending')).toHaveTextContent(/^Closing…$/);

    // One filled, one still waiting: still closing.
    ordersMock = [
      { orderId: '77', status: 'executed', expired: false, cancelReason: null },
      { orderId: '78', status: 'pending', expired: false, cancelReason: null },
    ];
    rerender(<PositionsList />);
    expect(screen.getByTestId('close-pending')).toHaveTextContent('Closing…');

    // The other cancelled: the row says so.
    ordersMock = [ordersMock[0]!, { orderId: '78', status: 'cancelled', expired: false, cancelReason: 'SLIPPAGE' }];
    rerender(<PositionsList />);
    expect(screen.getByTestId('close-pending')).toHaveTextContent('Close cancelled: slippage');

    // Both filled: the note goes.
    ordersMock = [ordersMock[0]!, { orderId: '78', status: 'executed', expired: false, cancelReason: null }];
    rerender(<PositionsList />);
    expect(screen.queryByTestId('close-pending')).toBeNull();
  });

  it('closes the same share of every trade on a partial close', async () => {
    positionsMock = [openPosition, second];
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-quick-25'));
    fireEvent.click(screen.getByTestId('close-confirm'));
    await waitFor(() => expect(closeTradeMock).toHaveBeenCalledTimes(2));
    expect(closeTradeMock.mock.calls.map((c) => c[0].closePercentage)).toEqual([2500, 2500]);
  });

  it('says how many trades were closed when one close fails part way', async () => {
    positionsMock = [openPosition, second];
    closeTradeMock.mockResolvedValueOnce({ hash: '0xclose', receipt: {}, orderId: 77n }).mockRejectedValueOnce(new Error('execution reverted'));
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('close-position-button'));
    fireEvent.click(screen.getByTestId('close-confirm'));
    expect(await screen.findByTestId('close-error')).toHaveTextContent(/^Close sent for 1 of 2 trades\./);
    expect(screen.getByTestId('close-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('close-pending')).toHaveTextContent('Closing…');
  });

  it('opens the individual trades and sets a take profit on all of them', async () => {
    positionsMock = [openPosition, second];
    render(<PositionsList />);
    expect(screen.getByTestId('stack-toggle')).toHaveTextContent('2 trades');
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('position-row-0-0')).toHaveClass('leg-row');
    expect(screen.getByTestId('position-row-0-1')).toHaveClass('leg-row');

    fireEvent.change(screen.getByTestId('stack-tp-input'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('stack-tp-save'));
    await waitFor(() => expect(actions.updateTp).toHaveBeenCalledTimes(2));
    expect(actions.updateTp).toHaveBeenNthCalledWith(1, 0, 0, 150n * 10n ** 18n);
    expect(actions.updateTp).toHaveBeenNthCalledWith(2, 0, 1, 150n * 10n ** 18n);
    expect(await screen.findByTestId('stack-message')).toHaveTextContent('Take profit updated.');
  });

  it('refuses a take profit any one trade cannot take', () => {
    positionsMock = [openPosition, second];
    render(<PositionsList />);
    fireEvent.click(screen.getByTestId('stack-toggle'));
    // Inside the 10x trade's +900% cap (190.00), past the 20x trade's (181.25).
    fireEvent.change(screen.getByTestId('stack-tp-input'), { target: { value: '185' } });
    expect(screen.getByTestId('stack-tp-error')).toHaveTextContent('beyond the +900% cap');
    expect(screen.getByTestId('stack-tp-save')).toBeDisabled();
  });

  it('marks a stop loss the trades do not share', () => {
    positionsMock = [{ ...openPosition, sl: '95' }, { ...second, sl: '90' }];
    render(<PositionsList />);
    expect(screen.getByTestId('position-tpsl')).toHaveTextContent('TP —SL mixed');
  });
});
