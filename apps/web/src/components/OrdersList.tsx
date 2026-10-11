'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOrdersWithChain } from '@/hooks/useChainPendingOrders';
import { useMarkets } from '@/hooks/useMarkets';
import { useIsReclaimable, useReclaimOrder } from '@/hooks/useReclaimOrder';
import { explainCancelReason, humanizeCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { marketLabelByIndex } from '@/lib/markets';
import { formatLeverage } from '@/lib/money';
import type { OrderSummary } from '@/lib/types';
import { Money } from './Money';
import { Spinner } from './Spinner';
import { describeTxError } from '@/lib/tx';

const KIND_LABEL: Record<string, string> = {
  open: 'Market open',
  close: 'Market close',
  remove_collateral: 'Remove margin',
};

function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The order's state in a word or two; any explanation lives in the tooltip. */
function StatusCell({ order }: { order: OrderSummary }) {
  if (order.status === 'pending') {
    if (order.kind === 'remove_collateral' && order.expired) {
      return (
        <span className="dash" data-testid={`order-lapsed-${order.orderId}`} title="No price report arrived in time. Your margin is unchanged.">
          Lapsed
        </span>
      );
    }
    if (order.expired) {
      return <span title="No price report arrived in time — this order will not fill.">Expired</span>;
    }
    return (
      <span>
        <Spinner label="Waiting for the price report" />
        Pending
      </span>
    );
  }
  if (order.status === 'executed') return <span className="ok-text">Filled</span>;
  if (order.status === 'timeout') return <span>{order.kind === 'close' ? 'Released' : 'Reclaimed'}</span>;
  if (order.status === 'cancelled') {
    return (
      <span className="error-text" title={explainCancelReason(order.cancelReason ?? '')}>
        Cancelled · {humanizeCancelReason(order.cancelReason)}
      </span>
    );
  }
  return <span>{order.status}</span>;
}

/**
 * The escape hatch for an order no price report ever came back for.
 *
 * A pending order is holding the trader's collateral (or, for a close, the position). If no
 * signed report arrives, `openTradeMarketTimeout` / `closeTradeMarketTimeout` undo it — but
 * only the trader can call them, and only after `marketOrdersTimeout` blocks. While that wait
 * runs, the remaining blocks are shown rather than a disabled button with no explanation.
 */
function ActionCell({ order }: { order: OrderSummary }) {
  const { reclaim, isPending } = useReclaimOrder();
  const { reclaimable, blocksRemaining } = useIsReclaimable(order);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (order.status !== 'pending') return null;
  if (done) {
    return <span data-testid={`order-reclaimed-${order.orderId}`}>{order.kind === 'close' ? 'Released' : 'Returned'}</span>;
  }
  if (!reclaimable) {
    // Nothing to do yet while the order can still fill; once it has expired, say when the
    // collateral (or the position) can be taken back.
    if (!order.expired || blocksRemaining === null) return null;
    return (
      <span className="dash" data-testid={`order-reclaim-wait-${order.orderId}`}>
        {order.kind === 'close' ? 'Release' : 'Reclaim'} in {blocksRemaining} block{blocksRemaining === 1 ? '' : 's'}
      </span>
    );
  }

  async function handleReclaim() {
    setError(null);
    try {
      await reclaim(order.orderId, order.kind);
      setDone(true);
    } catch (err) {
      setError(describeTxError(err));
    }
  }

  return (
    <>
      <button type="button" data-testid={`order-reclaim-${order.orderId}`} onClick={handleReclaim} disabled={isPending}>
        {isPending ? 'Sending…' : order.kind === 'close' ? 'Release position' : 'Reclaim collateral'}
      </button>
      {error ? (
        <span role="alert" className="error-text">
          {' '}
          {error}
        </span>
      ) : null}
    </>
  );
}

/**
 * The trader's market orders (design §5.1/§7: a trade is not done when the transaction
 * confirms). A pending order's request is on chain and its price report has not landed yet;
 * it resolves to a fill or to a cancellation with a refund (minus the oracle fee).
 */
export function OrdersList() {
  const { address } = useAccount();
  const { orders, loading, error, stale } = useOrdersWithChain(address);
  const { markets } = useMarkets();

  if (!address) return <p>Connect your wallet to see orders.</p>;
  // Orders still pending on chain are shown even when the API has nothing (down, or behind):
  // their Reclaim / Release is the one control that must always be reachable.
  if (loading && orders.length === 0) return <p>Loading orders…</p>;
  if (error && orders.length === 0) return <p className="error-text">Failed to load orders: {error.message}</p>;
  if (orders.length === 0) return <p data-testid="no-orders">No orders.</p>;

  return (
    <>
      {stale ? (
        <p role="status" className="error-text" data-testid="orders-stale">
          Live data is unavailable right now — showing the last known orders.
        </p>
      ) : null}
      <table className="data-table" data-testid="orders-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Type</th>
            <th>Side</th>
            <th>Collateral</th>
            <th>Leverage</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.orderId} data-testid={`order-row-${o.orderId}`} data-status={o.status}>
              <td>{formatTime(o.requestedAt)}</td>
              <td>{marketLabelByIndex(o.pairIndex, markets)}</td>
              <td>{KIND_LABEL[o.kind] ?? o.kind}</td>
              {/* buy/collateral/leverage are null while an open order is still pending:
                  `MarketOpenOrderInitiated` carries no Trade payload, only `MarketOpenExecuted`
                  does. `<Money value={null}>` throws and `o.buy ? 'Long' : 'Short'` would call
                  a pending long "Short", so an unknown value is an em-dash, never a guess. */}
              <td className={o.buy === null ? 'dash' : o.buy ? 'long' : 'short'}>{o.buy === null ? '—' : o.buy ? 'Long' : 'Short'}</td>
              <td className={o.collateral === null ? 'dash' : ''}>
                {o.collateral === null ? '—' : <Money value={o.collateral} decimals={COLLATERAL_DECIMALS} suffix="USDW" />}
              </td>
              <td className={o.leverage === null ? 'dash' : ''}>{o.leverage === null ? '—' : formatLeverage(o.leverage)}</td>
              <td data-testid={`order-status-${o.orderId}`}>
                <StatusCell order={o} />
              </td>
              <td>
                <ActionCell order={o} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
