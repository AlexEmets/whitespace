import { query } from '../db.js';
import { collateral, leverage as fmtLeverage, id as fmtId, price as fmtPrice } from '../format.js';
import type { RouteResult, Handler } from '../router.js';
import type { OrderHistoryEntry } from '../types.js';
import { parseAddress, parseLimit, badRequest } from '../validate.js';

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

/**
 * How long a pending order can wait before its price request is unfillable. The keeper
 * must deliver a report whose timestamp matches the request within the contract's report
 * max-age (10 s); once a pending order is older than this it will never fill. 60 s is six
 * times that window — comfortably past a healthy fill, so a still-filling order is never
 * mislabelled, yet tight enough that a dead one clears within a minute.
 *
 * Two consequences, by kind:
 *  - market open/close carry the trader's collateral and can be reclaimed
 *    (openTradeMarketTimeout), so they STAY in the list, flagged `expired`, until reclaimed.
 *  - automation open/close are triggered resting-limit orders: the collateral is on the
 *    limit order, not here, and there is NO per-order recovery path (openTradeMarketTimeout
 *    reverts NoTradeToTimeoutFound). A stale one can never resolve and nothing on chain ever
 *    emits an event to close it out, so it would otherwise sit "waiting for keeper" forever.
 *    Once expired it is dropped from the list — the only way those dead rows leave the UI.
 */
const PENDING_EXPIRY_SECONDS = 60;
const AUTOMATION_KINDS = ['automation_open', 'automation_close'];

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
  const now = Math.floor(Date.now() / 1000);
  const resolvedCutoff = now - RESOLVED_WINDOW_SECONDS;
  const expiryCutoff = now - PENDING_EXPIRY_SECONDS;
  // Keep every pending order EXCEPT an automation order past the fill window — that one can
  // never fill and has no recovery action, so it is dropped rather than shown forever. A
  // market order past the window is kept (it is reclaimable) and merely flagged `expired`.
  const rows = await query<OrderRow>(
    `SELECT * FROM "order"
      WHERE trader = $1
        AND (
          (status = 'pending' AND NOT (kind = ANY($3) AND requested_at < $4))
          OR COALESCE(resolved_at, requested_at) >= $2
        )
      ORDER BY requested_at DESC
      LIMIT $5`,
    [trader, resolvedCutoff, AUTOMATION_KINDS, expiryCutoff, MAX_ORDERS],
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
    // A pending order whose price request is older than the fill window will never fill.
    // For a market order this is the cue to reclaim rather than keep waiting; the UI reads
    // it to replace "waiting for keeper" with "expired". Always false once resolved.
    expired: r.status === 'pending' && r.requested_at < expiryCutoff,
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
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  return { code: 200, body: await resolveOrders(trader) };
};

type HistoryRow = {
  source: 'order' | 'limit';
  id: string;
  order_id: string | null;
  kind: OrderHistoryEntry['kind'];
  order_type: OrderHistoryEntry['orderType'];
  pair_index: number;
  trade_id: string | null;
  index: number | null;
  buy: boolean | null;
  collateral: string | null;
  leverage: number | null;
  price: string | null;
  tp: string | null;
  sl: string | null;
  status: OrderHistoryEntry['status'];
  cancel_reason: string | null;
  requested_at: number;
  resolved_at: number | null;
  tx_hash: string;
};

export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 500;

// GET /orders/:address/history?limit=100 -> OrderHistoryEntry[], every order the trader
// ever requested, newest first. Two sources, one list:
//   - "order": everything that went through the oracle round trip (market open/close,
//     automation open/close, remove collateral), with its final status;
//   - "order_event": limit-order actions, which are synchronous and have no orderId —
//     placed, updated, cancelled — and the fill of a resting order.
// A limit fill therefore appears twice, by design: once as the automation_open order that
// carried it (with the oracle outcome), once as limit_executed (which resting order it was).
export const handleOrdersHistory: Handler = async (_req, params, searchParams): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  const limit = parseLimit(searchParams, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
  if (limit === null) return badRequest(`limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}`);

  const rows = await query<HistoryRow>(
    `(SELECT 'order' AS source, order_id::text AS id, order_id::text AS order_id, kind,
             CASE WHEN kind IN ('open', 'close') THEN 'MARKET' END AS order_type,
             pair_index, trade_id::text AS trade_id, index, buy, collateral::text AS collateral, leverage,
             NULL::text AS price, NULL::text AS tp, NULL::text AS sl,
             status, cancel_reason, requested_at, resolved_at, request_tx_hash AS tx_hash
        FROM "order" WHERE trader = $1
        ORDER BY requested_at DESC LIMIT $2)
     UNION ALL
     (SELECT 'limit', id, order_id::text, kind, order_type,
             pair_index, trade_id::text, index, buy, collateral::text, leverage,
             trigger_price::text, tp::text, sl::text,
             CASE WHEN kind = 'limit_cancelled' THEN 'cancelled' ELSE 'executed' END,
             NULL, at, at, tx_hash
        FROM order_event WHERE trader = $1
        ORDER BY at DESC LIMIT $2)
     ORDER BY requested_at DESC, id DESC
     LIMIT $2`,
    [trader, limit],
  );
  const body: OrderHistoryEntry[] = rows.map((r) => ({
    source: r.source,
    id: r.id,
    orderId: fmtId(r.order_id),
    kind: r.kind,
    orderType: r.order_type,
    pairIndex: r.pair_index,
    tradeId: fmtId(r.trade_id),
    index: r.index,
    buy: r.buy,
    collateral: collateral(r.collateral),
    leverage: fmtLeverage(r.leverage),
    price: fmtPrice(r.price),
    tp: fmtPrice(r.tp),
    sl: fmtPrice(r.sl),
    status: r.status,
    cancelReason: r.cancel_reason,
    requestedAt: r.requested_at,
    resolvedAt: r.resolved_at,
    txHash: r.tx_hash,
  }));
  return { code: 200, body };
};
