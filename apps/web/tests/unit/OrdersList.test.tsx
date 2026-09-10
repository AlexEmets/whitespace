import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrdersList } from '@/components/OrdersList';
import type { OrderSummary } from '@/lib/types';

// The order fixtures below carry money as /orders emits it: human decimal strings with
// their full fraction digits ("100.000000" is 100 USDW at 6 decimals, "10.00" is 10x at
// PRECISION_2), never the raw scaled integers the contract stores.
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
        kind: 'open',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 0,
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-status-1')).toHaveTextContent(/pending/i);
    expect(screen.getByTestId('order-status-1')).not.toHaveTextContent(/executed/i);
  });

  /**
   * The shape `/orders/:address` really returns for an open order that has not been
   * executed yet: no side, no collateral, no leverage, because
   * `MarketOpenOrderInitiated` carries no Trade payload.
   *
   * This row used to crash the whole page — `<Money value={null}>` throws
   * "money: not a decimal number: null" — and, one cell earlier, silently rendered a
   * pending LONG as "Short" via `o.buy ? 'Long' : 'Short'`. The second is the worse of
   * the two: it did not fail, it lied.
   */
  it('renders a pending open order whose side and size are not known yet, without crashing or guessing', () => {
    ordersState = [
      {
        orderId: '8',
        pairIndex: 0,
        kind: 'open',
        buy: null,
        collateral: null,
        leverage: null,
        requestedAt: 1789033539,
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    render(<OrdersList />);

    const row = screen.getByTestId('order-row-8');
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId('order-status-8')).toHaveTextContent(/pending/i);
    // Neither "Long" nor "Short" — the side genuinely is not known yet.
    expect(row).not.toHaveTextContent(/Long/);
    expect(row).not.toHaveTextContent(/Short/);
    expect(row).toHaveTextContent('—');
  });

  it('shows an executed order as executed', () => {
    ordersState = [
      {
        orderId: '2',
        pairIndex: 0,
        kind: 'open',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 0,
        status: 'executed',
        resolvedAt: 10,
        cancelReason: null,
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
        kind: 'open',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 0,
        status: 'cancelled',
        resolvedAt: 10,
        cancelReason: 'SLIPPAGE',
        tradeId: null,
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
