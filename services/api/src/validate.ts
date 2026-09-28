import type { RouteResult } from './router.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A 20-byte hex address, lowercased (the indexer stores addresses lowercase), or null. */
export function parseAddress(raw: string | undefined): string | null {
  if (raw === undefined || !ADDRESS_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/** `?limit=` as an integer in [1, max]; the default when absent; null when malformed. */
export function parseLimit(searchParams: URLSearchParams, fallback: number, max: number): number | null {
  const raw = searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

export function badRequest(error: string): RouteResult {
  return { code: 400, body: { error } };
}
