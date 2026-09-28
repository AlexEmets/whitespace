import { describe, it, expect } from 'vitest';
import { makeFakeDb } from './fakeDb.js';
import { lpActivity } from '../ponder.schema.js';
import { recordLpActivity, LP_EVENTS, type LpEventName } from '../src/lib/lpActivity.js';
import { vaultAbi } from '../abis/vault.js';

const owner = '0x00000000000000000000000000000000000000aa' as const;
const meta = { txHash: '0xab' as `0x${string}`, logIndex: 6, blockNumber: 12n, timestamp: 3_000 };

describe('lp_activity', () => {
  it.each([
    ['DepositRequestedV2', 'deposit_requested', { assets: 7n }],
    ['WithdrawRequestedV2', 'withdraw_requested', { shares: 7n }],
    ['DepositClaimedV2', 'deposit_claimed', { shares: 7n }],
    ['WithdrawClaimedV2', 'withdraw_claimed', { assets: 7n }],
    ['RequestDepositCanceledV2', 'deposit_cancelled', { assets: 7n }],
    ['RequestWithdrawCanceledV2', 'withdraw_cancelled', { shares: 7n }],
    ['DepositReclaimedV2', 'deposit_reclaimed', { assets: 7n }],
    ['WithdrawReclaimedV2', 'withdraw_reclaimed', { shares: 7n }],
    ['DepositPartiallyRefunded', 'deposit_refunded', { refundedAssets: 7n }],
  ] as const)('%s is recorded as %s with its amount', async (name, kind, amountArg) => {
    const ctx = makeFakeDb();
    await recordLpActivity(ctx.db, name as LpEventName, { owner, settlementId: 2, ...amountArg }, meta);
    expect(ctx.rows(lpActivity)).toEqual([
      { id: `${kind}-${owner}-2-6`, owner, kind, settlementId: 2, amount: 7n, timestamp: 3_000, blockNumber: 12n, txHash: '0xab' },
    ]);
  });

  it('every mapped amount field exists on the ABI event it reads', () => {
    for (const [name, { amount }] of Object.entries(LP_EVENTS)) {
      const ev = vaultAbi.find((e) => e.name === name);
      expect(ev, name).toBeDefined();
      expect(ev!.inputs.map((i) => i.name), name).toContain(amount);
    }
  });
});
