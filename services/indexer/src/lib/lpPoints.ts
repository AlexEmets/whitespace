import { vaultSettlement } from '../../ponder.schema.js';
import { onLpDepositClaimed, onLpWithdrawClaimed, awardMission } from './points.js';
import { logId, type EventMeta } from './event.js';

// LP points wiring for the vault's claim events. Kept out of src/handlers (which import
// ponder:registry) so test/lpPoints.test.ts can drive it against test/fakeDb.ts. Balances are
// tracked in USDW assets (PRECISION_6); a deposit is claimed in OLP shares, so it is valued
// through the settlement's share price before it feeds the usdw-days accrual in points.ts.
//
// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const PRICE_SCALE = 10n ** 18n; // shareToAssetsPrice is PRECISION_18

/** A claimed deposit: value the claimed shares in USDW via the settlement's share price,
 * accrue LP points, and unlock the deposit-and-claim mission. */
export async function onVaultDepositClaimed(
  db: Db,
  args: { owner: `0x${string}`; settlementId: number; shares: bigint },
  meta: EventMeta,
): Promise<void> {
  const settlement = (await db.find(vaultSettlement, { id: args.settlementId })) as
    | { shareToAssetsPrice: bigint }
    | null;
  // A settlement that predates the indexed range leaves the price unknown; fall back to 1:1
  // rather than dropping the deposit, so the balance is at least tracked from here on.
  const price = settlement?.shareToAssetsPrice ?? PRICE_SCALE;
  const assetsRaw = (args.shares * price) / PRICE_SCALE;

  await onLpDepositClaimed(db, {
    owner: args.owner,
    assetsRaw,
    atSeconds: meta.timestamp,
    txHash: meta.txHash,
    ledgerId: logId(meta),
  });
  await awardMission(db, { trader: args.owner, missionId: 'pool_deposit_claim', at: meta.timestamp, txHash: meta.txHash });
}

/** A claimed withdrawal: the event carries USDW assets directly. Accrue LP points on the
 * period up to now, reduce the balance, and unlock the withdraw-and-claim mission. */
export async function onVaultWithdrawClaimed(
  db: Db,
  args: { owner: `0x${string}`; settlementId: number; assets: bigint },
  meta: EventMeta,
): Promise<void> {
  await onLpWithdrawClaimed(db, {
    owner: args.owner,
    assetsRaw: args.assets,
    atSeconds: meta.timestamp,
    txHash: meta.txHash,
    ledgerId: logId(meta),
  });
  await awardMission(db, { trader: args.owner, missionId: 'pool_withdraw_claim', at: meta.timestamp, txHash: meta.txHash });
}
