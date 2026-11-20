/**
 * The DEGRADED log line. It used to name only the healthy venues, so a market that dropped a
 * source (WBT/USD loses WhiteBIT spot for hours most nights) could not be diagnosed from the
 * log: whether the book went stale, its spread widened past the bound, it drifted from the
 * other venue, or the socket had no book at all are four different fixes. Each venue the
 * market is connected to is now accounted for.
 */

function describe({ reason, detail }) {
  if (reason === 'stale' && detail) return `stale ${detail.ageMs}ms>${detail.boundMs}ms`;
  if (reason === 'wide_spread' && detail) return `wide_spread ${detail.spreadBps}bps>${detail.boundBps}bps`;
  if (reason === 'deviant' && detail) return `deviant ${detail.deviationBps}bps>${detail.boundBps}bps`;
  return reason;
}

/**
 * @param {{ feed: string, aggregate: { healthyCount: number, minHealthyVenues: number, healthyVenues: string[],
 *   rejected?: { tick: { venue: string }, reason: string, detail?: any }[] }, mark: unknown, venues: string[] }} args
 *   `venues` are the venues this process connects for the feed.
 */
export function formatDegradedLine({ feed, aggregate, mark, venues }) {
  const rejected = aggregate.rejected ?? [];
  const accounted = new Set([...aggregate.healthyVenues, ...rejected.map((r) => r.tick.venue)]);
  const parts = [
    ...rejected.map((r) => `${r.tick.venue}:${describe(r)}`),
    ...venues.filter((v) => !accounted.has(v)).map((v) => `${v}:no_book`),
  ];
  return (
    `[price-publisher] ${feed} DEGRADED: healthy=${aggregate.healthyCount}/${aggregate.minHealthyVenues} ` +
    `venues=[${aggregate.healthyVenues.join(',')}] rejected=[${parts.join(',')}] mark=${mark}`
  );
}
