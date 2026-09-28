import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FundingHistoryList,
  LimitOrdersList,
  OrderHistoryList,
  RealizedPnlPanel,
} from '@/components/terminal/AccountTables';
import type { FeeCharge, LimitOrderSummary, OrderSummary, PnlSummary } from '@/lib/types';

const E18 = 10n ** 18n;
let address: string | undefined = '0xTraderAddress000000000000000000000000';
let limitOrders: LimitOrderSummary[] = [];
let orderHistory: OrderSummary[] = [];
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
    orderHistory = [
      { orderId: '1', pairIndex: 0, kind: 'open', buy: true, collateral: '100.000000', leverage: '10.00', requestedAt: 1_790_000_000, requestedAtBlock: '1', status: 'executed', resolvedAt: 1, cancelReason: null, tradeId: '1' },
      { orderId: '2', pairIndex: 0, kind: 'automation_close', buy: false, collateral: null, leverage: null, requestedAt: 1_790_000_100, requestedAtBlock: '2', status: 'cancelled', resolvedAt: 2, cancelReason: 'NOT_HIT', tradeId: null },
    ];
    render(<OrderHistoryList />);
    expect(screen.getByTestId('order-history-row-1')).toHaveTextContent('Market open');
    expect(screen.getByTestId('order-history-row-1')).toHaveTextContent('Executed');
    expect(screen.getByTestId('order-history-row-2')).toHaveTextContent('TP / SL / liquidation');
    expect(screen.getByTestId('order-history-row-2')).toHaveTextContent('Cancelled · NOT_HIT');
    expect(screen.getByTestId('order-history-row-2')).toHaveTextContent('—');
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
