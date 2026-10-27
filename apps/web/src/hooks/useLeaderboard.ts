'use client';

import { api } from '@/lib/api';
import type { LeaderboardEntry } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/**
 * The season-one leaderboard from GET /points/leaderboard — the top 100 wallets, ranked by the
 * indexer. Public, so it loads with or without a wallet. Poll-only and slow: ranks move only
 * when a trade or claim settles, the same cadence as a wallet's own confirmed points.
 */
export function useLeaderboard() {
  const { data, error, loading } = useLiveResource<LeaderboardEntry[]>({
    channel: null,
    pollMs: 30000,
    fetcher: () => api.leaderboard(100),
    extractFromWs: () => null,
  });
  return { entries: data, error, loading };
}
