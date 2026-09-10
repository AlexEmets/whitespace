/**
 * Timestamps in this app arrive as unix seconds (`openedAt`, `closedAt`, `requestedAt`).
 *
 * They are rendered in UTC, not in the viewer's locale. Two reasons, both practical: a
 * trading record has to mean the same thing to the trader and to whoever they show it to,
 * and `toLocaleString` renders differently on the server and in the browser, which in a
 * React tree is a hydration mismatch waiting for the first user in a non-en-US locale.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-09-08 10:24 UTC` — minute resolution, which is all a trade list needs. */
export function formatUtcMinute(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** `2026-09-08` — for date-only summaries. */
export function formatUtcDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Compact holding period, e.g. `10s`, `4m 12s`, `3h 05m`, `2d 07h`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(Math.floor(seconds % 60))}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
  return `${Math.floor(seconds / 86_400)}d ${pad(Math.floor((seconds % 86_400) / 3600))}h`;
}
