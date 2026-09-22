'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOrders } from '@/hooks/useOrders';
import { useIsReclaimable, useReclaimOrder } from '@/hooks/useReclaimOrder';
import { explainCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import type { OrderSummary } from '@/lib/types';
import { Money } from './Money';
import { describeTxError } from '@/lib/tx';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending — waiting for keeper',
  executed: 'Executed',
  cancelled: 'Cancelled',
};

/**
 * The escape hatch for an order the keeper never came back for.
 *
 * A pending order is holding the trader's collateral. If no signed report ever arrives,
 * `openTradeMarketTimeout` returns it in full — but only the trader can call it, and only
 * after `marketOrdersTimeout` blocks. Before this existed the money was simply stuck with
 * no route to it from the product; a keeper outage left an order pending with 250 USDW
 * behind it and nothing on screen even acknowledged the fact.
 *
 * While the wait is still running the countdown is shown rather than a disabled button
 * with no explanation, because "why can't I click this" is the next question otherwise.
 */
function ReclaimCell({ order }: { order: OrderSummary }) {
  const { reclaim, isPending } = useReclaimOrder();
  const { reclaimable, blocksRemaining } = useIsReclaimable(order);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) return <span data-testid={`order-reclaimed-${order.orderId}`}>Collateral returned.</span>;

  if (!reclaimable) {
    if (blocksRemaining === null) return <span className="dash">Waiting for a keeper report…</span>;
    return (
      <span className="dash" data-testid={`order-reclaim-wait-${order.orderId}`}>
        Waiting for a keeper report — reclaimable in {blocksRemaining} block{blocksRemaining === 1 ? '' : 's'}.
      </span>
    );
  }

  async function handleReclaim() {
    setError(null);
    try {
      await reclaim(order.orderId);
      setDone(true);
    } catch (err) {
      setError(describeTxError(err));
    }
  }

  return (
    <>
      <span>No keeper report arrived. </span>
      <button type="button" data-testid={`order-reclaim-${order.orderId}`} onClick={handleReclaim} disabled={isPending}>
        {isPending ? 'Reclaiming…' : 'Reclaim collateral'}
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
 * The two-phase order lifecycle, made explicit (design §5.1/§7): "a trade is not done
 * when the transaction confirms". A pending order here means the on-chain request was
 * accepted but no keeper report has arrived yet; it can still resolve to either an open
 * position or a cancellation with a refund (minus the oracle fee).
 */
export function OrdersList() {
  const { address } = useAccount();
  const { orders, loading, error } = useOrders(address);

  if (!address) return <p>Connect your wallet to see orders.</p>;
  if (loading) return <p>Loading orders…</p>;
  if (error) return <p className="error-text">Failed to load orders: {error.message}</p>;
  if (orders.length === 0) return <p data-testid="no-orders">No orders.</p>;

  return (
    <table className="data-table" data-testid="orders-table">
      <thead>
        <tr>
          <th>Side</th>
          <th>Collateral</th>
          <th>Status</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.orderId} data-testid={`order-row-${o.orderId}`} data-status={o.status}>
            {/* buy/collateral/leverage are null while an open order is still pending:
                `MarketOpenOrderInitiated` does not carry the Trade payload — only
                `MarketOpenExecuted` does (see the indexer's trading handler and the note
                on GET /orders/:address). Rendering them needs care in both directions:
                `<Money value={null}>` throws, and `o.buy ? 'Long' : 'Short'` quietly
                reports a pending LONG as "Short", because null is falsy. An unknown value
                gets the same em-dash the rest of the app uses, never a guess. */}
            <td className={o.buy === null ? 'dash' : ''} title={o.buy === null ? 'Not known until the keeper executes this order' : undefined}>
              {o.buy === null ? '—' : o.buy ? 'Long' : 'Short'}
            </td>
            <td className={o.collateral === null ? 'dash' : ''}>
              {o.collateral === null ? (
                <span title="Not known until the keeper executes this order">—</span>
              ) : (
                <Money value={o.collateral} decimals={COLLATERAL_DECIMALS} suffix="USDW" />
              )}
            </td>
            <td data-testid={`order-status-${o.orderId}`}>{STATUS_LABEL[o.status] ?? o.status}</td>
            <td>
              {o.status === 'cancelled' ? (
                <span className="error-text">
                  {o.cancelReason ?? 'unknown'} — {explainCancelReason(o.cancelReason ?? '')}
                </span>
              ) : null}
              {o.status === 'executed' ? 'Position opened.' : null}
              {o.status === 'pending' ? <ReclaimCell order={o} /> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
