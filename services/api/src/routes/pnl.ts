import { queryOne } from '../db.js';
import { collateral } from '../format.js';
import type { Handler, RouteResult } from '../router.js';
import type { PnlSummary } from '../types.js';
import { parseAddress, badRequest } from '../validate.js';

// GET /pnl/:address -> PnlSummary, totals over the trader's CLOSED positions:
//   realizedPnl  Σ (usdc_sent_to_trader − collateral), the same per-trade figure
//                /positions/:address/history reports. Rollover and funding are already
//                inside usdc_sent_to_trader; open fees are not (they came out of the
//                collateral before it was stored).
//   fees         Σ oracle, dev, vault_opening, bond and rollover charged to those trades.
//                vault_liq is excluded: it is the liquidated remainder, already a loss in
//                realizedPnl, not an extra charge.
//   funding      Σ funding on those trades, signed (negative = received).
//   trades       how many closed positions were summed.
// All sums are NUMERIC in Postgres, never floats.
export const handlePnl: Handler = async (_req, params): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  const row = await queryOne<{ realized: string; trades: string; fees: string; funding: string }>(
    `WITH closed AS (
       SELECT trade_id, usdc_sent_to_trader - collateral AS pnl FROM closed_position WHERE trader = $1
     )
     SELECT
       (SELECT COALESCE(SUM(pnl), 0)::text FROM closed) AS realized,
       (SELECT COUNT(*)::text FROM closed) AS trades,
       COALESCE(SUM(f.amount) FILTER (WHERE f.kind IN ('oracle', 'dev', 'vault_opening', 'bond', 'rollover')), 0)::text AS fees,
       COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'funding'), 0)::text AS funding
     FROM fee_charge f
     WHERE f.trader = $1 AND f.trade_id IN (SELECT trade_id FROM closed)`,
    [trader],
  );
  const body: PnlSummary = {
    realizedPnl: collateral(row!.realized)!,
    fees: collateral(row!.fees)!,
    funding: collateral(row!.funding)!,
    trades: Number(row!.trades),
  };
  return { code: 200, body };
};
