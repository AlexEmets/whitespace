import { query } from '../db.js';
import { collateral, price, id as fmtId } from '../format.js';
import type { Handler, RouteResult } from '../router.js';
import type { VaultSettlement } from '../types.js';
import { parseLimit, badRequest } from '../validate.js';

type SettlementRow = {
  id: number;
  settlement_type: 'acct' | 'mm' | null;
  settlement_ts: number | null;
  total_assets: string | null;
  total_supply: string | null;
  share_to_assets_price: string;
  settlement_open_pnl: string | null;
  total_closed_pnl: string | null;
  acc_pnl_per_token_used: string | null;
  buffer_size: string | null;
  assets_deposited: string | null;
  shares_withdrawn: string | null;
  delta_shares: string | null;
  at: number;
  block_number: string;
  tx_hash: string;
};

export const SETTLEMENTS_DEFAULT_LIMIT = 50;
export const SETTLEMENTS_MAX_LIMIT = 500;

// GET /vault/settlements?limit=50 -> VaultSettlement[], newest first. Share price and
// open PnL are 18 dp; assets, shares, closed PnL and buffer are 6 dp (the vault token has
// 6 decimals, see OstiumVault.decimals()).
export const handleVaultSettlements: Handler = async (_req, _params, searchParams): Promise<RouteResult> => {
  const limit = parseLimit(searchParams, SETTLEMENTS_DEFAULT_LIMIT, SETTLEMENTS_MAX_LIMIT);
  if (limit === null) return badRequest(`limit must be an integer between 1 and ${SETTLEMENTS_MAX_LIMIT}`);
  const rows = await query<SettlementRow>(`SELECT * FROM vault_settlement ORDER BY id DESC LIMIT $1`, [limit]);
  const body: VaultSettlement[] = rows.map((r) => ({
    settlementId: r.id,
    settlementType: r.settlement_type,
    settlementTs: r.settlement_ts,
    totalAssets: collateral(r.total_assets),
    totalSupply: collateral(r.total_supply),
    shareToAssetsPrice: price(r.share_to_assets_price)!,
    settlementOpenPnl: price(r.settlement_open_pnl),
    totalClosedPnl: collateral(r.total_closed_pnl),
    accPnlPerTokenUsed: price(r.acc_pnl_per_token_used),
    bufferSize: collateral(r.buffer_size),
    assetsDeposited: collateral(r.assets_deposited),
    sharesWithdrawn: collateral(r.shares_withdrawn),
    deltaShares: collateral(r.delta_shares),
    at: r.at,
    blockNumber: fmtId(r.block_number)!,
    txHash: r.tx_hash,
  }));
  return { code: 200, body };
};
