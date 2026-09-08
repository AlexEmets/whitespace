'use client';

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/config';

/**
 * Backs the header's "WHITECHAIN · BLOCK <n> · <n> MS" readout. `indexedBlock` comes
 * straight from GET /health. The "MS" figure is this browser's own measured round-trip
 * latency to that same request (via `performance.now()`) — a real, locally-observed
 * number, not a re-interpretation of `lagSeconds` (which is indexer lag, a different
 * quantity) and not a fabricated figure.
 */
export function useHealth() {
  const [indexedBlock, setIndexedBlock] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const start = performance.now();
      try {
        const res = await fetch(`${API_BASE_URL}/health`);
        const elapsed = Math.round(performance.now() - start);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { indexedBlock: number };
        if (cancelled) return;
        setIndexedBlock(data.indexedBlock);
        setLatencyMs(elapsed);
      } catch {
        if (!cancelled) {
          setIndexedBlock(null);
          setLatencyMs(null);
        }
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { indexedBlock, latencyMs };
}
