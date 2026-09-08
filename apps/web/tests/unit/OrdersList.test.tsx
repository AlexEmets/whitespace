import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrdersList } from '@/components/OrdersList';
import type { OrderSummary } from '@/lib/types';

let ordersState: OrderSummary[] = [];

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
}));

vi.mock('@/hooks/useOrders', () => ({
  useOrders: () => ({ orders: ordersState, error: null, loading: false, refetch: vi.fn() }),
}));

describe('<OrdersList> — two-phase order lifecycle (design §5.1/§7)', () => {
  it('shows a pending order as pending, not as filled', () => {
    ordersState = [
      {
        orderId: '1',
        pairIndex: 0,
        trader: '0xabc',
        buy: true,
        collateral: '100000000',
        leverage: '1000',
        requestedAt: 0,
        status: 'pending',
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-status-1')).toHaveTextContent(/pending/i);
    expect(screen.getByTestId('order-status-1')).not.toHaveTextContent(/executed/i);
  });

  it('shows an executed order as executed', () => {
    ordersState = [
      {
        orderId: '2',
        pairIndex: 0,
        trader: '0xabc',
        buy: true,
        collateral: '100000000',
        leverage: '1000',
        requestedAt: 0,
        status: 'executed',
        tradeId: '7',
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-status-2')).toHaveTextContent(/executed/i);
  });

  it('shows a cancelled order with its CancelReason explained, not just "cancelled"', () => {
    ordersState = [
      {
        orderId: '3',
        pairIndex: 0,
        trader: '0xabc',
        buy: true,
        collateral: '100000000',
        leverage: '1000',
        requestedAt: 0,
        status: 'cancelled',
        cancelReason: 'SLIPPAGE',
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-status-3')).toHaveTextContent(/cancelled/i);
    expect(screen.getByTestId('order-row-3')).toHaveTextContent(/SLIPPAGE/);
    expect(screen.getByTestId('order-row-3')).toHaveTextContent(/refunded/i);
  });

  it('renders a no-orders message when there are none', () => {
    ordersState = [];
    render(<OrdersList />);
    expect(screen.getByTestId('no-orders')).toBeInTheDocument();
  });
});
