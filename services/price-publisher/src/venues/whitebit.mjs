/**
 * WhiteBIT — public JSON-RPC WS API. Verified live 2026-09-08 against
 * wss://api.whitebit.com/ws with {id,method:'depth_subscribe',params:[market,limit,'0',true]}:
 *
 *   subscribe ack:  {"error":null,"result":{"status":"success"},"id":1}
 *   first update:   {"method":"depth_update","params":[true,
 *                      {"timestamp":1788882538.22,"asks":[["78726.35","0.045088"],...],
 *                       "bids":[["78726.34","0.045088"],...],"event_time":1788882538.32},
 *                      "BTC_USDT"],"id":null}
 *   later update:   {"method":"depth_update","params":[false,
 *                      {"timestamp":1788882538.32,"bids":[["78717.77","0.109043"]],
 *                       "event_time":1788882538.38},
 *                      "BTC_USDT"],"id":null}
 *
 * Unlike the other three venues, this is a genuine incremental order-book diff, not a
 * repeated snapshot: a level with volume "0" means "remove this price level", any
 * other volume means "set/replace this price level", and a later message may touch
 * only one side. `isFullUpdate` (params[0]) additionally means "replace this side
 * outright" (observed: the very first message replaces both sides in full). A local
 * book must therefore be maintained across messages — `applyDepthUpdate` does that,
 * kept pure and independent of the socket so it is unit-testable with synthetic diffs.
 */

import { parseDecimalTo18 } from '@whitespace/shared/decimal';

export const id = 'whitebit';

export const wsUrl = 'wss://api.whitebit.com/ws';

/** @param {string} market e.g. 'BTC_USDT' */
export function subscribePayload(market, requestId = 1) {
  return { id: requestId, method: 'depth_subscribe', params: [market, 10, '0', true] };
}

function isZeroString(s) {
  return /^0+(\.0+)?$/.test(s);
}

/** @returns {{ bids: Map<string,string>, asks: Map<string,string> }} */
export function createBook() {
  return { bids: new Map(), asks: new Map() };
}

function applyLevels(map, levels) {
  for (const [priceStr, volStr] of levels) {
    if (isZeroString(volStr)) map.delete(priceStr);
    else map.set(priceStr, volStr);
  }
}

/**
 * Applies one depth_update `params` triple to a locally maintained book, in place.
 * @param {{ bids: Map, asks: Map }} book
 * @param {[boolean, { asks?: [string,string][], bids?: [string,string][] }, string]} params
 * @returns {{ bids: Map, asks: Map }} the same book, mutated
 */
export function applyDepthUpdate(book, params) {
  const [isFullUpdate, payload] = params ?? [];
  if (!payload) return book;
  if (isFullUpdate) {
    if (payload.bids) book.bids.clear();
    if (payload.asks) book.asks.clear();
  }
  if (payload.bids) applyLevels(book.bids, payload.bids);
  if (payload.asks) applyLevels(book.asks, payload.asks);
  return book;
}

/**
 * Reads the current best bid/ask off a locally maintained book, in the same
 * normalized 18-decimal bigint shape every other venue parser returns. `ts` is taken
 * from the update's own event_time/timestamp (seconds, float) converted to ms.
 * @param {{ bids: Map, asks: Map }} book
 * @param {number} ts ms epoch to attach
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function bestOfBook(book, ts) {
  let bestBid = null;
  for (const priceStr of book.bids.keys()) {
    const p = parseDecimalTo18(priceStr);
    if (bestBid === null || p > bestBid) bestBid = p;
  }
  let bestAsk = null;
  for (const priceStr of book.asks.keys()) {
    const p = parseDecimalTo18(priceStr);
    if (bestAsk === null || p < bestAsk) bestAsk = p;
  }
  if (bestBid === null || bestAsk === null) return null;
  return { bid: bestBid, ask: bestAsk, ts };
}

/**
 * Full pure pipeline for one WS message against a running book: mutates `book` and
 * returns the new best bid/ask tick, or null if the message wasn't a depth_update or
 * the book has no two-sided quote yet.
 * @param {{ bids: Map, asks: Map }} book
 * @param {unknown} message parsed JSON from the WS frame
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(book, message) {
  if (!message || message.method !== 'depth_update' || !Array.isArray(message.params)) return null;
  applyDepthUpdate(book, message.params);
  const payload = message.params[1];
  const eventTimeS = payload?.event_time ?? payload?.timestamp;
  const ts = typeof eventTimeS === 'number' ? Math.round(eventTimeS * 1000) : Date.now();
  return bestOfBook(book, ts);
}
