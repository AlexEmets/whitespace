import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { maxUint256 } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import type { OpenTradeParams } from '@/hooks/useOpenTrade';
import { TRADING_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import type { MarketSummary } from '@/lib/types';

const openTradeMock = vi.fn(async (_params: OpenTradeParams) => ({ hash: '0xabc' as const, receipt: {}, orderId: 42n }));
const approveMock = vi.fn(async () => {});
const refetchAllowanceMock = vi.fn(async () => {});
const claimFaucetMock = vi.fn(async () => {});

// mark/index are human decimals with exactly PRICE_DECIMALS fraction digits — the shape
// /price/:pairIndex emits, not the raw 18-decimal integer the contract stores.
let priceState: {
  mark: string;
  index: string;
  degraded: boolean;
  healthyVenues: number;
  minHealthyVenues: number | null;
  updatedAt: number;
} | null = {
  mark: '65001.000000000000000000',
  index: '65000.000000000000000000',
  degraded: false,
  healthyVenues: 4,
  minHealthyVenues: 3,
  updatedAt: 0,
};
let allowanceState = 10_000_000_000n; // plenty of allowance by default
let balanceState = 10_000_000_000n; // 10,000.00 USDW

const BTC_USD: MarketSummary = {
  pairIndex: 0,
  from: 'BTC',
  to: 'USD',
  feedId: '0x00',
  maxLeverage: '100.00',
  maxOpenInterest: '0',
  openInterest: { long: '0', short: '0' },
};

/**
 * The form is denominated in the base asset, but `openTrade` takes COLLATERAL — so every
 * size below has one collateral it must convert to, and getting that arithmetic wrong is
 * a wrong amount of money leaving the wallet.
 *
 *   collateral = size x price / leverage
 *   0.01 BTC at 65,001.00 and the default 10x  =  650.01 / 10  =  65.001000 USDW
 *
 * which is 65_001_000n at COLLATERAL_DECIMALS (6). Written out rather than computed with
 * the helper under test, so the test fails if the helper changes.
 */
const SIZE_0_01_BTC = '0.01';
const COLLATERAL_FOR_0_01_BTC = 65_001_000n;

/** Raw PRECISION_18 estimated liquidation price the mocked contract read returns. The
 * form calls getTradeLiquidationPricePure with rollover/funding at zero; what it must do
 * with the answer is render it, which is all this suite checks. */
const EST_LIQ_PRICE_RAW = 58500900000000000000000n;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  // The order form's Est. liq. price is a real read against OstiumPairInfos
  // (useEstimatedLiquidationPrice). Mocked at the wagmi boundary so the hook's own
  // enable-gating still executes. Honouring `query.enabled` here matters: wagmi would
  // never invoke the contract for a disabled read, and a mock that answers anyway would
  // let a regression in that gating pass unnoticed.
  useReadContract: ({ query }: { query?: { enabled?: boolean } }) =>
    query?.enabled === false ? { data: undefined, isLoading: false } : { data: EST_LIQ_PRICE_RAW, isLoading: false },
}));

vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({ data: priceState, error: null, loading: false, refetch: vi.fn() }),
}));

/** Records which contract the form asks for an allowance against — see the spender test. */
const erc20Spenders: string[] = [];

vi.mock('@/hooks/useErc20', () => ({
  useErc20: (spender: string) => {
    erc20Spenders.push(spender);
    return {
      balance: balanceState,
      allowance: allowanceState,
      refetchBalance: vi.fn(async () => {}),
      refetchAllowance: refetchAllowanceMock,
      approve: approveMock,
      claimFaucet: claimFaucetMock,
      isWritePending: false,
    };
  },
}));

vi.mock('@/hooks/useMarketFees', () => ({
  useMarketFees: () => ({ makerFeeRaw: 0n, takerFeeRaw: 0n, oracleFeeRaw: 1_000_000n, loading: false }),
}));

vi.mock('@/hooks/useOpenTrade', () => ({
  useOpenTrade: () => ({ openTrade: openTradeMock, isPending: false }),
}));

vi.mock('@/hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], error: null, loading: false, refetch: vi.fn() }),
}));

beforeEach(() => {
  openTradeMock.mockClear();
  approveMock.mockClear();
  refetchAllowanceMock.mockClear();
  claimFaucetMock.mockClear();
  priceState = {
    mark: '65001.000000000000000000',
    index: '65000.000000000000000000',
    degraded: false,
    healthyVenues: 4,
    minHealthyVenues: 3,
    updatedAt: 0,
  };
  allowanceState = 10_000_000_000n;
  balanceState = 10_000_000_000n;
});

describe('<OpenPositionForm>', () => {
  it('shows the reference price with its USDW unit', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('reference-price')).toHaveValue('65,001.00');
  });

  /**
   * The MAX SLIPPAGE slider was deleted to match terminal_design.pdf, which has exactly
   * one slider (LEVERAGE). Slippage is a transaction PARAMETER, not decoration — in this
   * two-phase design it is the trader's only defence against an unfavourable execution
   * price — so deleting the control had to pin the value, not drop it. This is the test
   * that says the deletion did not quietly loosen everyone's tolerance.
   */
  it('has no slippage control, and still submits the protocol default tolerance', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.queryByTestId('slippage-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slippage-value')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]?.[0]).toMatchObject({ slippageBps: 50n });
  });

  /** Reference order is LIMIT MARKET STOP TWAP. MARKET must stay the ACTIVE one: every
   * submission is hardcoded to OPEN_ORDER_TYPE_MARKET in useOpenTrade, so an active LIMIT
   * tab would name one order type on screen and sign another on chain. */
  it('orders the tabs as the reference does while keeping MARKET the active one', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    const tabs = Array.from(document.querySelectorAll('.order-type-tabs button'));

    expect(tabs.map((t) => t.textContent)).toEqual(['Limit', 'Market', 'Stop', 'TWAP']);
    expect(tabs.find((t) => t.textContent === 'Market')).toHaveClass('active');
    expect(tabs.find((t) => t.textContent === 'Limit')).toBeDisabled();
    expect(tabs.find((t) => t.textContent === 'Limit')).not.toHaveClass('active');
  });

  it('denominates the size field in the market’s base asset', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('open-position-form')).toHaveTextContent('BTC');
  });

  /**
   * `OstiumTrading.openTrade` does not move the collateral — `OstiumTradingStorage` does,
   * via `safeTransferFrom` at OstiumTradingStorage.sol:486, so the token sees
   * TradingStorage as the spender. Approving Trading instead granted an allowance nothing
   * spends: the form showed a ready "Buy · Long" and the transaction reverted on chain
   * with `ERC20InsufficientAllowance(tradingStorage, 0, collateral)` (real failure
   * 0x356a2a3b… on 1874). It was invisible in testing because the one account used for
   * end-to-end runs had an unlimited TradingStorage allowance from the deploy script.
   */
  it('checks the allowance against TradingStorage, which is what actually pulls the collateral', () => {
    erc20Spenders.length = 0;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(erc20Spenders.length).toBeGreaterThan(0);
    expect(new Set(erc20Spenders)).toEqual(new Set([TRADING_STORAGE_ADDRESS]));
    expect(erc20Spenders).not.toContain(TRADING_ADDRESS);
  });

  it('renders the contract’s estimated liquidation price once there is a size to evaluate', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    // Nothing to evaluate yet: no size entered, so the read stays disabled.
    expect(screen.getByTestId('est-liq-price')).toHaveTextContent('—');

    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    // 58500900000000000000000n at 18 decimals. The component must render what the chain
    // returned — it must never compute a liquidation price itself.
    expect(screen.getByTestId('est-liq-price')).toHaveTextContent('58,500.90');
  });

  /**
   * A wallet with no USDW could previously reach a terminal where every control worked and
   * nothing could be submitted, with no route to collateral anywhere in the product.
   */
  it('offers the faucet when the wallet has no USDW, and claims on click', async () => {
    balanceState = 0n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('faucet-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('faucet-button'));
    await waitFor(() => expect(claimFaucetMock).toHaveBeenCalled());
  });

  /**
   * The outcome banner describes one submitted order. Leaving it up while the trader
   * composes the next one showed "Insufficient USDW balance", "Approve USDW" and
   * "Filled — your position is now open." simultaneously, each about a different moment.
   */
  it('clears the previous order outcome as soon as the trader edits the next one', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(screen.getByTestId('order-pending-banner')).toBeInTheDocument());

    // Any change to what would be submitted invalidates the banner.
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: '0.02' } });
    expect(screen.queryByTestId('order-pending-banner')).not.toBeInTheDocument();
  });

  it('clears the outcome when the side is flipped, not just when the size changes', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(screen.getByTestId('order-pending-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('direction-short'));
    expect(screen.queryByTestId('order-pending-banner')).not.toBeInTheDocument();
  });

  it('hides the faucet when the wallet can already fund the order', () => {
    balanceState = 10_000_000_000n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.queryByTestId('faucet-button')).not.toBeInTheDocument();
  });

  it('disables opening and shows a clear message when the price feed is degraded', () => {
    priceState = { ...priceState!, degraded: true, healthyVenues: 2, minHealthyVenues: 3 };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('open-blocked-degraded')).toBeInTheDocument();
    expect(screen.getByTestId('open-blocked-degraded')).toHaveTextContent('fewer than 3 healthy venues');
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  // The copy is rendered from the market's own minimum, so a market with a lower one must
  // not be described by the global 3. This is the assertion that fails if anyone reinstates
  // a hardcoded number in the message.
  it("names the market's own venue minimum in the degraded message, not a hardcoded 3", () => {
    priceState = { ...priceState!, degraded: true, healthyVenues: 1, minHealthyVenues: 2 };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    const alert = screen.getByTestId('open-blocked-degraded');
    expect(alert).toHaveTextContent('fewer than 2 healthy venues');
    expect(alert).not.toHaveTextContent('fewer than 3 healthy venues');
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  // Degraded with no threshold known (chain fallback, or a publisher too old to send it):
  // the block must still happen, and the copy must simply omit the number rather than
  // inventing one.
  it('still blocks opening when the threshold is unknown, without naming a number', () => {
    priceState = { ...priceState!, degraded: true, healthyVenues: 1, minHealthyVenues: null };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    const alert = screen.getByTestId('open-blocked-degraded');
    expect(alert).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('fewer than');
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  /**
   * terminal_design.pdf gives the order panel exactly one action — there is no approval
   * step anywhere in the reference. The allowance transaction itself is unavoidable
   * (`openTrade` pulls collateral with `safeTransferFrom` and USDW has no `permit` to sign
   * instead), so it moves inside the submit handler rather than disappearing: one button,
   * two wallet confirmations, and only on the first order a wallet ever places.
   */
  it('approves inside the submit click instead of putting a second button in front of it', async () => {
    allowanceState = 0n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });

    expect(screen.queryByTestId('approve-button')).not.toBeInTheDocument();
    const submit = screen.getByTestId('submit-open-button');
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    /**
     * Approves MAX, not this order's collateral.
     *
     * Approving the exact amount made every order larger than the last one demand a
     * second transaction before it could be submitted. Asserting max rather than "some
     * bigint" is the point — a regression back to the exact amount would restore the
     * repeated prompt and this test would still pass if it only checked that approve ran.
     */
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(maxUint256));
    expect(approveMock).not.toHaveBeenCalledWith(COLLATERAL_FOR_0_01_BTC);
    expect(refetchAllowanceMock).toHaveBeenCalled();

    // Approving and then stopping is the old two-click flow with the button hidden — the
    // order this click was for has to follow, and follow second.
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0].collateralRaw).toBe(COLLATERAL_FOR_0_01_BTC);
    expect(approveMock.mock.invocationCallOrder[0]!).toBeLessThan(openTradeMock.mock.invocationCallOrder[0]!);
  });

  it('spends no second transaction when the allowance already covers the order', async () => {
    allowanceState = 10_000_000_000n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(approveMock).not.toHaveBeenCalled();
  });

  /**
   * Two wallet pop-ups from one click reads as a failure — "did the first one not work?"
   * — and the trader's instinct is to reject the second. The notice exists only while the
   * approval leg is in flight, which is the only moment it is true.
   */
  it('warns that the wallet will ask twice, but only while the approval leg is running', async () => {
    allowanceState = 0n;
    let release: () => void = () => {};
    approveMock.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });

    expect(screen.queryByTestId('approval-notice')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('submit-open-button'));

    expect(await screen.findByTestId('approval-notice')).toHaveTextContent(/twice/i);

    release();
    await waitFor(() => expect(screen.queryByTestId('approval-notice')).not.toBeInTheDocument());
  });

  it('submits the collateral the size converts to, and shows the pending (not "opened") state', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock).toHaveBeenCalledWith({
      pairIndex: 0,
      buy: true,
      collateralRaw: COLLATERAL_FOR_0_01_BTC, // 0.01 BTC at 65,001.00 and 10x
      leverageRaw: 1000n, // default 10x at PRECISION_2
      wantedPriceRaw: 65001000000000000000000n,
      slippageBps: 50n,
    });

    // Two-phase honesty: after the tx confirms, the UI must not claim the position is
    // open — only that the request was submitted and is pending a keeper report.
    const banner = await screen.findByTestId('order-pending-banner');
    expect(banner).toHaveTextContent(/Nothing has happened yet/i);
    expect(banner).not.toHaveTextContent(/position is now open/i);
  });

  /** The trader sizes in BTC but pays in USDW, so the USDW figure has to be on screen —
   * and it has to be the same one that is submitted, not a separately-rounded copy. */
  it('shows the derived collateral as Margin required, matching what is submitted', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });

    expect(screen.getByTestId('margin-required')).toHaveTextContent('65.00 USDW');

    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]?.[0]).toMatchObject({ collateralRaw: COLLATERAL_FOR_0_01_BTC });
  });

  /** Sizing in the base asset must not let an order past the balance check: the guard
   * applies to the DERIVED collateral, which is the figure the token actually moves. */
  it('refuses a size whose collateral exceeds the wallet balance', () => {
    balanceState = 10_000_000_000n; // 10,000 USDW; at 10x that funds ~1.538 BTC
    // Allowance kept above the derived collateral on purpose: otherwise the form renders
    // the Approve button instead and this would assert the approval path, not the
    // balance guard. 2 BTC needs 13,000.20 USDW.
    allowanceState = 100_000_000_000n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: '2' } });

    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
    expect(screen.getByTestId('open-position-form')).toHaveTextContent(/insufficient usdw balance/i);
  });

  it('lets the trader pick Short instead of the Long default', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('direction-short'));
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: '0.005' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]?.[0]).toMatchObject({ buy: false });
  });

  /** Quick-fill is a fraction of the WALLET expressed as a size, so Max must produce an
   * order the balance can actually fund — the round-trip through both conversions. */
  it('sizes Max to what the balance can fund, not to something it cannot', async () => {
    balanceState = 1_000_000_000n; // 1,000.00 USDW
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('quick-fill-100'));

    expect(screen.getByTestId('submit-open-button')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    const submitted = openTradeMock.mock.calls[0]?.[0].collateralRaw ?? 0n;
    expect(submitted).toBeGreaterThan(0n);
    expect(submitted).toBeLessThanOrEqual(1_000_000_000n);
  });
});
