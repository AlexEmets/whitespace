import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb } from './fakeDb.js';
import { pointsEvent, walletPoints, pointsDaily, walletStreak, walletLp } from '../ponder.schema.js';
import {
  awardMission,
  accrueTimeInMarket,
  updateStreak,
  onLpDepositClaimed,
  onLpWithdrawClaimed,
} from '../src/lib/points.js';

const trader = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19';
const TX = '0xcc' as `0x${string}`;
const P = 1_000_000n; // one point, 6dp
const USDW = 1_000_000n; // one USDW, 6dp
const DAY = 86_400;

describe('points engine', () => {
  let ctx: FakeDb;
  beforeEach(() => {
    ctx = makeFakeDb();
  });

  describe('missions', () => {
    it('awards a mission once and records it in the ledger and the aggregate', async () => {
      const credited = await awardMission(ctx.db, { trader, missionId: 'first_market_trade', at: DAY, txHash: TX });
      expect(credited).toEqual(50n * P);
      expect(ctx.get(pointsEvent, { id: `mission-${trader}-first_market_trade` })).toMatchObject({
        trader,
        component: 'mission',
        pointsRaw: 50n * P,
        refId: 'first_market_trade',
      });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 50n * P, totalRaw: 50n * P });
    });

    it('is idempotent: the same mission never credits twice', async () => {
      await awardMission(ctx.db, { trader, missionId: 'first_market_trade', at: DAY, txHash: TX });
      const second = await awardMission(ctx.db, { trader, missionId: 'first_market_trade', at: DAY + 100, txHash: TX });
      expect(second).toEqual(0n);
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 50n * P });
    });

    it('sums distinct missions into the aggregate', async () => {
      await awardMission(ctx.db, { trader, missionId: 'first_market_trade', at: DAY, txHash: TX });
      await awardMission(ctx.db, { trader, missionId: 'close_empty_wallet', at: DAY, txHash: TX });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 150n * P, totalRaw: 150n * P });
    });

    it('lowercases the trader so awards and reads share one key', async () => {
      await awardMission(ctx.db, { trader: trader.toUpperCase() as `0x${string}`, missionId: 'edit_tp_sl', at: DAY, txHash: TX });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ missionsRaw: 50n * P });
    });

    it('throws on an unknown mission id', async () => {
      await expect(awardMission(ctx.db, { trader, missionId: 'nope', at: DAY, txHash: TX })).rejects.toThrow();
    });
  });

  describe('time in market', () => {
    it('credits notional x hours / 10000 on close', async () => {
      // 12,400 notional held one hour -> 1.24 points
      const credited = await accrueTimeInMarket(ctx.db, {
        trader,
        closeOrderId: 3n,
        notionalRaw: 12_400n * USDW,
        openedAt: DAY,
        closedAt: DAY + 3600,
        txHash: TX,
      });
      expect(credited).toEqual(1_240_000n);
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ timeRaw: 1_240_000n });
    });

    it('ignores a position held under the 5-minute floor (no ledger row)', async () => {
      const credited = await accrueTimeInMarket(ctx.db, {
        trader,
        closeOrderId: 4n,
        notionalRaw: 50_000n * USDW,
        openedAt: DAY,
        closedAt: DAY + 299,
        txHash: TX,
      });
      expect(credited).toEqual(0n);
      expect(ctx.rows(pointsEvent)).toEqual([]);
    });

    it('applies the 100/day cap across several closes on the same UTC day', async () => {
      // 50k notional for 10h = 50 points each; three closes would be 150 but the day caps at 100.
      const base = { trader, notionalRaw: 50_000n * USDW, txHash: TX };
      await accrueTimeInMarket(ctx.db, { ...base, closeOrderId: 1n, openedAt: DAY, closedAt: DAY + 10 * 3600 });
      await accrueTimeInMarket(ctx.db, { ...base, closeOrderId: 2n, openedAt: DAY, closedAt: DAY + 10 * 3600 });
      const third = await accrueTimeInMarket(ctx.db, { ...base, closeOrderId: 3n, openedAt: DAY, closedAt: DAY + 10 * 3600 });
      expect(third).toEqual(0n); // cap already reached by the first two
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ timeRaw: 100n * P });
      expect(ctx.get(pointsDaily, { id: `${trader}-time-1` })).toMatchObject({ accruedRaw: 100n * P });
    });

    it('is idempotent per close order id', async () => {
      const args = { trader, closeOrderId: 9n, notionalRaw: 12_400n * USDW, openedAt: DAY, closedAt: DAY + 3600, txHash: TX };
      await accrueTimeInMarket(ctx.db, args);
      const again = await accrueTimeInMarket(ctx.db, args);
      expect(again).toEqual(0n);
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ timeRaw: 1_240_000n });
    });
  });

  describe('day streak', () => {
    const held = 3600; // over the 10-minute qualifying threshold

    it('awards day 1 at x1.0 and starts the run', async () => {
      const credited = await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 5 * DAY, txHash: TX });
      expect(credited).toEqual(10n * P);
      expect(ctx.get(walletStreak, { trader })).toMatchObject({ lastQualifiedDay: 5, currentLength: 1, longest: 1 });
    });

    it('extends the run on the next day with a higher multiplier', async () => {
      await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 5 * DAY, txHash: TX });
      const day2 = await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 6 * DAY, txHash: TX });
      expect(day2).toEqual((10n * P * 10_833n) / 10_000n); // x1.0833
      expect(ctx.get(walletStreak, { trader })).toMatchObject({ currentLength: 2, longest: 2 });
    });

    it('only awards once per UTC day', async () => {
      await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 5 * DAY, txHash: TX });
      const same = await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 5 * DAY + 100, txHash: TX });
      expect(same).toEqual(0n);
      expect(ctx.get(walletStreak, { trader })).toMatchObject({ currentLength: 1 });
    });

    it('resets the run after a missed day', async () => {
      await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 5 * DAY, txHash: TX });
      await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 6 * DAY, txHash: TX });
      const afterGap = await updateStreak(ctx.db, { trader, heldSeconds: held, closedAt: 9 * DAY, txHash: TX });
      expect(afterGap).toEqual(10n * P); // back to x1.0
      expect(ctx.get(walletStreak, { trader })).toMatchObject({ currentLength: 1, longest: 2 });
    });

    it('does not count a position held under the 10-minute threshold', async () => {
      const credited = await updateStreak(ctx.db, { trader, heldSeconds: 599, closedAt: 5 * DAY, txHash: TX });
      expect(credited).toEqual(0n);
      expect(ctx.rows(walletStreak)).toEqual([]);
    });
  });

  describe('pool (LP)', () => {
    it('accrues nothing on the first deposit (no prior balance)', async () => {
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 8_500n * USDW, atSeconds: DAY, txHash: TX, ledgerId: `${TX}-0` });
      expect(ctx.rows(pointsEvent)).toEqual([]);
      expect(ctx.get(walletLp, { owner: trader })).toMatchObject({ balanceRaw: 8_500n * USDW, lastAccrualAt: DAY });
    });

    it('credits usdw-days when the balance next changes', async () => {
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 8_500n * USDW, atSeconds: DAY, txHash: TX, ledgerId: `${TX}-0` });
      // one day later, deposit more -> the prior 8,500 for one day earns 8.5 points
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 1_500n * USDW, atSeconds: 2 * DAY, txHash: TX, ledgerId: `${TX}-1` });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ lpRaw: 8_500_000n });
      expect(ctx.get(walletLp, { owner: trader })).toMatchObject({ balanceRaw: 10_000n * USDW, lastAccrualAt: 2 * DAY });
    });

    it('accrues on withdrawal and reduces the balance', async () => {
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 8_500n * USDW, atSeconds: DAY, txHash: TX, ledgerId: `${TX}-0` });
      await onLpWithdrawClaimed(ctx.db, { owner: trader, assetsRaw: 8_500n * USDW, atSeconds: 2 * DAY, txHash: TX, ledgerId: `${TX}-1` });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ lpRaw: 8_500_000n });
      expect(ctx.get(walletLp, { owner: trader })).toMatchObject({ balanceRaw: 0n });
    });

    it('caps LP points at 50/day', async () => {
      // 200k USDW for a full day would be 200 points; the day caps at 50.
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 200_000n * USDW, atSeconds: DAY, txHash: TX, ledgerId: `${TX}-0` });
      await onLpWithdrawClaimed(ctx.db, { owner: trader, assetsRaw: 1n, atSeconds: 2 * DAY, txHash: TX, ledgerId: `${TX}-1` });
      expect(ctx.get(walletPoints, { trader })).toMatchObject({ lpRaw: 50n * P });
    });

    it('never drives the balance below zero', async () => {
      await onLpDepositClaimed(ctx.db, { owner: trader, assetsRaw: 100n * USDW, atSeconds: DAY, txHash: TX, ledgerId: `${TX}-0` });
      await onLpWithdrawClaimed(ctx.db, { owner: trader, assetsRaw: 500n * USDW, atSeconds: 2 * DAY, txHash: TX, ledgerId: `${TX}-1` });
      expect(ctx.get(walletLp, { owner: trader })).toMatchObject({ balanceRaw: 0n });
    });
  });

  it('keeps the total as the sum of all four components', async () => {
    await awardMission(ctx.db, { trader, missionId: 'first_market_trade', at: DAY, txHash: TX }); // 50
    await accrueTimeInMarket(ctx.db, { trader, closeOrderId: 3n, notionalRaw: 12_400n * USDW, openedAt: DAY, closedAt: DAY + 3600, txHash: TX }); // 1.24
    await updateStreak(ctx.db, { trader, heldSeconds: 3600, closedAt: DAY, txHash: TX }); // 10
    const wp = ctx.get(walletPoints, { trader }) as Record<string, bigint>;
    expect(wp.totalRaw).toEqual(wp.missionsRaw + wp.timeRaw + wp.streakRaw + wp.lpRaw);
    expect(wp.totalRaw).toEqual(50n * P + 1_240_000n + 10n * P);
  });
});
