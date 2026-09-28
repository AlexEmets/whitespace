import { query } from '../db.js';
import { collateral, id as fmtId } from '../format.js';
import type { Handler, RouteResult } from '../router.js';
import type { FeeCharge, FeeKind } from '../types.js';
import { parseAddress, parseLimit, badRequest } from '../validate.js';

type FeeRow = {
  id: string;
  trader: string;
  trade_id: string | null;
  pair_index: number | null;
  kind: FeeKind;
  amount: string;
  at: number;
  block_number: string;
  tx_hash: string;
};

export const FEES_DEFAULT_LIMIT = 200;
export const FEES_MAX_LIMIT = 1000;

/** Shared by the REST route and the `fees:` WS channel. */
export async function resolveFees(trader: string, limit = FEES_DEFAULT_LIMIT): Promise<FeeCharge[]> {
  const rows = await query<FeeRow>(
    `SELECT * FROM fee_charge WHERE trader = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [trader, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    trader: r.trader,
    tradeId: fmtId(r.trade_id),
    pairIndex: r.pair_index,
    kind: r.kind,
    amount: collateral(r.amount)!,
    at: r.at,
    blockNumber: fmtId(r.block_number)!,
    txHash: r.tx_hash,
  }));
}

// GET /fees/:address?limit=200 -> FeeCharge[], newest first. The Funding History tab is
// the kind in ('funding', 'rollover') subset.
export const handleFees: Handler = async (_req, params, searchParams): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');
  const limit = parseLimit(searchParams, FEES_DEFAULT_LIMIT, FEES_MAX_LIMIT);
  if (limit === null) return badRequest(`limit must be an integer between 1 and ${FEES_MAX_LIMIT}`);
  return { code: 200, body: await resolveFees(trader, limit) };
};
