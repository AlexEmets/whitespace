/**
 * The venue list, in exactly one place. services/price-publisher owns the WebSocket
 * connection details (URLs, subscribe payloads, parsers); this module only fixes the
 * canonical set of venue ids and their default weight in the weighted-median index, so
 * nothing downstream has to agree on spelling.
 */

export const VENUE_IDS = ['binance', 'bybit', 'okx', 'whitebit'];

/** @type {Record<string, { id: string, displayName: string, weight: bigint }>} */
export const VENUES = {
  binance: { id: 'binance', displayName: 'Binance', weight: 1n },
  bybit: { id: 'bybit', displayName: 'Bybit', weight: 1n },
  okx: { id: 'okx', displayName: 'OKX', weight: 1n },
  whitebit: { id: 'whitebit', displayName: 'WhiteBIT', weight: 1n },
};

/**
 * @param {string} venueId
 * @returns {bigint}
 */
export function weightOf(venueId) {
  return VENUES[venueId]?.weight ?? 1n;
}
