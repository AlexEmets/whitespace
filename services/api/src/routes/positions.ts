import { query } from '../db.js';
import { price, collateral, leverage as fmtLeverage, id as fmtId, percent6 } from '../format.js';
import type { RouteResult, Handler } from '../router.js';
import { parseAddress, badRequest } from '../validate.js';

type PositionRow = {
  pair_index: number;
  index: number;
  buy: boolean;
  collateral: string;
  leverage: number;
  open_price: string;
  tp: string;
  sl: string;
  opened_at: number;
  trade_id: string;
};

/** A trader holds at most maxTradesPerPair positions per market, far below this; the bound
 * exists because the `positions:` WS channel re-runs this query for every subscribed wallet
 * on every poll, and an unbounded SELECT there grows with whatever the table holds. */
export const MAX_POSITIONS = 500;

/** Shared by the REST route and the `positions:` WS channel. */
export async function resolvePositions(address: string): Promise<unknown[]> {
  const trader = address.toLowerCase();
  const rows = await query<PositionRow>(
    'SELECT * FROM position WHERE trader = $1 ORDER BY opened_at DESC, trade_id DESC LIMIT $2',
    [trader, MAX_POSITIONS],
  );
  return rows.map((r) => ({
    pairIndex: r.pair_index,
    index: r.index,
    buy: r.buy,
    collateral: collateral(r.collateral),
    leverage: fmtLeverage(r.leverage),
    openPrice: price(r.open_price),
    tp: price(r.tp),
    sl: price(r.sl),
    openedAt: r.opened_at,
    tradeId: fmtId(r.trade_id),
  }));
}

export const handlePositions: Handler = async (_req, params): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  return { code: 200, body: await resolvePositions(trader) };
};

type ClosedPositionRow = {
  pair_index: number;
  index: number;
  buy: boolean;
  collateral: string;
  leverage: number;
  open_price: string;
  close_price: string;
  tp: string | null;
  sl: string | null;
  trade_id: string;
  opened_at: number;
  closed_at: number;
  close_reason: string;
  percent_profit: string;
  usdc_sent_to_trader: string;
  close_order_id: string;
  close_tx_hash: string;
  percentage_closed: number;
  is_partial: boolean;
};

// GET /positions/:address/history -> every close that realised PnL, newest first: full
// closes from closed_position and partial closes from partial_close. A partially closed
// trade therefore appears once per partial close (and once more if it is later closed in
// full), all with the same tradeId; closeOrderId is the unique key. For a partial row,
// `collateral` is the part closed and tp/sl are null (the trade's own tp/sl live on the
// open position).
export const handlePositionsHistory: Handler = async (_req, params): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  const rows = await query<ClosedPositionRow>(
    `SELECT pair_index, index, buy, collateral::text, leverage, open_price::text, close_price::text,
            tp::text, sl::text, trade_id::text, opened_at, closed_at, close_reason, percent_profit::text,
            usdc_sent_to_trader::text, close_order_id::text, close_tx_hash, percentage_closed, false AS is_partial
       FROM closed_position WHERE trader = $1
     UNION ALL
     SELECT pair_index, index, buy, collateral::text, leverage, open_price::text, close_price::text,
            NULL, NULL, trade_id::text, opened_at, closed_at, close_reason, percent_profit::text,
            usdc_sent_to_trader::text, order_id::text, close_tx_hash, percentage_closed, true
       FROM partial_close WHERE trader = $1
     ORDER BY closed_at DESC, close_order_id DESC`,
    [trader],
  );
  return {
    code: 200,
    body: rows.map((r) => {
      // realised pnl = what came back to the trader minus the collateral that was closed,
      // both PRECISION_6: exact bigint subtraction, no float.
      const realizedPnl = (BigInt(r.usdc_sent_to_trader) - BigInt(r.collateral)).toString();
      return {
        pairIndex: r.pair_index,
        index: r.index,
        buy: r.buy,
        collateral: collateral(r.collateral),
        leverage: fmtLeverage(r.leverage),
        openPrice: price(r.open_price),
        closePrice: price(r.close_price),
        tp: price(r.tp),
        sl: price(r.sl),
        tradeId: fmtId(r.trade_id),
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        closeReason: r.close_reason,
        percentProfit: percent6(r.percent_profit), // percent, 6 dp
        usdcSentToTrader: collateral(r.usdc_sent_to_trader),
        realizedPnl: collateral(realizedPnl),
        closeOrderId: fmtId(r.close_order_id),
        closeTxHash: r.close_tx_hash,
        percentageClosed: fmtLeverage(r.percentage_closed), // PRECISION_2 percent, "100.00" = full
        isPartial: r.is_partial,
      };
    }),
  };
};
