/** Head-polling interval in ms (PONDER_POLLING_INTERVAL_MS, default 2000, min 500). */
export function parsePollingInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 2000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 500) {
    throw new Error(`PONDER_POLLING_INTERVAL_MS must be an integer >= 500, got ${raw}`);
  }
  return n;
}
