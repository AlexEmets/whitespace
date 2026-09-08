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
};

// GET /orders/:address -> pending (requested but not yet executed) orders.
// Note: 'open' orders don't carry collateral/leverage/buy at request time —
// MarketOpenOrderInitiated doesn't emit the Trade payload, only
// MarketOpenExecuted does (see src/handlers/trading.ts in the indexer). So
// those fields are null for a still-pending open order, and only populated
// for close/remove_collateral orders that recorded them directly.
export const handleOrders: Handler = async (_req, params): Promise<RouteResult> => {
  const trader = params.address.toLowerCase();
  const rows = await query<OrderRow>(
    `SELECT * FROM "order" WHERE trader = $1 AND status = 'pending' ORDER BY requested_at DESC`,
    [trader],
  );
  return {
    code: 200,
    body: rows.map((r) => ({
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
    })),
  };
};
