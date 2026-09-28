import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrdersList } from '@/components/OrdersList';
import type { OrderSummary } from '@/lib/types';

// The order fixtures below carry money as /orders emits it: human decimal strings with
// their full fraction digits ("100.000000" is 100 USDW at 6 decimals, "10.00" is 10x at
// PRECISION_2), never the raw scaled integers the contract stores.
let ordersState: OrderSummary[] = [];

/** Chain head the reclaim countdown compares against. `marketOrdersTimeout` is 30 blocks
 * on 1874, so a request at 7437171 unlocks at 7437201. */
let headBlock = 7_437_400n;
const reclaimMock = vi.fn(async (_config: { functionName: string; args: unknown[] }) => '0xreclaim' as const);

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  useBlockNumber: () => ({ data: headBlock }),
  useReadContract: () => ({ data: 30 }), // marketOrdersTimeout
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) }),
  useWriteContract: () => ({ writeContractAsync: reclaimMock, isPending: false }),
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
        requestedAtBlock: '7437171',
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
        requestedAtBlock: '7437171',
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
        requestedAtBlock: '7437171',
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
        requestedAtBlock: '7437171',
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

  /**
   * `openTrade` takes the collateral up front. When a keeper never delivers a report the
   * order stays pending and that money is locked in TradingStorage — and only the trader
   * can call `openTradeMarketTimeout` to get it back. With no control for it in the app,
   * a real outage left an order pending with 250 USDW behind it and no way to recover.
   */
  it('offers to reclaim the collateral once the timeout has passed', async () => {
    headBlock = 7_438_551n; // well past 7437171 + 30
    reclaimMock.mockClear();
    ordersState = [
      {
        orderId: '8',
        pairIndex: 0,
        kind: 'open',
        buy: null,
        collateral: null,
        leverage: null,
        requestedAt: 1789033539,
        requestedAtBlock: '7437171',
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    render(<OrdersList />);

    const button = screen.getByTestId('order-reclaim-8');
    fireEvent.click(button);
    await waitFor(() => expect(reclaimMock).toHaveBeenCalled());
    expect(reclaimMock).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'openTradeMarketTimeout', args: [8n] }),
    );
  });

  it('counts down instead of offering a reclaim the contract would reject', () => {
    headBlock = 7_437_181n; // 20 blocks short of 7437171 + 30
    ordersState = [
      {
        orderId: '9',
        pairIndex: 0,
        kind: 'open',
        buy: null,
        collateral: null,
        leverage: null,
        requestedAt: 1789033539,
        requestedAtBlock: '7437171',
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    render(<OrdersList />);

    expect(screen.queryByTestId('order-reclaim-9')).not.toBeInTheDocument();
    expect(screen.getByTestId('order-reclaim-wait-9')).toHaveTextContent('20 blocks');
  });

  it('releases a timed-out CLOSE with closeTradeMarketTimeout, not the open refund', async () => {
    headBlock = 7_438_551n;
    reclaimMock.mockClear();
    ordersState = [
      {
        orderId: '10',
        pairIndex: 0,
        kind: 'close',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 1789033539,
        requestedAtBlock: '7437171',
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: '5',
      },
    ];
    render(<OrdersList />);
    const button = screen.getByTestId('order-reclaim-10');
    expect(button).toHaveTextContent('Release position');
    fireEvent.click(button);
    await waitFor(() =>
      expect(reclaimMock).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'closeTradeMarketTimeout', args: [10n, false] }),
      ),
    );
    expect(await screen.findByTestId('order-reclaimed-10')).toHaveTextContent(/close it again/);
  });

  it('never offers a reclaim for an automation order, which the trader cannot time out', () => {
    headBlock = 7_438_551n;
    ordersState = [
      {
        orderId: '11',
        pairIndex: 0,
        kind: 'automation_close',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 1789033539,
        requestedAtBlock: '7437171',
        status: 'pending',
        resolvedAt: null,
        cancelReason: null,
        tradeId: '5',
      },
    ];
    render(<OrdersList />);
    expect(screen.queryByTestId('order-reclaim-11')).not.toBeInTheDocument();
  });

  it('renders a no-orders message when there are none', () => {
    ordersState = [];
    render(<OrdersList />);
    expect(screen.getByTestId('no-orders')).toBeInTheDocument();
  });
});
