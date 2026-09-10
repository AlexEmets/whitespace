/**
 * Read-only client for services/price-publisher's `GET /status`.
 *
 * Why this exists: until now the API's only price source was the `price_report` table —
 * the last signed report that actually landed on chain. A report only lands when someone
 * places an order, so between orders the terminal showed a frozen price: measured at
 * 78,634.60 on screen against a live index of 78,117.06, a 517 USD gap that simply grew
 * with time since the last trade. A perp DEX cannot quote a stale price to the trader
 * about to open against it.
 *
 * The publisher is the authority on the live index and mark (it holds the venue
 * connections, the weighted median and the EMA). It is NOT authoritative about what the
 * chain settled at — that stays with `price_report`, which is why the callers here treat
 * a publisher miss as "fall back to the last on-chain report" rather than an error.
 *
 * Every failure mode is a `null` return, never a throw: the publisher is a separate
 * process that may be restarting, and a read route must degrade to on-chain data rather
 * than 500 because a sidecar blinked.
 */

/**
 * Resolved per call, not captured at module load, so a test can decide what this service
 * talks to. Setting `PUBLISHER_URL` to the empty string disables the client outright and
 * every read falls back to on-chain data — which is what makes the fallback path
 * testable at all. Without this the suite silently talked to whatever publisher happened
 * to be running on the developer's machine, and its price assertions became a coin flip.
 */
function publisherUrl(): string | null {
  const configured = process.env.PUBLISHER_URL;
  if (configured === '') return null;
  return configured ?? 'http://127.0.0.1:8787';
}

/** How long a `/status` response may be reused. The publisher resamples its mark EMA on
 * its own timer (bounds.markEmaSampleIntervalMs, currently 1s), so anything below that
 * only multiplies HTTP calls without adding information. Sized under the WS poll
 * interval (2s) so a subscriber never sees the same cached tick twice in a row. */
const CACHE_TTL_MS = 900;

/** Shape of one feed in the publisher's `/status` payload. Its `sendJson` serialises
 * bigints as decimal strings, so `mark`/`index` arrive as raw 18-decimal integer digits
 * with no decimal point — the same form `price_report.price` has in Postgres, which is
 * what lets both sources share one formatter downstream. */
export type PublisherFeed = {
  /** Raw PRECISION_18 integer digits, or null before the EMA has its first sample. */
  mark: string | null;
  index: string | null;
  /** The aggregated two-sided quote behind `index`, same raw scale. Null when the
   * aggregate has no bid/ask — never silently replaced by the mark, because a zero spread
   * and an unknown spread mean very different things to anything pricing a fill. */
  indexBid: string | null;
  indexAsk: string | null;
  healthyCount: number;
  healthyVenues: string[];
  degraded: boolean;
  noData: boolean;
};

type StatusResponse = { feeds: Record<string, PublisherFeed> };

let cache: { at: number; feeds: Record<string, PublisherFeed> } | null = null;
let inFlight: Promise<Record<string, PublisherFeed> | null> | null = null;

async function fetchStatus(): Promise<Record<string, PublisherFeed> | null> {
  const base = publisherUrl();
  if (base === null) return null;
  try {
    // AbortSignal.timeout, not a bare fetch: without a deadline a publisher that accepts
    // the connection and then stalls would hang every price request behind it.
    const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as StatusResponse;
    return body?.feeds ?? null;
  } catch {
    return null;
  }
}

/**
 * Current publisher state for every feed, or null if the publisher is unreachable.
 *
 * Concurrent callers within one TTL window share a single HTTP request (`inFlight`).
 * The WS poll loop fans out over every subscribed channel at once, so without this a
 * dozen subscribers would each open their own socket to the publisher on the same tick.
 */
export async function getPublisherFeeds(now = Date.now()): Promise<Record<string, PublisherFeed> | null> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.feeds;
  if (inFlight) return inFlight;

  inFlight = fetchStatus()
    .then((feeds) => {
      if (feeds) cache = { at: now, feeds };
      return feeds;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** One feed by name (`"BTC/USD"`), or null if the publisher is down or does not track it. */
export async function getPublisherFeed(feed: string): Promise<PublisherFeed | null> {
  const feeds = await getPublisherFeeds();
  return feeds?.[feed] ?? null;
}

/** The publisher's feed name for a market row. The `market` table stores the pair split
 * into `from_symbol`/`to_symbol`; packages/shared/src/markets.mjs keys the same market as
 * `"BTC/USD"`. One place to join them, so the convention is not re-derived per route. */
export function feedNameOf(fromSymbol: string, toSymbol: string): string {
  return `${fromSymbol}/${toSymbol}`;
}

/** Test seam: drops the memo so a test can change the publisher's answer between cases. */
export function resetPublisherCache(): void {
  cache = null;
  inFlight = null;
}
