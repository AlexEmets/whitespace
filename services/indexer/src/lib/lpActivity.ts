import { lpActivity } from '../../ponder.schema.js';
import type { EventMeta } from './event.js';

// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Every per-LP vault event and the lp_activity kind + amount field it maps to. The
 * request → settlement → claim path, plus the three ways a request ends without a claim
 * (cancelled before settlement, reclaimed after a settlement that could not take it, and
 * the unallocated part of a pro-rata-capped deposit refunded at claim time). */
export const LP_EVENTS = {
  DepositRequestedV2: { kind: 'deposit_requested', amount: 'assets' },
  WithdrawRequestedV2: { kind: 'withdraw_requested', amount: 'shares' },
  DepositClaimedV2: { kind: 'deposit_claimed', amount: 'shares' },
  WithdrawClaimedV2: { kind: 'withdraw_claimed', amount: 'assets' },
  RequestDepositCanceledV2: { kind: 'deposit_cancelled', amount: 'assets' },
  RequestWithdrawCanceledV2: { kind: 'withdraw_cancelled', amount: 'shares' },
  DepositReclaimedV2: { kind: 'deposit_reclaimed', amount: 'assets' },
  WithdrawReclaimedV2: { kind: 'withdraw_reclaimed', amount: 'shares' },
  DepositPartiallyRefunded: { kind: 'deposit_refunded', amount: 'refundedAssets' },
} as const;

export type LpEventName = keyof typeof LP_EVENTS;

export async function recordLpActivity(
  db: Db,
  name: LpEventName,
  args: { owner: `0x${string}`; settlementId: number } & Record<string, unknown>,
  meta: EventMeta,
): Promise<void> {
  const { kind, amount } = LP_EVENTS[name];
  await db
    .insert(lpActivity)
    .values({
      id: `${kind}-${args.owner}-${args.settlementId}-${meta.logIndex}`,
      owner: args.owner,
      kind,
      settlementId: args.settlementId,
      amount: args[amount] as bigint,
      timestamp: meta.timestamp,
      blockNumber: meta.blockNumber,
      txHash: meta.txHash,
    })
    .onConflictDoUpdate({});
}
