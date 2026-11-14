'use client';

import { api } from '@/lib/api';
import type { VaultPerformance } from '@/lib/types';
import { useLiveResource } from './useLiveResource';

/**
 * The vault's returns from GET /vault/performance. They move only when the vault settles
 * (about hourly), so a slow poll is plenty; public, so it loads with or without a wallet.
 */
export function useVaultPerformance() {
  const { data, error, loading } = useLiveResource<VaultPerformance>({
    channel: null,
    pollMs: 60_000,
    fetcher: () => api.vaultPerformance(),
    extractFromWs: () => null,
  });
  return { performance: data, error, loading };
}
