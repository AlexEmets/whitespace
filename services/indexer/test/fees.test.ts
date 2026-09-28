import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { feeCharge, position, order, closedPosition } from '../ponder.schema.js';
import {
  onTradeFee,
  onFeesChargedV2,
  onOracleFeeBondCharged,
  onOracleFeeChargedLimitCancelled,
  pairIndexForTrade,
} from '../src/lib/fees.js';
import type { EventMeta } from '../src/lib/event.js';

const TRADER = '0x2B8BA090DEdF879F8045C0DDa5a78762CED90D19' as const;
const trader = TRADER.toLowerCase();
const meta = (logIndex: number, tx = '0xaa'): EventMeta => ({
  txHash: tx as `0x${string}`,
  logIndex,
  blockNumber: 77n,
  timestamp: 1_700,
});

function seedPosition(ctx: FakeDb, tradeId: bigint, pairIndex = 3, collateral = 100_000_000n) {
  ctx.seed(position, { tradeId, trader, pairIndex, index: 0, buy: true, collateral, leverage: 1000 });
}

describe('fee_charge', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
  });

  it.each([
    ['oracle', 'oracle'],
    ['dev', 'dev'],
    ['vault_opening', 'vault_opening'],
    ['vault_liq', 'vault_liq'],
  ] as const)('records a %s fee as one row keyed by tx and log index', async (kind) => {
    seedPosition(ctx, 5n);
    await onTradeFee(ctx.db, kind, { tradeId: 5n, trader: TRADER, amount: 1_234n }, meta(8));
    expect(ctx.rows(feeCharge)).toEqual([
      { id: '0xaa-8', trader, tradeId: 5n, pairIndex: 3, kind, amount: 1_234n, at: 1_700, blockNumber: 77n, txHash: '0xaa' },
    ]);
  });

  it('replaying the same log does not duplicate or throw', async () => {
    await onTradeFee(ctx.db, 'dev', { tradeId: 5n, trader: TRADER, amount: 1n }, meta(8));
    await onTradeFee(ctx.db, 'dev', { tradeId: 5n, trader: TRADER, amount: 1n }, meta(8));
    expect(ctx.rows(feeCharge)).toHaveLength(1);
  });

  describe('pair index resolution', () => {
    it('comes from the open position', async () => {
      seedPosition(ctx, 5n, 2);
      expect(await pairIndexForTrade(ctx.db, 5n)).toBe(2);
    });
    it('falls back to the open order (open-time fees fire before the position exists)', async () => {
      ctx.seed(order, { orderId: 5n, pairIndex: 1 });
      expect(await pairIndexForTrade(ctx.db, 5n)).toBe(1);
    });
    it('falls back to the closed position', async () => {
      ctx.seed(closedPosition, { tradeId: 5n, pairIndex: 0 });
      expect(await pairIndexForTrade(ctx.db, 5n)).toBe(0);
    });
    it('is null when nothing indexed knows the trade', async () => {
      expect(await pairIndexForTrade(ctx.db, 5n)).toBeNull();
      await onTradeFee(ctx.db, 'dev', { tradeId: 5n, trader: TRADER, amount: 1n }, meta(1));
      expect(ctx.rows(feeCharge)[0].pairIndex).toBeNull();
    });
  });

  it('a cancelled limit order charges an oracle fee with no trade id', async () => {
    await onOracleFeeChargedLimitCancelled(ctx.db, { trader: TRADER, pairIndex: 2, amount: 500_000n }, meta(3));
    expect(ctx.rows(feeCharge)[0]).toMatchObject({ kind: 'oracle', tradeId: null, pairIndex: 2, amount: 500_000n });
  });

  describe('FeesChargedV2', () => {
    it('splits into signed rollover and funding rows (negative funding = received)', async () => {
      seedPosition(ctx, 9n, 1);
      await onFeesChargedV2(ctx.db, { tradeId: 9n, trader: TRADER, rolloverFees: 12n, fundingFees: -34n }, meta(5));
      const rows = ctx.rows(feeCharge);
      expect(rows).toEqual([
        expect.objectContaining({ id: '0xaa-5-rollover', kind: 'rollover', amount: 12n, pairIndex: 1, tradeId: 9n }),
        expect.objectContaining({ id: '0xaa-5-funding', kind: 'funding', amount: -34n, pairIndex: 1, tradeId: 9n }),
      ]);
    });

    it('keeps zero amounts', async () => {
      await onFeesChargedV2(ctx.db, { tradeId: 9n, trader: TRADER, rolloverFees: 0n, fundingFees: 0n }, meta(5));
      expect(ctx.rows(feeCharge).map((r) => r.amount)).toEqual([0n, 0n]);
    });
  });

  describe('OracleFeeBondCharged', () => {
    it('folds the preceding OracleFeeCharged into one bond row, so the bond is counted once', async () => {
      seedPosition(ctx, 9n, 1, 100_000_000n);
      await onTradeFee(ctx.db, 'oracle', { tradeId: 9n, trader: TRADER, amount: 250_000n }, meta(10));
      await onOracleFeeBondCharged(ctx.db, { tradeId: 9n, trader: TRADER, collateral: 99_750_000n }, meta(11));
      expect(ctx.rows(feeCharge)).toEqual([
        { id: '0xaa-11', trader, tradeId: 9n, pairIndex: 1, kind: 'bond', amount: 250_000n, at: 1_700, blockNumber: 77n, txHash: '0xaa' },
      ]);
    });

    it('does not fold an unrelated oracle fee from another trade', async () => {
      seedPosition(ctx, 9n, 1, 100_000_000n);
      await onTradeFee(ctx.db, 'oracle', { tradeId: 8n, trader: TRADER, amount: 1n }, meta(10));
      await onOracleFeeBondCharged(ctx.db, { tradeId: 9n, trader: TRADER, collateral: 99_000_000n }, meta(11));
      const kinds = ctx.rows(feeCharge).map((r) => [r.kind, r.amount]);
      expect(kinds).toEqual([
        ['oracle', 1n],
        ['bond', 1_000_000n], // from the position's collateral delta
      ]);
    });

    it('does not fold an oracle fee from another transaction', async () => {
      seedPosition(ctx, 9n, 1, 100_000_000n);
      await onTradeFee(ctx.db, 'oracle', { tradeId: 9n, trader: TRADER, amount: 1n }, meta(10, '0xbb'));
      await onOracleFeeBondCharged(ctx.db, { tradeId: 9n, trader: TRADER, collateral: 99_000_000n }, meta(11));
      expect(ctx.rows(feeCharge)).toHaveLength(2);
    });

    it('records nothing when the amount cannot be known', async () => {
      await onOracleFeeBondCharged(ctx.db, { tradeId: 9n, trader: TRADER, collateral: 1n }, meta(11));
      expect(ctx.rows(feeCharge)).toEqual([]);
    });
  });
});
