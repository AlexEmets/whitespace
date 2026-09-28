import { vaultSettlement } from '../../ponder.schema.js';
import type { EventMeta } from './event.js';

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// IOstiumVault.SettlementType
const SETTLEMENT_TYPE_LABELS = ['acct', 'mm'] as const;

export function settlementTypeLabel(ordinal: number): string {
  return SETTLEMENT_TYPE_LABELS[ordinal] ?? `unknown_${ordinal}`;
}

const EMPTY = {
  settlementType: null,
  settlementTs: null,
  totalAssets: null,
  totalSupply: null,
  settlementOpenPnl: null,
  totalClosedPnl: null,
  accPnlPerTokenUsed: null,
  bufferSize: null,
  assetsDeposited: null,
  sharesWithdrawn: null,
  deltaShares: null,
};

async function upsert(db: Db, id: number, patch: Record<string, unknown>, meta: EventMeta): Promise<void> {
  const where = { at: meta.timestamp, blockNumber: meta.blockNumber, txHash: meta.txHash };
  await db
    .insert(vaultSettlement)
    .values({ id, ...EMPTY, ...patch, ...where })
    .onConflictDoUpdate({ ...patch, ...where });
}

export async function onSettlementExecuted(
  db: Db,
  args: {
    settlementId: number;
    settlementTs: number;
    settlementOpenPnl: bigint;
    settlementType: number;
    accPnlPerTokenUsed: bigint;
    shareToAssetsPrice: bigint;
    totalClosedPnl: bigint;
    totalSupply: bigint;
    totalAssets: bigint;
    bufferSize: bigint;
  },
  meta: EventMeta,
): Promise<void> {
  await upsert(
    db,
    args.settlementId,
    {
      settlementType: settlementTypeLabel(args.settlementType),
      settlementTs: args.settlementTs,
      totalAssets: args.totalAssets,
      totalSupply: args.totalSupply,
      shareToAssetsPrice: args.shareToAssetsPrice,
      settlementOpenPnl: args.settlementOpenPnl,
      totalClosedPnl: args.totalClosedPnl,
      accPnlPerTokenUsed: args.accPnlPerTokenUsed,
      bufferSize: args.bufferSize,
    },
    meta,
  );
}

export async function onAsyncDepositWithdrawExecuted(
  db: Db,
  args: {
    settlementId: number;
    deltaShares: bigint;
    totalAssetsToDeposit: bigint;
    totalSharesToWithdraw: bigint;
    shareToAssetsPrice: bigint;
  },
  meta: EventMeta,
): Promise<void> {
  await upsert(
    db,
    args.settlementId,
    {
      assetsDeposited: args.totalAssetsToDeposit,
      sharesWithdrawn: args.totalSharesToWithdraw,
      deltaShares: args.deltaShares,
      shareToAssetsPrice: args.shareToAssetsPrice,
    },
    meta,
  );
}
