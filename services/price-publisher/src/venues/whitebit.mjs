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
 *
 * Every frame also carries `update_id` and `past_update_id`: a diff applies only on top of the
 * frame whose `update_id` equals its `past_update_id`. A frame that is lost breaks that chain,
 * and the level it would have removed stays in the local book for good. Ignoring the chain
 * left WBT/USD's books crossed (best ask at or under best bid) for hours on end — the
 * connector re-issues the last tick while the socket is alive, so the publisher rejected
 * both WhiteBIT books as invalid_quote and refused opens, and for hours at a time closes
 * too (2026-11-20/21: over seven hours a day degraded). A broken chain, or a book that has
 * crossed for any other reason (an exchange book never does), now marks the book out of
 * sync: it yields no tick, and `needsResync` tells the connector to subscribe again, which
 * starts over from a full snapshot.
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

/**
 * Levels are keyed by the price as an 18-decimal integer string, not the text the venue sent,
 * so '58.41' and '58.410' are the same level and a removal always finds what it removes.
 * `lastUpdateId` is the `update_id` of the last applied frame; `outOfSync` is set once the
 * book can no longer be trusted (see the module comment).
 * @returns {{ bids: Map<string,string>, asks: Map<string,string>, lastUpdateId: number|undefined, outOfSync: boolean }}
 */
export function createBook() {
  return { bids: new Map(), asks: new Map(), lastUpdateId: undefined, outOfSync: false };
}

function applyLevels(map, levels) {
  for (const [priceStr, volStr] of levels) {
    const key = parseDecimalTo18(priceStr).toString();
    if (isZeroString(volStr)) map.delete(key);
    else map.set(key, volStr);
  }
}

/** True once the book has lost a frame or crossed; the connector must subscribe again. */
export function needsResync(book) {
  return Boolean(book?.outOfSync);
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
    // A full snapshot replaces what it carries and restarts the sequence.
    if (payload.bids) book.bids.clear();
    if (payload.asks) book.asks.clear();
    book.outOfSync = false;
  } else {
    if (book.outOfSync) return book; // nothing applies on top of a broken book
    const chained = payload.past_update_id === undefined || book.lastUpdateId === undefined || payload.past_update_id === book.lastUpdateId;
    if (!chained) {
      book.outOfSync = true;
      return book;
    }
  }
  if (payload.bids) applyLevels(book.bids, payload.bids);
  if (payload.asks) applyLevels(book.asks, payload.asks);
  if (payload.update_id !== undefined) book.lastUpdateId = payload.update_id;
  return book;
}

/**
 * Reads the current best bid/ask off a locally maintained book, in the same
 * normalized 18-decimal bigint shape every other venue parser returns, stamped `ts`.
 * @param {{ bids: Map, asks: Map }} book
 * @param {number} ts ms epoch to attach
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function bestOfBook(book, ts) {
  if (book.outOfSync) return null;
  let bestBid = null;
  for (const key of book.bids.keys()) {
    const p = BigInt(key);
    if (bestBid === null || p > bestBid) bestBid = p;
  }
  let bestAsk = null;
  for (const key of book.asks.keys()) {
    const p = BigInt(key);
    if (bestAsk === null || p < bestAsk) bestAsk = p;
  }
  if (bestBid === null || bestAsk === null) return null;
  if (bestAsk <= bestBid) {
    // An exchange book never crosses; ours has, so it missed something.
    book.outOfSync = true;
    return null;
  }
  return { bid: bestBid, ask: bestAsk, ts };
}

/**
 * Full pure pipeline for one WS message against a running book: mutates `book` and
 * returns the new best bid/ask tick, or null if the message wasn't a depth_update or
 * the book has no two-sided quote yet.
 * @param {{ bids: Map, asks: Map }} book
 * `ts` is the RECEIPT time `now`, not the frame's event_time: staleness is judged against
 * this box's clock, and an exchange timestamp put any offset between the two clocks
 * straight into the staleness bound, rejecting live data as stale.
 * @param {unknown} message parsed JSON from the WS frame
 * @param {number} [now] receipt time, ms epoch
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(book, message, now = Date.now()) {
  if (!message || message.method !== 'depth_update' || !Array.isArray(message.params)) return null;
  applyDepthUpdate(book, message.params);
  return bestOfBook(book, now);
}
