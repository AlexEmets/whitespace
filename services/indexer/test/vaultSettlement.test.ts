import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { vaultSettlement } from '../ponder.schema.js';
import { onSettlementExecuted, onAsyncDepositWithdrawExecuted, settlementTypeLabel } from '../src/lib/vaultSettlement.js';

const meta = { txHash: '0xee' as `0x${string}`, logIndex: 3, blockNumber: 500n, timestamp: 9_000 };
const E18 = 10n ** 18n;

const settled = {
  settlementId: 4,
  settlementTs: 8_999,
  settlementOpenPnl: -5n * E18,
  settlementType: 0,
  accPnlPerTokenUsed: -12n,
  shareToAssetsPrice: 1_010_000_000_000_000_000n,
  totalClosedPnl: -3_000_000n,
  totalSupply: 990_000_000n,
  totalAssets: 1_000_000_000n,
  bufferSize: 7n,
};
const batch = {
  settlementId: 4,
  deltaShares: -10_000_000n,
  totalAssetsToDeposit: 5_000_000n,
  totalSharesToWithdraw: 15_000_000n,
  shareToAssetsPrice: 1_010_000_000_000_000_000n,
};

describe('vault_settlement', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
  });

  it('labels settlement types', () => {
    expect(settlementTypeLabel(0)).toBe('acct');
    expect(settlementTypeLabel(1)).toBe('mm');
    expect(settlementTypeLabel(9)).toBe('unknown_9');
  });

  const full = {
    id: 4,
    settlementType: 'acct',
    settlementTs: 8_999,
    totalAssets: 1_000_000_000n,
    totalSupply: 990_000_000n,
    shareToAssetsPrice: 1_010_000_000_000_000_000n,
    settlementOpenPnl: -5n * E18,
    totalClosedPnl: -3_000_000n,
    accPnlPerTokenUsed: -12n,
    bufferSize: 7n,
    assetsDeposited: 5_000_000n,
    sharesWithdrawn: 15_000_000n,
    deltaShares: -10_000_000n,
    at: 9_000,
    blockNumber: 500n,
    txHash: '0xee',
  };

  it('merges the batch and the totals into one row, in the order the vault emits them', async () => {
    await onAsyncDepositWithdrawExecuted(ctx.db, batch, meta);
    await onSettlementExecuted(ctx.db, settled, meta);
    expect(ctx.rows(vaultSettlement)).toEqual([full]);
  });

  it('merges in either order', async () => {
    await onSettlementExecuted(ctx.db, settled, meta);
    await onAsyncDepositWithdrawExecuted(ctx.db, batch, meta);
    expect(ctx.rows(vaultSettlement)).toEqual([full]);
  });

  it('a settlement seen alone leaves the batch columns null', async () => {
    await onSettlementExecuted(ctx.db, { ...settled, settlementType: 1 }, meta);
    expect(ctx.rows(vaultSettlement)[0]).toMatchObject({ settlementType: 'mm', assetsDeposited: null, deltaShares: null });
  });

  it('separate settlements are separate rows', async () => {
    await onSettlementExecuted(ctx.db, settled, meta);
    await onSettlementExecuted(ctx.db, { ...settled, settlementId: 5 }, meta);
    expect(ctx.rows(vaultSettlement).map((r) => r.id)).toEqual([4, 5]);
  });
});
