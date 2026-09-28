import { query, queryOne } from '../db.js';
import { points, collateral } from '../format.js';
import type { Handler, RouteResult } from '../router.js';
import type { PointsSummary, LeaderboardEntry } from '../types.js';
import { parseAddress, parseLimit, badRequest } from '../validate.js';

type WalletPointsRow = {
  missions_raw: string;
  time_raw: string;
  streak_raw: string;
  lp_raw: string;
  total_raw: string;
  updated_at: number;
};

// GET /points/:address -> PointsSummary. Reads the wallet's aggregate row (kept in step with
// the ledger by the indexer), its streak state, the missions it has unlocked, and its rank
// (how many wallets sit strictly above it). A wallet that has earned nothing has no aggregate
// row: that is a genuine zero, not an error, so it returns zeros with a null rank.
export const handlePoints: Handler = async (_req, params): Promise<RouteResult> => {
  const trader = parseAddress(params.address);
  if (!trader) return badRequest('invalid address');

  const wp = await queryOne<WalletPointsRow>(
    `SELECT missions_raw, time_raw, streak_raw, lp_raw, total_raw, updated_at
       FROM wallet_points WHERE trader = $1`,
    [trader],
  );
  const streak = await queryOne<{ current_length: number; longest: number }>(
    `SELECT current_length, longest FROM wallet_streak WHERE trader = $1`,
    [trader],
  );
  const missions = await query<{ ref_id: string }>(
    `SELECT ref_id FROM points_event WHERE trader = $1 AND component = 'mission' ORDER BY at, ref_id`,
    [trader],
  );
  const lp = await queryOne<{ balance_raw: string; last_accrual_at: number }>(
    `SELECT balance_raw, last_accrual_at FROM wallet_lp WHERE owner = $1`,
    [trader],
  );

  let rank: number | null = null;
  if (wp) {
    const above = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM wallet_points WHERE total_raw > $1`,
      [wp.total_raw],
    );
    rank = Number(above!.n) + 1;
  }

  const body: PointsSummary = {
    address: trader,
    missions: points(wp?.missions_raw ?? '0')!,
    time: points(wp?.time_raw ?? '0')!,
    streak: points(wp?.streak_raw ?? '0')!,
    lp: points(wp?.lp_raw ?? '0')!,
    total: points(wp?.total_raw ?? '0')!,
    rank,
    streakDays: streak?.current_length ?? 0,
    streakLongest: streak?.longest ?? 0,
    completedMissions: missions.map((m) => m.ref_id),
    updatedAt: wp?.updated_at ?? null,
    lpBalance: collateral(lp?.balance_raw ?? '0')!,
    lpSince: lp?.last_accrual_at ?? null,
  };
  return { code: 200, body };
};

// GET /points/leaderboard?limit= -> LeaderboardEntry[], ranked by total points descending.
// Ties break by address so the order is stable across calls.
export const handleLeaderboard: Handler = async (_req, _params, searchParams): Promise<RouteResult> => {
  const limit = parseLimit(searchParams, 100, 500);
  if (limit === null) return badRequest('invalid limit');

  const rows = await query<{ trader: string } & WalletPointsRow>(
    `SELECT trader, missions_raw, time_raw, streak_raw, lp_raw, total_raw
       FROM wallet_points ORDER BY total_raw DESC, trader ASC LIMIT $1`,
    [limit],
  );

  const body: LeaderboardEntry[] = rows.map((row, i) => ({
    rank: i + 1,
    address: row.trader,
    missions: points(row.missions_raw)!,
    time: points(row.time_raw)!,
    streak: points(row.streak_raw)!,
    lp: points(row.lp_raw)!,
    total: points(row.total_raw)!,
  }));
  return { code: 200, body };
};
