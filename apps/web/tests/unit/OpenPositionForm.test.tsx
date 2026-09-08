import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import type { OpenTradeParams } from '@/hooks/useOpenTrade';

const openTradeMock = vi.fn(async (_params: OpenTradeParams) => ({ hash: '0xabc' as const, receipt: {}, orderId: 42n }));
const approveMock = vi.fn(async () => {});
const refetchAllowanceMock = vi.fn(async () => {});

let priceState: { mark: string; index: string; degraded: boolean; healthyVenues: number; updatedAt: number } | null = {
  mark: '65001000000000000000000',
  index: '65000000000000000000000',
  degraded: false,
  healthyVenues: 4,
  updatedAt: 0,
};
let allowanceState = 10_000_000_000n; // plenty of allowance by default
let balanceState = 10_000_000_000n;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
}));

vi.mock('@/hooks/usePrice', () => ({
  usePrice: () => ({ data: priceState, error: null, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: balanceState,
    allowance: allowanceState,
    refetchBalance: vi.fn(async () => {}),
    refetchAllowance: refetchAllowanceMock,
    approve: approveMock,
    claimFaucet: vi.fn(async () => {}),
    isWritePending: false,
  }),
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
  priceState = {
    mark: '65001000000000000000000',
    index: '65000000000000000000000',
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
