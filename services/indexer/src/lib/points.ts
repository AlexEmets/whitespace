import {
  pointsEvent,
  walletPoints,
  pointsDaily,
  walletStreak,
  walletLp,
} from '../../ponder.schema.js';
import {
  isMissionId,
  missionPointsRaw,
  timeInMarketPointsRaw,
  streakDayAwardRaw,
  lpPointsRaw,
  creditUnderCap,
  utcDayIndex,
  seasonTotalRaw,
  TIME_DAILY_CAP_RAW,
  LP_DAILY_CAP_RAW,
  STREAK_MIN_HELD_SECONDS,
} from '@whitespace/shared/points';

// Season-one points computation. Kept here (not in src/handlers, which cannot load outside
// Ponder's runtime) so test/points.test.ts can drive every rule against test/fakeDb.ts. The
// scoring rules themselves live in @whitespace/shared/points and are shared with the web app,
// so the live counter on /points and the confirmed total in this ledger cannot disagree.
//
// See the comment on `type Db = any` in src/lib/db.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

type Component = 'mission' | 'time' | 'streak' | 'lp';

/** Roll a credited delta into the per-wallet aggregate that backs the leaderboard. */
async function bumpAggregate(
  db: Db,
  trader: string,
  component: Component,
  deltaRaw: bigint,
  at: number,
): Promise<void> {
  const row = (await db.find(walletPoints, { trader })) as
    | { missionsRaw: bigint; timeRaw: bigint; streakRaw: bigint; lpRaw: bigint }
    | null;
  const cur = row ?? { missionsRaw: 0n, timeRaw: 0n, streakRaw: 0n, lpRaw: 0n };
  const next = {
    missionsRaw: cur.missionsRaw + (component === 'mission' ? deltaRaw : 0n),
    timeRaw: cur.timeRaw + (component === 'time' ? deltaRaw : 0n),
    streakRaw: cur.streakRaw + (component === 'streak' ? deltaRaw : 0n),
    lpRaw: cur.lpRaw + (component === 'lp' ? deltaRaw : 0n),
  };
  const totalRaw = seasonTotalRaw(next);
  await db
    .insert(walletPoints)
    .values({ trader, ...next, totalRaw, updatedAt: at })
    .onConflictDoUpdate({ ...next, totalRaw, updatedAt: at });
}

/**
 * Write one award idempotently, applying the daily cap when there is one. Returns the
 * amount actually credited (0 if the award already existed, or the cap was already full).
 * The ledger row is written even when the credited amount is 0, so the daily cap and the
 * idempotency key are both stable across a handler replay.
 */
async function creditCapped(
  db: Db,
  args: {
    id: string;
    trader: string;
    component: Component;
    requestedRaw: bigint;
    capRaw: bigint | null;
    at: number;
    refId: string;
    txHash: `0x${string}`;
  },
): Promise<bigint> {
  const trader = args.trader.toLowerCase();
  if ((await db.find(pointsEvent, { id: args.id })) != null) return 0n; // already awarded

  const dayIndex = utcDayIndex(args.at);
  const dayKey = `${trader}-${args.component}-${dayIndex}`;
  const dayRow = (await db.find(pointsDaily, { id: dayKey })) as { accruedRaw: bigint } | null;
  const accrued = dayRow?.accruedRaw ?? 0n;
  const credited = args.capRaw == null ? args.requestedRaw : creditUnderCap(accrued, args.requestedRaw, args.capRaw);

  await db
    .insert(pointsEvent)
    .values({
      id: args.id,
      trader,
      component: args.component,
      pointsRaw: credited,
      requestedRaw: args.requestedRaw,
      dayIndex,
      refId: args.refId,
      at: args.at,
      txHash: args.txHash,
    })
    .onConflictDoNothing();

  await db
    .insert(pointsDaily)
    .values({ id: dayKey, trader, component: args.component, dayIndex, accruedRaw: accrued + credited })
    .onConflictDoUpdate({ accruedRaw: accrued + credited });

  if (credited > 0n) await bumpAggregate(db, trader, args.component, credited, args.at);
  return credited;
}

/* ---------------- Component 1: missions ---------------- */

/** Award a one-time mission to a wallet. No-op if the wallet already has it. */
export async function awardMission(
  db: Db,
  args: { trader: `0x${string}`; missionId: string; at: number; txHash: `0x${string}` },
): Promise<bigint> {
  if (!isMissionId(args.missionId)) throw new RangeError(`unknown mission id: ${args.missionId}`);
  const trader = args.trader.toLowerCase();
  const raw = missionPointsRaw(args.missionId);
  return creditCapped(db, {
    id: `mission-${trader}-${args.missionId}`,
    trader,
    component: 'mission',
    requestedRaw: raw,
    capRaw: null, // the once-per-wallet ledger key is the only limit
    at: args.at,
    refId: args.missionId,
    txHash: args.txHash,
  });
}

/* ---------------- Component 2: time in market ---------------- */

/** Realise the time-in-market points a position earned, at the moment it closes (fully or
 * in part). `notionalRaw` is the notional of the part that closed. */
export async function accrueTimeInMarket(
  db: Db,
  args: {
    trader: `0x${string}`;
    closeOrderId: bigint;
    notionalRaw: bigint;
    openedAt: number;
    closedAt: number;
    txHash: `0x${string}`;
  },
): Promise<bigint> {
  const heldSeconds = Math.max(0, args.closedAt - args.openedAt);
  const requestedRaw = timeInMarketPointsRaw({ notionalRaw: args.notionalRaw, heldSeconds });
  if (requestedRaw === 0n) return 0n; // below the 5-minute floor, or zero notional
  return creditCapped(db, {
    id: `time-${args.closeOrderId}`,
    trader: args.trader,
    component: 'time',
    requestedRaw,
    capRaw: TIME_DAILY_CAP_RAW,
    at: args.closedAt,
    refId: String(args.closeOrderId),
    txHash: args.txHash,
  });
}

/* ---------------- Component 3: day streak ---------------- */

/** Update a wallet's streak on a qualifying close (a position held past the 10-minute
 * threshold), awarding that day's streak points at most once per UTC day. */
export async function updateStreak(
  db: Db,
  args: { trader: `0x${string}`; heldSeconds: number; closedAt: number; txHash: `0x${string}` },
): Promise<bigint> {
  if (args.heldSeconds < STREAK_MIN_HELD_SECONDS) return 0n;
  const trader = args.trader.toLowerCase();
  const dayIndex = utcDayIndex(args.closedAt);

  const state = (await db.find(walletStreak, { trader })) as
    | { lastQualifiedDay: number; currentLength: number; longest: number }
    | null;
  if (state && state.lastQualifiedDay === dayIndex) return 0n; // already counted today

  const length = state && state.lastQualifiedDay === dayIndex - 1 ? state.currentLength + 1 : 1;
  const longest = Math.max(length, state?.longest ?? 0);
  await db
    .insert(walletStreak)
    .values({ trader, lastQualifiedDay: dayIndex, currentLength: length, longest, updatedAt: args.closedAt })
    .onConflictDoUpdate({ lastQualifiedDay: dayIndex, currentLength: length, longest, updatedAt: args.closedAt });

  return creditCapped(db, {
    id: `streak-${trader}-${dayIndex}`,
    trader,
    component: 'streak',
    requestedRaw: streakDayAwardRaw(length),
    capRaw: null, // once-per-day is the cap
    at: args.closedAt,
    refId: String(dayIndex),
    txHash: args.txHash,
  });
}

/* ---------------- Component 4: pool (LP) ---------------- */

/** Credit the LP points earned since the wallet's balance last changed, at the old balance.
 * Returns the prior state so the caller can compute the new balance from it. */
async function accrueLpPrior(
  db: Db,
  owner: string,
  atSeconds: number,
  txHash: `0x${string}`,
  ledgerId: string,
): Promise<{ balanceRaw: bigint; lastAccrualAt: number } | null> {
  const state = (await db.find(walletLp, { owner })) as { balanceRaw: bigint; lastAccrualAt: number } | null;
  if (state && state.balanceRaw > 0n && atSeconds > state.lastAccrualAt) {
    const heldSeconds = atSeconds - state.lastAccrualAt;
    const requestedRaw = lpPointsRaw({ balanceRaw: state.balanceRaw, heldSeconds });
    if (requestedRaw > 0n) {
      await creditCapped(db, {
        id: `lp-${ledgerId}`,
        trader: owner,
        component: 'lp',
        requestedRaw,
        capRaw: LP_DAILY_CAP_RAW,
        at: atSeconds,
        refId: ledgerId,
        txHash,
      });
    }
  }
  return state;
}

async function setLpBalance(db: Db, owner: string, balanceRaw: bigint, atSeconds: number): Promise<void> {
  await db
    .insert(walletLp)
    .values({ owner, balanceRaw, lastAccrualAt: atSeconds })
    .onConflictDoUpdate({ balanceRaw, lastAccrualAt: atSeconds });
}

/** A claimed deposit: accrue the period up to now at the old balance, then add the deposited
 * USDW assets. */
export async function onLpDepositClaimed(
  db: Db,
  args: { owner: `0x${string}`; assetsRaw: bigint; atSeconds: number; txHash: `0x${string}`; ledgerId: string },
): Promise<void> {
  const owner = args.owner.toLowerCase();
  const prior = await accrueLpPrior(db, owner, args.atSeconds, args.txHash, args.ledgerId);
  const balanceRaw = (prior?.balanceRaw ?? 0n) + args.assetsRaw;
  await setLpBalance(db, owner, balanceRaw, args.atSeconds);
}

/** A claimed withdrawal: accrue the period up to now at the old balance, then remove the
 * withdrawn USDW assets (never below zero). */
export async function onLpWithdrawClaimed(
  db: Db,
  args: { owner: `0x${string}`; assetsRaw: bigint; atSeconds: number; txHash: `0x${string}`; ledgerId: string },
): Promise<void> {
  const owner = args.owner.toLowerCase();
  const prior = await accrueLpPrior(db, owner, args.atSeconds, args.txHash, args.ledgerId);
  const remaining = (prior?.balanceRaw ?? 0n) - args.assetsRaw;
  await setLpBalance(db, owner, remaining < 0n ? 0n : remaining, args.atSeconds);
}
