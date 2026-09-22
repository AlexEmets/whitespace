/**
 * The venue list, in exactly one place. services/price-publisher owns the WebSocket
 * connection details (URLs, subscribe payloads, parsers); this module only fixes the
 * canonical set of venue ids and their default weight in the weighted-median index, so
 * nothing downstream has to agree on spelling.
 */

export const VENUE_IDS = ['binance', 'bybit', 'okx', 'whitebit', 'whitebit_perp'];

/**
 * `whitebit_perp` is WhiteBIT's perpetual book (`*_PERP`), tracked as a source distinct
 * from its spot book (`whitebit`) rather than as a separate exchange. It exists for
 * markets that no other venue lists — see `MARKET_BOUNDS_OVERRIDES` in ./bounds.mjs.
 *
 * It is NOT venue diversity: both books share one operator, one API host and one outage
 * domain, so it defends against a single book glitching, not against WhiteBIT being
 * wrong or down. Markets quoted by real competing exchanges must not use it as a way to
 * reach the healthy-venue minimum on one exchange's word.
 *
 * Adding it here is safe for every existing market: main.mjs skips any venue a market
 * declares no symbol for (`if (!symbol) continue`), and only WBT/USD declares this one.
 *
 * @type {Record<string, { id: string, displayName: string, weight: bigint }>}
 */
export const VENUES = {
  binance: { id: 'binance', displayName: 'Binance', weight: 1n },
  bybit: { id: 'bybit', displayName: 'Bybit', weight: 1n },
  okx: { id: 'okx', displayName: 'OKX', weight: 1n },
  whitebit: { id: 'whitebit', displayName: 'WhiteBIT', weight: 1n },
  whitebit_perp: { id: 'whitebit_perp', displayName: 'WhiteBIT (perp)', weight: 1n },
};

/**
 * @param {string} venueId
 * @returns {bigint}
 */
export function weightOf(venueId) {
  return VENUES[venueId]?.weight ?? 1n;
}
