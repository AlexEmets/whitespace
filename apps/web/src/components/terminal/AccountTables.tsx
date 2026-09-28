'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useFees, useLimitOrders, useOrderHistory, usePnl } from '@/hooks/useAccountHistory';
import { useMarkets } from '@/hooks/useMarkets';
import { useTradingActions } from '@/hooks/useTradingActions';
import { explainCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { marketLabel } from '@/lib/markets';
import { formatLeverage, formatMoney, parseHumanDecimal, priceToRaw } from '@/lib/money';
import { tpSlErrors } from '@/lib/orderRules';
import type { FeeCharge, LimitOrderSummary, MarketSummary } from '@/lib/types';
import { describeTxError } from '@/lib/tx';
import { formatUtcMinute as formatTime } from '@/components/portfolio/formatTime';

function Gate({ children, empty, testId }: { children: React.ReactNode; empty: string | null; testId: string }) {
  const { address } = useAccount();
  if (!address) return <p>Connect your wallet.</p>;
  if (empty) return <p data-testid={testId}>{empty}</p>;
  return <>{children}</>;
}

function parsePrice(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseHumanDecimal(text, PRICE_DECIMALS_NUM);
  } catch {
    return null;
  }
}

function LimitOrderRow({ order, market }: { order: LimitOrderSummary; market: MarketSummary | undefined }) {
  const actions = useTradingActions();
  const [editing, setEditing] = useState(false);
  const [trigger, setTrigger] = useState(order.triggerPrice);
  const [tp, setTp] = useState(priceToRaw(order.tp) > 0n ? order.tp : '');
  const [sl, setSl] = useState(priceToRaw(order.sl) > 0n ? order.sl : '');
  const [error, setError] = useState<string | null>(null);

  const triggerRaw = parsePrice(trigger);
  const tpRaw = parsePrice(tp);
  const slRaw = parsePrice(sl);
  const rules =
    triggerRaw && tpRaw !== null && slRaw !== null
      ? tpSlErrors({ buy: order.buy, entryPrice: triggerRaw, tp: tpRaw, sl: slRaw })
      : { tp: null, sl: null };
  const invalid = !triggerRaw || tpRaw === null || slRaw === null || rules.tp !== null || rules.sl !== null;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setEditing(false);
    } catch (err) {
      setError(describeTxError(err));
    }
  }

  const id = `${order.pairIndex}-${order.index}`;
  return (
    <>
      <tr data-testid={`limit-order-row-${id}`}>
        <td>
          <span className={`side-bar ${order.buy ? 'long' : 'short'}`} aria-hidden="true" />
          {marketLabel(market, order.pairIndex)} <span className="row-leverage">{formatLeverage(order.leverage)}</span>
        </td>
        <td>{order.orderType === 'LIMIT' ? 'Limit' : 'Stop'} {order.buy ? 'buy' : 'sell'}</td>
        <td>{formatMoney(order.triggerPrice, PRICE_DECIMALS_NUM)}</td>
        <td>{formatMoney(order.collateral, COLLATERAL_DECIMALS)} USDW</td>
        <td>
          {priceToRaw(order.tp) > 0n ? formatMoney(order.tp, PRICE_DECIMALS_NUM) : '—'} /{' '}
          {priceToRaw(order.sl) > 0n ? formatMoney(order.sl, PRICE_DECIMALS_NUM) : '—'}
        </td>
        <td>{formatTime(order.placedAt)}</td>
        <td>
          <button type="button" data-testid={`limit-edit-${id}`} onClick={() => setEditing((v) => !v)}>
            Edit
          </button>{' '}
          <button
            type="button"
            data-testid={`limit-cancel-${id}`}
            disabled={actions.pending !== null}
            onClick={() => run(() => actions.cancelLimitOrder(order.pairIndex, order.index))}
          >
            Cancel
          </button>
          {error ? <span className="error-text" role="alert"> {error}</span> : null}
        </td>
      </tr>
      {editing ? (
        <tr className="manager-row">
          <td colSpan={7}>
            <div className="position-manager">
              <label>
                Trigger
                <input data-testid={`limit-trigger-input-${id}`} value={trigger} onChange={(e) => setTrigger(e.target.value)} />
              </label>
              <label>
                Take profit
                <input data-testid={`limit-tp-input-${id}`} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="none" />
              </label>
              <label>
                Stop loss
                <input data-testid={`limit-sl-input-${id}`} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="none" />
              </label>
              <button
                type="button"
                data-testid={`limit-save-${id}`}
                disabled={invalid || actions.pending !== null}
                onClick={() => run(() => actions.updateLimitOrder(order.pairIndex, order.index, triggerRaw!, tpRaw!, slRaw!))}
              >
                Save
              </button>
              {rules.tp ? <span className="error-text">{rules.tp}</span> : null}
              {rules.sl ? <span className="error-text">{rules.sl}</span> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Resting LIMIT/STOP entries: they wait on chain until the automation bot triggers them. */
export function LimitOrdersList() {
  const { address } = useAccount();
  const { limitOrders, loading, error } = useLimitOrders(address);
  const { markets } = useMarkets();
  if (address && loading) return <p>Loading orders…</p>;
  if (error) return <p className="error-text">Failed to load resting orders: {error.message}</p>;
  return (
    <Gate empty={limitOrders.length === 0 ? 'No resting limit or stop orders.' : null} testId="no-limit-orders">
      <table className="data-table" data-testid="limit-orders-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Type</th>
            <th>Trigger</th>
            <th>Margin</th>
            <th>TP / SL</th>
            <th>Placed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {limitOrders.map((o) => (
            <LimitOrderRow key={`${o.pairIndex}-${o.index}`} order={o} market={markets.find((m) => m.pairIndex === o.pairIndex)} />
          ))}
        </tbody>
      </table>
    </Gate>
  );
}

const KIND_LABEL: Record<string, string> = {
  open: 'Market open',
  close: 'Market close',
  automation_open: 'Limit / stop fill',
  automation_close: 'TP / SL / liquidation',
  remove_collateral: 'Remove margin',
  limit_placed: 'Placed',
  limit_updated: 'Updated',
  limit_cancelled: 'Cancelled',
  limit_executed: 'Filled',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  executed: 'Executed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
};

/** Every order ever requested, newest first. */
export function OrderHistoryList() {
  const { address } = useAccount();
  const { orders, loading, error } = useOrderHistory(address);
  const { markets } = useMarkets();
  if (address && loading) return <p>Loading order history…</p>;
  if (error) return <p className="error-text">Failed to load order history: {error.message}</p>;
  return (
    <Gate empty={orders.length === 0 ? 'No orders yet.' : null} testId="no-order-history">
      <table className="data-table" data-testid="order-history-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Instrument</th>
            <th>Order</th>
            <th>Side</th>
            <th>Price</th>
            <th>Margin</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} data-testid={`order-history-row-${o.id}`}>
              <td>{formatTime(o.requestedAt)}</td>
              <td>{marketLabel(markets.find((m) => m.pairIndex === o.pairIndex), o.pairIndex)}</td>
              <td>
                {o.source === 'limit' ? `${o.orderType === 'STOP' ? 'Stop' : 'Limit'} · ` : ''}
                {KIND_LABEL[o.kind] ?? o.kind}
              </td>
              <td>{o.buy === null ? '—' : o.buy ? 'Long' : 'Short'}</td>
              <td>{o.price === null ? '—' : formatMoney(o.price, PRICE_DECIMALS_NUM)}</td>
              <td>{o.collateral === null ? '—' : `${formatMoney(o.collateral, COLLATERAL_DECIMALS)} USDW`}</td>
              <td title={o.status === 'cancelled' && o.cancelReason ? explainCancelReason(o.cancelReason) : undefined}>
                {STATUS_LABEL[o.status] ?? o.status}
                {o.status === 'cancelled' && o.cancelReason ? ` · ${o.cancelReason}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Gate>
  );
}

const FUNDING_KINDS = new Set<FeeCharge['kind']>(['funding', 'rollover']);

/** Funding and rollover charged when positions closed. Positive = paid by the trader. */
export function FundingHistoryList() {
  const { address } = useAccount();
  const { fees, loading, error } = useFees(address);
  const { markets } = useMarkets();
  const rows = fees.filter((f) => FUNDING_KINDS.has(f.kind));
  if (address && loading) return <p>Loading funding history…</p>;
  if (error) return <p className="error-text">Failed to load funding history: {error.message}</p>;
  return (
    <Gate empty={rows.length === 0 ? 'No funding charged yet — it settles when a position closes.' : null} testId="no-funding">
      <table className="data-table" data-testid="funding-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Instrument</th>
            <th>Type</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            // Stored as "owed by the trader"; shown with PnL's sign, so a cost is negative.
            const shown = -BigInt(parseHumanDecimal(f.amount, COLLATERAL_DECIMALS));
            return (
              <tr key={f.id} data-testid={`funding-row-${f.id}`}>
                <td>{formatTime(f.at)}</td>
                <td>{f.pairIndex === null ? '—' : marketLabel(markets.find((m) => m.pairIndex === f.pairIndex), f.pairIndex)}</td>
                <td>{f.kind === 'funding' ? 'Funding' : 'Rollover'}</td>
                <td className={shown >= 0n ? 'pos' : 'neg'}>{formatMoney(shown, COLLATERAL_DECIMALS, { signDisplay: true })} USDW</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Gate>
  );
}

/** Totals over closed positions. */
export function RealizedPnlPanel() {
  const { address } = useAccount();
  const { pnl, loading, error } = usePnl(address);
  if (!address) return <p>Connect your wallet.</p>;
  if (loading) return <p>Loading…</p>;
  if (error || !pnl) return <p className="error-text">Failed to load realised PnL{error ? `: ${error.message}` : ''}</p>;
  const realized = parseHumanDecimal(pnl.realizedPnl, COLLATERAL_DECIMALS);
  return (
    <dl className="pnl-summary" data-testid="realized-pnl">
      <div>
        <dt>Realised PnL</dt>
        <dd className={realized >= 0n ? 'pos' : 'neg'} data-testid="realized-pnl-total">
          {formatMoney(realized, COLLATERAL_DECIMALS, { signDisplay: true })} USDW
        </dd>
      </div>
      <div>
        <dt>Fees paid</dt>
        <dd>{formatMoney(pnl.fees, COLLATERAL_DECIMALS)} USDW</dd>
      </div>
      <div>
        <dt>Funding &amp; rollover</dt>
        <dd>{formatMoney(pnl.funding, COLLATERAL_DECIMALS, { signDisplay: true })} USDW</dd>
      </div>
      <div>
        <dt>Closed trades</dt>
        <dd>{pnl.trades}</dd>
      </div>
    </dl>
  );
}
