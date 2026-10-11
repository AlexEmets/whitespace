import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTabs } from '@/components/terminal/TerminalTabs';

let ordersState: { status: string }[] = [];
let limitState: unknown[] = [];

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xTraderAddress000000000000000000000000' }) }));
vi.mock('@/hooks/usePositions', () => ({ usePositions: () => ({ positions: [] }) }));
vi.mock('@/hooks/useChainPendingOrders', () => ({ useOrdersWithChain: () => ({ orders: ordersState }) }));
vi.mock('@/hooks/useAccountHistory', () => ({ useLimitOrders: () => ({ limitOrders: limitState }) }));
vi.mock('@/components/OrdersList', () => ({ OrdersList: () => <div data-testid="market-orders" /> }));
vi.mock('@/components/PositionsList', () => ({ PositionsList: () => null }));
vi.mock('@/components/FillsList', () => ({ FillsList: () => null }));
vi.mock('@/components/terminal/AccountTables', () => ({
  LimitOrdersList: () => <div data-testid="limit-orders" />,
  OrderHistoryList: () => null,
  FundingHistoryList: () => null,
  RealizedPnlPanel: () => null,
}));

function openOrdersTab() {
  render(<TerminalTabs />);
  fireEvent.click(screen.getByTestId('tab-orders'));
}

describe('<TerminalTabs> — Open orders', () => {
  beforeEach(() => {
    ordersState = [];
    limitState = [];
  });

  it('says "No open orders" once when nothing is resting or in flight, even with resolved market orders', () => {
    ordersState = [{ status: 'executed' }, { status: 'cancelled' }];
    openOrdersTab();
    expect(screen.getByTestId('no-open-orders')).toHaveTextContent('No open orders.');
    expect(screen.queryByTestId('limit-orders')).toBeNull();
    expect(screen.queryByTestId('market-orders')).toBeNull();
    expect(screen.queryByTestId('tab-count-orders')).toBeNull();
  });

  it('shows an in-flight market order without an empty limit-orders table or message above it', () => {
    ordersState = [{ status: 'pending' }, { status: 'executed' }];
    openOrdersTab();
    expect(screen.getByTestId('market-orders')).toBeInTheDocument();
    expect(screen.queryByTestId('limit-orders')).toBeNull();
    expect(screen.queryByTestId('no-open-orders')).toBeNull();
    expect(screen.getByTestId('tab-count-orders')).toHaveTextContent('1');
  });

  it('shows resting limit orders, and counts them with in-flight market orders', () => {
    limitState = [{}, {}];
    ordersState = [{ status: 'pending' }];
    openOrdersTab();
    expect(screen.getByTestId('limit-orders')).toBeInTheDocument();
    expect(screen.getByTestId('tab-count-orders')).toHaveTextContent('3');
  });
});
