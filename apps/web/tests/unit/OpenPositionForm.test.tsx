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
const MARK_RAW = 65_001n * 10n ** 18n;
const E18 = 10n ** 18n;
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

/**
 * The quote is computed by the real lib/quote.ts over controllable oracle inputs, so the form
 * is tested against the contract's own fill formula rather than a hand-written stub.
 */
let quoteInputs: {
  netVolThreshold: bigint;
  decayRate: bigint;
  priceImpactK: bigint;
  buyVolume: bigint;
  sellVolume: bigint;
  lastUpdateTimestamp: bigint;
  blockTimestamp: bigint;
  price: bigint;
  askPrice: bigint;
  bidPrice: bigint;
} | null = null;

vi.mock('@/hooks/useQuote', async () => {
  const { quoteForNotional } = await import('@/lib/quote');
  return {
    useQuote: (_pair: number | null, notionalRaw: bigint) => ({
      inputs: quoteInputs,
      quote: quoteInputs ? quoteForNotional(quoteInputs, notionalRaw) : null,
      unavailable: quoteInputs ? [] : [{ kind: 'no-quote', detail: 'the publisher has no two-sided aggregate right now' }],
      loading: false,
    }),
  };
});

let positionsState: { pairIndex: number; index: number; buy: boolean; collateral: string; leverage: string; openPrice: string }[] = [];
vi.mock('@/hooks/usePositions', () => ({
  usePositions: () => ({ positions: positionsState, error: null, loading: false, refetch: vi.fn() }),
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
  positionsState = [];
  // A zero-width quote at the mark with no size impact: fills land exactly on 65,001.00, so the
  // collateral arithmetic below is the plain size x price / leverage.
  quoteInputs = {
    netVolThreshold: 0n,
    decayRate: 0n,
    priceImpactK: 0n,
    buyVolume: 0n,
    sellVolume: 0n,
    lastUpdateTimestamp: 0n,
    blockTimestamp: 0n,
    price: MARK_RAW,
    askPrice: MARK_RAW,
    bidPrice: MARK_RAW,
  };
});

describe('<OpenPositionForm>', () => {
  it('denominates the size field in the market’s base asset', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('open-position-form')).toHaveTextContent('BTC');
  });

  /**
   * The reference labels the submit `BUY · LONG BTC`. Naming the asset on the button
   * matters more here than on a single-market venue: the market is chosen in a rail three
   * columns away, and this is the last thing read before a signature.
   */
  it('names the market and the direction on the submit button', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('submit-open-button')).toHaveTextContent('Buy · Long BTC');

    fireEvent.click(screen.getByTestId('direction-short'));
    expect(screen.getByTestId('submit-open-button')).toHaveTextContent('Sell · Short BTC');
  });

  /** The leverage actually in force is the most consequential number on the panel — it
   * sets the size and how far price must move to liquidate — so it is rendered, not
   * implied by a slider position. */
  it('states the selected leverage as a figure, not only as a slider position', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('leverage-value')).toHaveTextContent('10×');

    fireEvent.change(screen.getByTestId('leverage-slider'), { target: { value: '25' } });
    expect(screen.getByTestId('leverage-value')).toHaveTextContent('25×');
  });

  /** The Eclipse ticket keeps the slider on the panel: leverage is set on every order, so
   * hiding it behind a toggle cost a click each time and hid the market's maximum. */
  it('keeps the leverage slider and the market maximum on the ticket without a toggle', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('leverage-slider')).toHaveAttribute('max', '100');
    expect(screen.queryByTestId('leverage-button')).not.toBeInTheDocument();
  });

  it('marks the chosen side as pressed for assistive tech, not only by colour', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('direction-long')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('direction-short')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('direction-short'));
    expect(screen.getByTestId('direction-long')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('direction-short')).toHaveAttribute('aria-pressed', 'true');
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
      tp: 0n,
      sl: 0n,
      kind: 'MARKET',
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

  // ---------------------------------------------------------------------------------------
  // The quote (Variational-style, no order book)
  // ---------------------------------------------------------------------------------------

  it('carries the vault quote on the side buttons, with the spread', () => {
    quoteInputs = { ...quoteInputs!, askPrice: MARK_RAW + 13n * E18, bidPrice: MARK_RAW - 13n * E18 };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('quote-buy')).toHaveTextContent('65,014.00');
    expect(screen.getByTestId('quote-sell')).toHaveTextContent('64,988.00');
    // (65,014 - 64,988) / 65,001 = 0.039999…% → 0.0400%
    expect(screen.getByTestId('quote-spread')).toHaveTextContent('0.0400%');
  });

  it('submits a long at the quoted ask and a short at the quoted bid, not at the mark', async () => {
    quoteInputs = { ...quoteInputs!, askPrice: MARK_RAW + 13n * E18, bidPrice: MARK_RAW - 13n * E18 };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0].wantedPriceRaw).toBe(MARK_RAW + 13n * E18);

    fireEvent.click(screen.getByTestId('direction-short'));
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(2));
    expect(openTradeMock.mock.calls[1]![0].wantedPriceRaw).toBe(MARK_RAW - 13n * E18);
  });

  it('shows the quoted price and the estimated slippage for the chosen side', () => {
    quoteInputs = { ...quoteInputs!, askPrice: MARK_RAW + 65n * E18 / 10n, bidPrice: MARK_RAW - 65n * E18 / 10n };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('quoted-price')).toHaveTextContent('65,007.50');
    expect(screen.getByTestId('slippage')).toHaveTextContent('Est: 0.0100%');
  });

  it('raises the max slippage to cover a quote that is wider than the default', async () => {
    // 1% above the mark — the 0.50% default would cancel the very fill the panel showed.
    quoteInputs = { ...quoteInputs!, askPrice: (MARK_RAW * 101n) / 100n };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('max-slippage')).toHaveTextContent('Max: 1.01%');
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0].slippageBps).toBe(101n);
  });

  it('lets the trader set the max slippage, within the allowed ceiling', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('max-slippage'));
    const input = screen.getByTestId('max-slippage-input');
    fireEvent.change(input, { target: { value: '1.25' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('max-slippage')).toHaveTextContent('Max: 1.25%');

    fireEvent.click(screen.getByTestId('max-slippage'));
    fireEvent.change(screen.getByTestId('max-slippage-input'), { target: { value: '50' } });
    fireEvent.blur(screen.getByTestId('max-slippage-input'));
    expect(screen.getByTestId('max-slippage')).toHaveTextContent('Max: 1.25%'); // 50% refused

    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0].slippageBps).toBe(125n);
  });

  it('refuses a market order when there is no quote, and says why', () => {
    quoteInputs = null;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('quote-unavailable')).toHaveTextContent(/two-sided/);
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  // ---------------------------------------------------------------------------------------
  // Size units and percent of balance
  // ---------------------------------------------------------------------------------------

  it('toggles the size between the base asset and USD without changing the order', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('size-unit-toggle')).toHaveTextContent('BTC');

    fireEvent.click(screen.getByTestId('size-unit-toggle'));
    expect(screen.getByTestId('size-unit-toggle')).toHaveTextContent('USD');
    expect(screen.getByTestId('size-input')).toHaveValue('650.01');
    expect(screen.getByTestId('margin-required')).toHaveTextContent('65.00 USDW');

    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0].collateralRaw).toBe(COLLATERAL_FOR_0_01_BTC);
  });

  it('shows the order value and quantity for what is typed', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('order-value')).toHaveTextContent('650.01 USDW');
    expect(screen.getByTestId('order-quantity')).toHaveTextContent('0.010000 BTC');
  });

  it('prices the fee at the taker rate plus the oracle fee', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    // takerFeeRaw is 0 in this suite's mock, so the fee is the $1 oracle fee alone.
    expect(screen.getByTestId('fee')).toHaveTextContent('1.00 USDW');
  });

  it('flags text that is not a number instead of submitting it', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: 'abc' } });
    expect(screen.getByTestId('open-position-form')).toHaveTextContent('Not a number.');
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  // ---------------------------------------------------------------------------------------
  // Current position
  // ---------------------------------------------------------------------------------------

  it('sums this wallet’s positions on the market into a signed current position', () => {
    positionsState = [
      { pairIndex: 0, index: 0, buy: true, collateral: '650.01', leverage: '10.00', openPrice: '65001' }, // +0.1
      { pairIndex: 0, index: 1, buy: false, collateral: '65.001', leverage: '10.00', openPrice: '65001' }, // -0.01
      { pairIndex: 1, index: 0, buy: true, collateral: '100', leverage: '10.00', openPrice: '2500' }, // other market
    ];
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    expect(screen.getByTestId('current-position')).toHaveTextContent('+0.0900 BTC');
  });

  it('shows a dash when there is no position on the market', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('current-position')).toHaveTextContent('—');
  });

  // ---------------------------------------------------------------------------------------
  // Limit and stop entries
  // ---------------------------------------------------------------------------------------

  it('offers Market, Limit and Stop, with Market selected', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('order-kind-market')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('order-kind-limit')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('order-kind-stop')).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByTestId('trigger-price-input')).not.toBeInTheDocument();
  });

  /**
   * Nothing is wrong with a trigger nobody has typed yet. The red "Enter a trigger price."
   * met the trader the instant they switched to Limit — before they had done anything —
   * so an empty trigger now says nothing and simply leaves the order unplaceable.
   */
  it('says nothing about an empty trigger, and keeps the order unplaceable until there is one', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    for (const kind of ['limit', 'stop'] as const) {
      fireEvent.click(screen.getByTestId(`order-kind-${kind}`));
      expect(screen.queryByTestId('trigger-error')).not.toBeInTheDocument();

      fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
      expect(screen.queryByTestId('trigger-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('submit-open-button')).toBeDisabled();
    }
  });

  it('a limit buy must rest below the market', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('order-kind-limit'));
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.change(screen.getByTestId('trigger-price-input'), { target: { value: '66000' } });
    expect(screen.getByTestId('trigger-error')).toHaveTextContent(/below/);
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  it('places a limit buy at the trigger price, sized at that price, and says it is resting', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} market={BTC_USD} />);
    fireEvent.click(screen.getByTestId('order-kind-limit'));
    fireEvent.change(screen.getByTestId('trigger-price-input'), { target: { value: '60000' } });
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    expect(screen.getByTestId('submit-open-button')).toHaveTextContent('Place Limit Buy BTC');
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0]).toMatchObject({
      kind: 'LIMIT',
      buy: true,
      wantedPriceRaw: 60_000n * E18,
      collateralRaw: 60_000_000n, // 0.01 x 60,000 / 10
    });
    expect(await screen.findByTestId('order-placed')).toHaveTextContent(/rests on chain/);
  });

  it('a stop sell must rest below the market, and places once it does', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('order-kind-stop'));
    fireEvent.click(screen.getByTestId('direction-short'));
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.change(screen.getByTestId('trigger-price-input'), { target: { value: '70000' } });
    expect(screen.getByTestId('trigger-error')).toHaveTextContent(/below/);

    fireEvent.change(screen.getByTestId('trigger-price-input'), { target: { value: '60000' } });
    expect(screen.queryByTestId('trigger-error')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0]).toMatchObject({ kind: 'STOP', buy: false, wantedPriceRaw: 60_000n * E18 });
  });

  it('fills the trigger with the mark on request', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('order-kind-limit'));
    fireEvent.click(screen.getByText('Mark'));
    expect(screen.getByTestId('trigger-price-input')).toHaveValue('65001.00');
  });

  // ---------------------------------------------------------------------------------------
  // TP / SL
  // ---------------------------------------------------------------------------------------

  it('refuses a take profit below a long entry and a stop loss above it', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('tpsl-toggle'));
    fireEvent.change(screen.getByTestId('tp-input'), { target: { value: '60000' } });
    fireEvent.change(screen.getByTestId('sl-input'), { target: { value: '70000' } });
    expect(screen.getByTestId('tp-error')).toHaveTextContent(/above/);
    expect(screen.getByTestId('sl-error')).toHaveTextContent(/below/);
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  it('submits a valid take profit and stop loss with the order', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('tpsl-toggle'));
    fireEvent.change(screen.getByTestId('tp-input'), { target: { value: '70000' } });
    fireEvent.change(screen.getByTestId('sl-input'), { target: { value: '60000' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0]).toMatchObject({ tp: 70_000n * E18, sl: 60_000n * E18 });
  });

  it('sends no TP/SL once the section is switched off again', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('size-input'), { target: { value: SIZE_0_01_BTC } });
    fireEvent.click(screen.getByTestId('tpsl-toggle'));
    fireEvent.change(screen.getByTestId('tp-input'), { target: { value: '70000' } });
    fireEvent.click(screen.getByTestId('tpsl-toggle'));
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]![0]).toMatchObject({ tp: 0n, sl: 0n });
  });
});
