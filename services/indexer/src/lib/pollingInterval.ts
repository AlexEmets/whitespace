/** Head-polling interval in ms (PONDER_POLLING_INTERVAL_MS, default 2000, min 500). */
export function parsePollingInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 2000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 500) {
    throw new Error(`PONDER_POLLING_INTERVAL_MS must be an integer >= 500, got ${raw}`);
  }
  return n;
}

/**
 * Largest eth_getLogs span (PONDER_GETLOGS_BLOCK_RANGE, default 9000, 1..10000).
 *
 * Left unset, Ponder discovers the limit by trying ranges and reading the errors, and logs a
 * WARN with a full viem stack for each one. The public 1874 RPC refuses anything above 10,000
 * blocks; on prod those warnings, together with rate-limit retries, grew syslog by gigabytes a
 * day until the disk filled and Postgres went into a crash/recovery loop.
 */
export function parseGetLogsBlockRange(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 9000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) {
    throw new Error(`PONDER_GETLOGS_BLOCK_RANGE must be an integer in 1..10000, got ${raw}`);
  }
  return n;
}
