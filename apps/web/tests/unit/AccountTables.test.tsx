import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FundingHistoryList,
  LimitOrdersList,
  OrderHistoryList,
  RealizedPnlPanel,
} from '@/components/terminal/AccountTables';
import type { FeeCharge, LimitOrderSummary, OrderHistoryEntry, PnlSummary } from '@/lib/types';

const E18 = 10n ** 18n;
let address: string | undefined = '0xTraderAddress000000000000000000000000';
let limitOrders: LimitOrderSummary[] = [];
let orderHistory: OrderHistoryEntry[] = [];
let fees: FeeCharge[] = [];
let pnl: PnlSummary | undefined;

vi.mock('wagmi', () => ({ useAccount: () => ({ address }) }));
vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [{ pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x0', maxLeverage: '100.00', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } }],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useAccountHistory', () => ({
  useLimitOrders: () => ({ limitOrders, loading: false, error: null }),
  useOrderHistory: () => ({ orders: orderHistory, loading: false, error: null }),
  useFees: () => ({ fees, loading: false, error: null }),
  usePnl: () => ({ pnl, loading: false, error: null }),
}));
const actions = {
  pending: null,
  updateLimitOrder: vi.fn(async () => ({})),
  cancelLimitOrder: vi.fn(async () => ({})),
};
vi.mock('@/hooks/useTradingActions', () => ({ useTradingActions: () => actions }));

const limitBuy: LimitOrderSummary = {
  pairIndex: 0,
  index: 2,
  orderType: 'LIMIT',
  buy: true,
  collateral: '100.000000',
  leverage: '10.00',
  triggerPrice: '60000.000000000000000000',
  tp: '0.000000000000000000',
  sl: '0.000000000000000000',
  placedAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
};

beforeEach(() => {
  address = '0xTraderAddress000000000000000000000000';
  limitOrders = [];
  orderHistory = [];
  fees = [];
  pnl = undefined;
  actions.updateLimitOrder.mockClear();
  actions.cancelLimitOrder.mockClear();
});

describe('<LimitOrdersList>', () => {
  it('asks for a wallet, then says when there is nothing resting', () => {
    address = undefined;
    const { unmount } = render(<LimitOrdersList />);
    expect(screen.getByText('Connect your wallet.')).toBeInTheDocument();
    unmount();
    address = '0xTraderAddress000000000000000000000000';
    render(<LimitOrdersList />);
    expect(screen.getByTestId('no-limit-orders')).toBeInTheDocument();
  });

  it('lists a resting order with its type, trigger and margin', () => {
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    const row = screen.getByTestId('limit-order-row-0-2');
    expect(row).toHaveTextContent('Limit buy');
    expect(row).toHaveTextContent('60,000.00');
    expect(row).toHaveTextContent('100.00 USDW');
    expect(row).toHaveTextContent('— / —');
  });

  it('cancels the order by its slot', async () => {
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    fireEvent.click(screen.getByTestId('limit-cancel-0-2'));
    await waitFor(() => expect(actions.cancelLimitOrder).toHaveBeenCalledWith(0, 2));
  });

  it('updates trigger, TP and SL together', async () => {
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    fireEvent.click(screen.getByTestId('limit-edit-0-2'));
    fireEvent.change(screen.getByTestId('limit-trigger-input-0-2'), { target: { value: '59000' } });
    fireEvent.change(screen.getByTestId('limit-tp-input-0-2'), { target: { value: '65000' } });
    fireEvent.change(screen.getByTestId('limit-sl-input-0-2'), { target: { value: '57000' } });
    fireEvent.click(screen.getByTestId('limit-save-0-2'));
    await waitFor(() =>
      expect(actions.updateLimitOrder).toHaveBeenCalledWith(0, 2, 59_000n * E18, 65_000n * E18, 57_000n * E18),
    );
  });

  it('refuses a TP on the wrong side of the new trigger', () => {
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    fireEvent.click(screen.getByTestId('limit-edit-0-2'));
    fireEvent.change(screen.getByTestId('limit-tp-input-0-2'), { target: { value: '50000' } });
    expect(screen.getByTestId('limit-save-0-2')).toBeDisabled();
    expect(screen.getByText('Take profit must be above the entry price.')).toBeInTheDocument();
  });

  it('refuses a TP past the +900% cap for the order’s leverage', () => {
    // 10x, trigger 60,000 → the cap sits at +900% = 114,000. A 200,000 TP is above the trigger,
    // so the wrong-side rule is happy, but the contract would clamp it on fill — refuse it here.
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    fireEvent.click(screen.getByTestId('limit-edit-0-2'));
    fireEvent.change(screen.getByTestId('limit-tp-input-0-2'), { target: { value: '200000' } });
    expect(screen.getByTestId('limit-save-0-2')).toBeDisabled();
    expect(screen.getByText(/900%/)).toBeInTheDocument();
  });

  it('refuses an empty trigger', () => {
    limitOrders = [limitBuy];
    render(<LimitOrdersList />);
    fireEvent.click(screen.getByTestId('limit-edit-0-2'));
    fireEvent.change(screen.getByTestId('limit-trigger-input-0-2'), { target: { value: '' } });
    expect(screen.getByTestId('limit-save-0-2')).toBeDisabled();
  });
});

describe('<OrderHistoryList>', () => {
  it('labels each order kind and explains a cancellation', () => {
    const base = {
      source: 'order' as const, orderId: null, orderType: null, pairIndex: 0, tradeId: null, index: null, buy: null,
      collateral: null, leverage: null, price: null, tp: null, sl: null, cancelReason: null, resolvedAt: null, txHash: '0x1',
    };
    orderHistory = [
      { ...base, id: '1', orderId: '1', kind: 'open', orderType: 'MARKET', buy: true, collateral: '100.000000', price: '65001.000000000000000000', status: 'executed', requestedAt: 1_790_000_000 },
      { ...base, id: '2', orderId: '2', kind: 'automation_close', status: 'cancelled', cancelReason: 'NOT_HIT', requestedAt: 1_790_000_100 },
      { ...base, id: 'lim-3', source: 'limit', kind: 'limit_cancelled', orderType: 'STOP', buy: false, status: 'cancelled', requestedAt: 1_790_000_200 },
      { ...base, id: '4', orderId: '4', kind: 'close', status: 'timeout', requestedAt: 1_790_000_300 },
    ];
    render(<OrderHistoryList />);
    expect(screen.getByTestId('order-history-row-1')).toHaveTextContent('Market open');
    expect(screen.getByTestId('order-history-row-1')).toHaveTextContent('65,001.00');
    expect(screen.getByTestId('order-history-row-1')).toHaveTextContent('Executed');
    expect(screen.getByTestId('order-history-row-2')).toHaveTextContent('TP / SL / liquidation');
    expect(screen.getByTestId('order-history-row-2')).toHaveTextContent('Cancelled · NOT_HIT');
    expect(screen.getByTestId('order-history-row-lim-3')).toHaveTextContent('Stop · Cancelled');
    expect(screen.getByTestId('order-history-row-lim-3')).toHaveTextContent('Short');
    expect(screen.getByTestId('order-history-row-4')).toHaveTextContent('Timed out');
  });

  it('says so when there is no history', () => {
    render(<OrderHistoryList />);
    expect(screen.getByTestId('no-order-history')).toBeInTheDocument();
  });
});

describe('<FundingHistoryList>', () => {
  it('shows only funding and rollover, a cost negative and a receipt positive', () => {
    fees = [
      { id: 'a', tradeId: '1', pairIndex: 0, kind: 'funding', amount: '1.500000', at: 1_790_000_000, txHash: '0x1' },
      { id: 'b', tradeId: '1', pairIndex: 0, kind: 'funding', amount: '-0.250000', at: 1_790_000_000, txHash: '0x1' },
      { id: 'c', tradeId: '1', pairIndex: 0, kind: 'rollover', amount: '0.100000', at: 1_790_000_000, txHash: '0x1' },
      { id: 'd', tradeId: '1', pairIndex: 0, kind: 'dev', amount: '3.000000', at: 1_790_000_000, txHash: '0x1' },
    ];
    render(<FundingHistoryList />);
    expect(screen.getByTestId('funding-row-a')).toHaveTextContent('-1.50 USDW');
    expect(screen.getByTestId('funding-row-b')).toHaveTextContent('+0.25 USDW');
    expect(screen.getByTestId('funding-row-c')).toHaveTextContent('Rollover');
    expect(screen.queryByTestId('funding-row-d')).not.toBeInTheDocument();
  });

  it('explains an empty history rather than showing a blank table', () => {
    fees = [{ id: 'd', tradeId: '1', pairIndex: 0, kind: 'dev', amount: '3.000000', at: 1, txHash: '0x1' }];
    render(<FundingHistoryList />);
    expect(screen.getByTestId('no-funding')).toHaveTextContent(/settles when a position closes/);
  });
});

describe('<RealizedPnlPanel>', () => {
  it('shows the totals with a signed, coloured PnL', () => {
    pnl = { realizedPnl: '-12.340000', fees: '7.000000', funding: '-1.500000', trades: 3 };
    render(<RealizedPnlPanel />);
    const total = screen.getByTestId('realized-pnl-total');
    expect(total).toHaveTextContent('-12.34 USDW');
    expect(total).toHaveClass('neg');
    expect(screen.getByTestId('realized-pnl')).toHaveTextContent('7.00 USDW');
    expect(screen.getByTestId('realized-pnl')).toHaveTextContent('3');
  });
});
