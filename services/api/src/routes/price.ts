import { queryOne } from '../db.js';
import { price as fmtPrice } from '../format.js';
import type { RouteResult, Handler } from '../router.js';

type PriceReportRow = { price: string; block_timestamp: number };

// GET /price/:pairIndex -> { index, mark, updatedAt, healthyVenues, degraded }
//
// This project has no price-publisher service running yet (services/
// price-publisher is phase 3 scope; this is phase 4). Per the task's
// explicit instruction, this endpoint does NOT invent healthyVenues/
// degraded data — it serves `index`/`mark`/`updatedAt` from the latest
// indexed on-chain PriceReceived report and returns healthyVenues/degraded
// as `null`, honestly reflecting "no publisher data source exists." `mark`
// currently mirrors `index` for the same reason (no publisher-computed EMA
// mark price to serve) — see docs/decisions/phase-4-indexer-api.md.
export const handlePrice: Handler = async (_req, params): Promise<RouteResult> => {
  const pairIndex = Number(params.pairIndex);
  if (!Number.isInteger(pairIndex)) {
    return { code: 400, body: { error: 'invalid pairIndex' } };
  }
  const row = await queryOne<PriceReportRow>(
    'SELECT price, block_timestamp FROM price_report WHERE pair_index = $1 ORDER BY block_timestamp DESC, order_id DESC LIMIT 1',
    [pairIndex],
  );
  if (!row) {
    return { code: 404, body: { error: 'no price reports indexed for this market yet' } };
  }
  return {
    code: 200,
    body: {
      index: fmtPrice(row.price),
      mark: fmtPrice(row.price),
      updatedAt: row.block_timestamp,
      healthyVenues: null,
      degraded: null,
    },
  };
};
