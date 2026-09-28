import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { vaultSettlement, walletLp, walletPoints, pointsEvent } from '../ponder.schema.js';
import { onVaultDepositClaimed, onVaultWithdrawClaimed } from '../src/lib/lpPoints.js';

const owner = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19' as `0x${string}`;
const P = 1_000_000n;
const USDW = 1_000_000n;
const E18 = 10n ** 18n;
const DAY = 86_400;

function meta(logIndex: number, timestamp: number, txHash = '0xaa') {
  return { txHash: txHash as `0x${string}`, logIndex, blockNumber: 1n, timestamp };
}

describe('LP points wiring', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
    // 1:1 share price by default
    ctx.seed(vaultSettlement, { id: 1, shareToAssetsPrice: E18 });
  });

  it('a first deposit sets the balance, unlocks the mission, and accrues nothing yet', async () => {
    await onVaultDepositClaimed(ctx.db, { owner, settlementId: 1, shares: 8_500n * USDW }, meta(0, DAY));
    expect(ctx.get(walletLp, { owner })).toMatchObject({ balanceRaw: 8_500n * USDW, lastAccrualAt: DAY });
    expect(ctx.get(pointsEvent, { id: `mission-${owner}-pool_deposit_claim` })).toMatchObject({ pointsRaw: 100n * P });
    expect(ctx.get(walletPoints, { trader: owner })).toMatchObject({ missionsRaw: 100n * P, lpRaw: 0n });
  });

  it('values claimed shares through the settlement share price', async () => {
    ctx.seed(vaultSettlement, { id: 2, shareToAssetsPrice: 2n * E18 }); // 1 share = 2 USDW
    await onVaultDepositClaimed(ctx.db, { owner, settlementId: 2, shares: 1_000n * USDW }, meta(0, DAY));
    expect(ctx.get(walletLp, { owner })).toMatchObject({ balanceRaw: 2_000n * USDW });
  });

  it('accrues usdw-days when the balance next changes', async () => {
    await onVaultDepositClaimed(ctx.db, { owner, settlementId: 1, shares: 8_500n * USDW }, meta(0, DAY));
    // one day later, withdraw everything -> the prior 8,500 for one day earns 8.5 points
    await onVaultWithdrawClaimed(ctx.db, { owner, settlementId: 1, assets: 8_500n * USDW }, meta(0, 2 * DAY, '0xbb'));
    expect(ctx.get(walletPoints, { trader: owner })).toMatchObject({ lpRaw: 8_500_000n });
    expect(ctx.get(walletLp, { owner })).toMatchObject({ balanceRaw: 0n });
    expect(ctx.get(pointsEvent, { id: `mission-${owner}-pool_withdraw_claim` })).toMatchObject({ pointsRaw: 100n * P });
  });

  it('falls back to a 1:1 valuation when the settlement is not indexed', async () => {
    await onVaultDepositClaimed(ctx.db, { owner, settlementId: 99, shares: 500n * USDW }, meta(0, DAY));
    expect(ctx.get(walletLp, { owner })).toMatchObject({ balanceRaw: 500n * USDW });
  });
});
