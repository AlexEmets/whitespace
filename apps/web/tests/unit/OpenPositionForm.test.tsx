import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import type { OpenTradeParams } from '@/hooks/useOpenTrade';
import { TRADING_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';

const openTradeMock = vi.fn(async (_params: OpenTradeParams) => ({ hash: '0xabc' as const, receipt: {}, orderId: 42n }));
const approveMock = vi.fn(async () => {});
const refetchAllowanceMock = vi.fn(async () => {});
const claimFaucetMock = vi.fn(async () => {});

// mark/index are human decimals with exactly PRICE_DECIMALS fraction digits — the shape
// /price/:pairIndex emits, not the raw 18-decimal integer the contract stores.
let priceState: { mark: string; index: string; degraded: boolean; healthyVenues: number; updatedAt: number } | null = {
  mark: '65001.000000000000000000',
  index: '65000.000000000000000000',
  degraded: false,
  healthyVenues: 4,
  updatedAt: 0,
};
let allowanceState = 10_000_000_000n; // plenty of allowance by default
let balanceState = 10_000_000_000n;

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
    updatedAt: 0,
  };
  allowanceState = 10_000_000_000n;
  balanceState = 10_000_000_000n;
});

describe('<OpenPositionForm>', () => {
  it('shows the reference price and the default tight slippage, explicitly (design §5.1)', () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    expect(screen.getByTestId('reference-price')).toHaveValue('65,001.00');
    // Default slippage is 50 bps = 0.50% — tight, and displayed, not hidden in a panel.
    expect(screen.getByTestId('slippage-value')).toHaveTextContent('0.50%');
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
    // Nothing to evaluate yet: no collateral entered, so the read stays disabled.
    expect(screen.getByTestId('est-liq-price')).toHaveTextContent('—');

    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
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
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(screen.getByTestId('order-pending-banner')).toBeInTheDocument());

    // Any change to what would be submitted invalidates the banner.
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '150' } });
    expect(screen.queryByTestId('order-pending-banner')).not.toBeInTheDocument();
  });

  it('clears the outcome when the side is flipped, not just when the size changes', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));
    await waitFor(() => expect(screen.getByTestId('order-pending-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('direction-short'));
    expect(screen.queryByTestId('order-pending-banner')).not.toBeInTheDocument();
  });

  it('hides the faucet when the wallet can already fund the order', () => {
    balanceState = 10_000_000_000n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    expect(screen.queryByTestId('faucet-button')).not.toBeInTheDocument();
  });

  it('disables opening and shows a clear message when the price feed is degraded', () => {
    priceState = { ...priceState!, degraded: true, healthyVenues: 2 };
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    expect(screen.getByTestId('open-blocked-degraded')).toBeInTheDocument();
    expect(screen.getByTestId('submit-open-button')).toBeDisabled();
  });

  it('requires an approval before the amount can be opened when allowance is insufficient', async () => {
    allowanceState = 0n;
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    expect(screen.getByTestId('approve-button')).toBeInTheDocument();
    expect(screen.queryByTestId('submit-open-button')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approve-button'));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(100_000_000n));
    expect(refetchAllowanceMock).toHaveBeenCalled();
  });

  it('submits openTrade with the exact bigint collateral/leverage/price/slippage and shows the pending (not "opened") state', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock).toHaveBeenCalledWith({
      pairIndex: 0,
      buy: true,
      collateralRaw: 100_000_000n, // 100.00 USDW at 6 decimals
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

  it('lets the trader pick Short instead of the Long default', async () => {
    render(<OpenPositionForm pairIndex={0} maxLeverage={10000n} />);
    fireEvent.click(screen.getByTestId('direction-short'));
    fireEvent.change(screen.getByTestId('collateral-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('submit-open-button'));

    await waitFor(() => expect(openTradeMock).toHaveBeenCalledTimes(1));
    expect(openTradeMock.mock.calls[0]?.[0]).toMatchObject({ buy: false });
  });
});
