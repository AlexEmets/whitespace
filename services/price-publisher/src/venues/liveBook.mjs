/**
 * Keeps a venue's last top-of-book valid while its socket is demonstrably alive.
 *
 * The aggregator rejects a tick older than the staleness bound (2 s by default). That
 * measured the time since the venue last CHANGED its best bid/ask, not the time since we
 * last knew it: Bybit's depth-1 stream and WhiteBIT's diff stream only push when the book
 * moves, so a quiet but perfectly live market — WBT above all — aged out of the aggregate
 * between changes, the feed dropped below its venue minimum, and opens were refused
 * intermittently for no reason a trader could see.
 *
 * A book we are still connected to and still hearing from IS the current book. So while
 * any frame (data, pong, ping) has arrived within `liveWindowMs`, the last tick is
 * re-issued with a fresh receipt time. Once the socket goes quiet past that window the
 * refresh stops and the tick ages out exactly as before; past IDLE_TIMEOUT_MS the
 * connection's own watchdog tears the socket down and `reset()` forgets the book. The
 * deviation check in the aggregator still judges a carried book against the other venues,
 * so a book frozen while the market moves is rejected as deviant, not trusted.
 *
 * Pure (no timers, no I/O), so the rules are unit-testable; index.mjs drives it.
 */

/**
 * @param {{ liveWindowMs: number }} opts
 */
export function createLiveBook({ liveWindowMs }) {
  /** @type {{ bid: bigint, ask: bigint, ts: number } | null} */
  let last = null;
  let lastHeardAt = null;

  return {
    /** A parsed tick arrived. */
    record(tick, now) {
      last = tick;
      lastHeardAt = now;
    },
    /** Any inbound frame arrived, carrying data or not. */
    heard(now) {
      lastHeardAt = now;
    },
    /** The last tick re-stamped at `now`, or null when there is none or the socket is quiet. */
    refresh(now) {
      if (last === null || lastHeardAt === null) return null;
      if (now - lastHeardAt > liveWindowMs) return null;
      return { ...last, ts: now };
    },
    /** The connection is gone: its book means nothing any more. */
    reset() {
      last = null;
      lastHeardAt = null;
    },
  };
}
