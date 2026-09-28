import { query } from '../db.js';
import { price, collateral, leverage as fmtLeverage } from '../format.js';
import type { Handler } from '../router.js';
import type { LimitOrder } from '../types.js';
import { parseAddress, badRequest } from '../validate.js';

type LimitOrderRow = {
  id: string;
  trader: string;
  pair_index: number;
  index: number;
  order_type: 'LIMIT' | 'STOP';
  buy: boolean;
  collateral: string;
  leverage: number;
  trigger_price: string;
  tp: string;
  sl: string;
  placed_at: number;
  updated_at: number;
  placed_tx: string;
};

/** A trader has at most maxTradesPerPair limit slots per pair, so this bound is never hit
 * by a real account; it exists so the WS poll's cost cannot grow without one. */
const MAX_LIMIT_ORDERS = 500;

/** Shared by the REST route and the `limitOrders:` WS channel. */
export async function resolveLimitOrders(trader: string): Promise<LimitOrder[]> {
  const rows = await query<LimitOrderRow>(
    `SELECT * FROM limit_order WHERE trader = $1 ORDER BY placed_at DESC, id DESC LIMIT $2`,
    [trader, MAX_LIMIT_ORDERS],
  );
  return rows.map((r) => ({
    id: r.id,
    trader: r.trader,
    pairIndex: r.pair_index,
    index: r.index,
    orderType: r.order_type,
    buy: r.buy,
    collateral: collateral(r.collateral)!,
    leverage: fmtLeverage(r.leverage)!,
    triggerPrice: price(r.trigger_price)!,
    tp: price(r.tp)!,
    sl: price(r.sl)!,
    placedAt: r.placed_at,
    updatedAt: r.updated_at,
    placedTx: r.placed_tx,
  }));
}

// GET /limit-orders/:address -> LimitOrder[], open LIMIT/STOP entries, newest first.
export const handleLimitOrders: Handler = async (_req, params) => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  return { code: 200, body: await resolveLimitOrders(trader) };
};
