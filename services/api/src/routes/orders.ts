import { query } from '../db.js';
import { collateral, leverage as fmtLeverage, id as fmtId } from '../format.js';
import type { RouteResult, Handler } from '../router.js';

type OrderRow = {
  order_id: string;
  kind: string;
  pair_index: number;
  trade_id: string | null;
  index: number | null;
  buy: boolean | null;
  collateral: string | null;
  leverage: number | null;
  status: string;
  requested_at: number;
  requested_at_block: string;
  resolved_at: number | null;
  cancel_reason: string | null;
};

/** How far back a resolved order stays visible. Long enough that a trader who submitted
 * an order and looked away still finds out what happened to it; short enough that this
 * is a lifecycle view, not an unbounded history (that is what /positions/:address/history
 * is for). */
const RESOLVED_WINDOW_SECONDS = 3600;
const MAX_ORDERS = 50;

// GET /orders/:address -> pending orders, plus those resolved in the last hour.
//
// It used to be pending-only, and that made the order lifecycle unobservable from the
// UI. Both consumers already render all three statuses — OrdersList has labels and a
// cancel-reason column, OpenPositionForm has "Filled" and "Cancelled" branches — but an
// order left the response the instant it stopped being pending, so those branches could
// never be reached. The order-entry panel sat on "Nothing has happened yet" while the
// position it had just opened was visible in the table underneath it. A trader could not
// tell a fill from a cancellation from the panel that submitted it.
//
// `cancel_reason` is selected explicitly for the same reason: both consumers call
// explainCancelReason() on it, and it was never in the payload at all.
//
// Note: 'open' orders don't carry collateral/leverage/buy at request time —
// MarketOpenOrderInitiated doesn't emit the Trade payload, only
// MarketOpenExecuted does (see src/handlers/trading.ts in the indexer). So
// those fields are null for a still-pending open order, and only populated
// for close/remove_collateral orders that recorded them directly.
/** Shared by the REST route and the WebSocket `orders:` channel, so a subscriber and a
 * poller cannot disagree about which orders exist. */
export async function resolveOrders(address: string): Promise<unknown[]> {
  const trader = address.toLowerCase();
  const cutoff = Math.floor(Date.now() / 1000) - RESOLVED_WINDOW_SECONDS;
  const rows = await query<OrderRow>(
    `SELECT * FROM "order"
      WHERE trader = $1
        AND (status = 'pending' OR COALESCE(resolved_at, requested_at) >= $2)
      ORDER BY requested_at DESC
      LIMIT $3`,
    [trader, cutoff, MAX_ORDERS],
  );
  return rows.map((r) => ({
    orderId: fmtId(r.order_id),
    kind: r.kind,
    pairIndex: r.pair_index,
    tradeId: fmtId(r.trade_id),
    index: r.index,
    buy: r.buy,
    collateral: collateral(r.collateral),
    leverage: fmtLeverage(r.leverage),
    status: r.status,
    requestedAt: r.requested_at,
    // The BLOCK, not just the timestamp: `OstiumTrading.openTradeMarketTimeout` gates the
    // trader's refund on `block.number >= requestBlock + marketOrdersTimeout`, so a client
    // deciding whether that refund is available yet needs the same unit the contract
    // compares in. Deriving it from a timestamp would be a guess about block time.
    requestedAtBlock: fmtId(r.requested_at_block),
    resolvedAt: r.resolved_at,
    cancelReason: r.cancel_reason,
  }));
}

export const handleOrders: Handler = async (_req, params): Promise<RouteResult> => {
  return { code: 200, body: await resolveOrders(params.address) };
};
