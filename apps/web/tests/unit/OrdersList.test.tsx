import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrdersList } from '@/components/OrdersList';
import type { OrderSummary } from '@/lib/types';

// The order fixtures below carry money as /orders emits it: human decimal strings with
// their full fraction digits ("100.000000" is 100 USDW at 6 decimals, "10.00" is 10x at
// PRECISION_2), never the raw scaled integers the contract stores.
let ordersState: OrderSummary[] = [];
let staleState = false;
/** What TradingStorage reports as still pending, for orders the API has not indexed. */
const chainState: { ids: bigint[]; details: { status: string; result: unknown }[] } = { ids: [], details: [] };

/** Chain head the reclaim countdown compares against. `marketOrdersTimeout` is 30 blocks
 * on 1874, so a request at 7437171 unlocks at 7437201. */
let headBlock = 7_437_400n;
const reclaimMock = vi.fn(async (_config: { functionName: string; args: unknown[] }) => '0xreclaim' as const);

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xTraderAddress000000000000000000000000', isConnected: true }),
  useBlockNumber: () => ({ data: headBlock }),
  useReadContract: ({ functionName }: { functionName: string }) =>
    functionName === 'getPendingOrderIds' ? { data: chainState.ids } : { data: 30 }, // marketOrdersTimeout
  useReadContracts: () => ({ data: chainState.details }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) }),
  useWriteContract: () => ({ writeContractAsync: reclaimMock, isPending: false }),
  // Already on 1874: the testnet guard (useTestnetWriteContract) has nothing to switch.
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
}));

vi.mock('@/hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [{ pairIndex: 0, from: 'BTC', to: 'USD', feedId: '0x', maxLeverage: '100.00', maxOpenInterest: '0', openInterest: { long: '0', short: '0' } }],
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useOrders', () => ({
  useOrders: () => ({ orders: ordersState, error: null, stale: staleState, loading: false, refetch: vi.fn() }),
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
        expired: false,
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
        expired: false,
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
        expired: false,
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
      expect.objectContaining({ functionName: 'openTradeMarketTimeout', args: [8n], chainId: 1874 }),
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
        expired: true,
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
        expired: false,
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
    expect(await screen.findByTestId('order-reclaimed-10')).toHaveTextContent('Released');
  });

  /**
   * Past the fill window, "Pending — waiting for keeper" is a lie: no report will ever
   * arrive. The status reads "Expired", and because a market order still holds the trader's
   * collateral the reclaim control stays alongside it.
   */
  it('shows an expired market order as expired, still with the reclaim control', () => {
    headBlock = 7_438_551n; // past the reclaim timeout too
    ordersState = [
      {
        orderId: '12',
        pairIndex: 0,
        kind: 'open',
        buy: null,
        collateral: null,
        leverage: null,
        requestedAt: 1789033539,
        requestedAtBlock: '7437171',
        status: 'pending',
        expired: true,
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-status-12')).toHaveTextContent(/expired/i);
    expect(screen.getByTestId('order-status-12')).not.toHaveTextContent(/waiting for keeper/i);
    expect(screen.getByTestId('order-reclaim-12')).toBeInTheDocument();
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
        expired: false,
        resolvedAt: null,
        cancelReason: null,
        tradeId: '5',
      },
    ];
    render(<OrdersList />);
    expect(screen.queryByTestId('order-reclaim-11')).not.toBeInTheDocument();
  });

  const base: OrderSummary = {
    orderId: '50',
    pairIndex: 0,
    kind: 'open',
    buy: true,
    collateral: '100.000000',
    leverage: '10.00',
    requestedAt: 0,
    requestedAtBlock: '7437171',
    status: 'pending',
    expired: false,
    resolvedAt: null,
    cancelReason: null,
    tradeId: null,
  };

  it('says an expired remove-margin request lapsed instead of waiting forever', () => {
    ordersState = [{ ...base, kind: 'remove_collateral', expired: true }];
    render(<OrdersList />);
    expect(screen.getByTestId('order-lapsed-50')).toHaveTextContent(/Lapsed/);
    expect(screen.getByTestId('order-row-50')).not.toHaveTextContent(/Pending/);
  });

  it('still says waiting for a remove-margin request inside its window', () => {
    ordersState = [{ ...base, kind: 'remove_collateral', expired: false }];
    render(<OrdersList />);
    expect(screen.queryByTestId('order-lapsed-50')).toBeNull();
    expect(screen.getByTestId('order-status-50')).toHaveTextContent('Pending');
    expect(screen.getByTestId('order-status-50').querySelector('.spinner')).not.toBeNull();
  });

  it('keeps the orders and their reclaim control on screen when a refresh fails', () => {
    ordersState = [{ ...base, expired: true, requestedAtBlock: '1' }];
    staleState = true;
    render(<OrdersList />);
    expect(screen.getByTestId('orders-stale')).toBeInTheDocument();
    expect(screen.getByTestId('order-reclaim-50')).toBeInTheDocument();
    staleState = false;
  });

  // The 2026-10-10 case: the indexer was two days behind, the API listed nothing, and two closes
  // the keeper had missed showed no Release anywhere.
  it('offers the release for a close that is pending on chain but missing from the API', () => {
    ordersState = [];
    chainState.ids = [505n];
    chainState.details = [
      {
        status: 'success',
        result: [7437000n, 0n, 0, { collateral: 0n, trader: '0xTraderAddress000000000000000000000000', leverage: 0, pairIndex: 0, buy: true }, 10000],
      },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-row-505')).toBeInTheDocument();
    expect(screen.getByTestId('order-reclaim-505')).toHaveTextContent('Release position');
    chainState.ids = [];
    chainState.details = [];
  });

  it('does not duplicate an order the API already lists', () => {
    ordersState = [{ ...base, orderId: '505', kind: 'close' }];
    chainState.ids = [505n];
    chainState.details = [
      { status: 'success', result: [7437000n, 0n, 0, { collateral: 0n, trader: '0xTraderAddress000000000000000000000000', leverage: 0, pairIndex: 0, buy: true }, 10000] },
    ];
    render(<OrdersList />);
    expect(screen.getAllByTestId('order-row-505')).toHaveLength(1);
    chainState.ids = [];
    chainState.details = [];
  });

  it('renders nothing when there are no orders, so the tab can say "No open orders" once', () => {
    ordersState = [];
    const { container } = render(<OrdersList />);
    expect(container).toBeEmptyDOMElement();
  });

  // Filled, cancelled and reclaimed orders are not open orders: they are in Order history, and
  // a close's outcome shows on its position row. Listing them here put "Filled" rows under the
  // resting limit orders, as a second table in the Open orders tab.
  it('lists only orders still in flight, never resolved ones', () => {
    const resolved = (orderId: string, status: OrderSummary['status'], cancelReason: string | null = null): OrderSummary => ({
      orderId,
      pairIndex: 0,
      kind: 'close',
      buy: true,
      collateral: '100.000000',
      leverage: '10.00',
      requestedAt: 0,
      requestedAtBlock: '7437171',
      status,
      expired: false,
      resolvedAt: 10,
      cancelReason,
      tradeId: '7',
    });
    ordersState = [
      { ...resolved('70', 'pending'), resolvedAt: null },
      resolved('71', 'executed'),
      resolved('72', 'cancelled', 'SLIPPAGE'),
      resolved('73', 'timeout'),
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('order-row-70')).toBeInTheDocument();
    for (const id of ['71', '72', '73']) expect(screen.queryByTestId(`order-row-${id}`)).toBeNull();
  });

  it('renders nothing when every order has resolved', () => {
    ordersState = [
      {
        orderId: '74',
        pairIndex: 0,
        kind: 'open',
        buy: true,
        collateral: '100.000000',
        leverage: '10.00',
        requestedAt: 0,
        requestedAtBlock: '7437171',
        status: 'executed',
        expired: false,
        resolvedAt: 10,
        cancelReason: null,
        tradeId: '7',
      },
    ];
    const { container } = render(<OrdersList />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels a limit/stop fill in words, not as automation_open', () => {
    ordersState = [
      {
        orderId: '75',
        pairIndex: 0,
        kind: 'automation_open',
        buy: true,
        collateral: '448.640000',
        leverage: '10.00',
        requestedAt: 0,
        requestedAtBlock: '7437390',
        status: 'pending',
        expired: false,
        resolvedAt: null,
        cancelReason: null,
        tradeId: null,
      },
    ];
    headBlock = 7_437_400n;
    render(<OrdersList />);
    expect(screen.getByTestId('order-row-75')).toHaveTextContent('Limit / stop fill');
    expect(screen.getByTestId('order-row-75')).not.toHaveTextContent('automation_open');
  });
});

describe('<OrdersList> — order details, not keeper prose', () => {
  const pending: OrderSummary = {
    orderId: '60',
    pairIndex: 0,
    kind: 'close',
    buy: false,
    collateral: '250.000000',
    leverage: '20.00',
    requestedAt: 1791724552,
    requestedAtBlock: '7437390',
    status: 'pending',
    expired: false,
    resolvedAt: null,
    cancelReason: null,
    tradeId: null,
  };

  it('shows market, type, side, collateral and leverage for an order', () => {
    headBlock = 7_437_400n;
    ordersState = [pending];
    render(<OrdersList />);
    const row = screen.getByTestId('order-row-60');
    for (const text of ['BTC-PERP', 'Market close', 'Short', '250.00', '20.00x']) expect(row).toHaveTextContent(text);
  });

  it('shows a pending order as a spinner and one word, with no reclaim countdown while it can still fill', () => {
    headBlock = 7_437_400n;
    ordersState = [pending];
    render(<OrdersList />);
    const status = screen.getByTestId('order-status-60');
    expect(status).toHaveTextContent(/^Pending$/);
    expect(status.querySelector('.spinner')).not.toBeNull();
    expect(screen.queryByTestId('order-reclaim-wait-60')).toBeNull();
    expect(screen.getByTestId('order-row-60')).not.toHaveTextContent(/keeper/i);
  });

  it('never mentions the keeper on any row', () => {
    headBlock = 7_437_400n;
    ordersState = [
      pending,
      { ...pending, orderId: '61', expired: true },
      { ...pending, orderId: '62', status: 'timeout' },
      { ...pending, orderId: '63', status: 'cancelled', cancelReason: 'SLIPPAGE' },
      { ...pending, orderId: '64', kind: 'remove_collateral', expired: true },
    ];
    render(<OrdersList />);
    expect(screen.getByTestId('orders-table')).not.toHaveTextContent(/keeper/i);
  });
});
