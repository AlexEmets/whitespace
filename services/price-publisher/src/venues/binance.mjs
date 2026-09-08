/**
 * Binance — individual symbol book ticker stream. Verified live 2026-09-08 against
 * wss://stream.binance.com:9443/ws/btcusdt@bookTicker:
 *   {"u":99849560470,"s":"BTCUSDT","b":"78779.99000000","B":"1.10146000","a":"78780.00000000","A":"2.96360000"}
 * b/a are the best bid/ask price strings (never last trade — this stream has no last
 * trade field at all). The payload carries no exchange timestamp, so the caller's
 * receipt time is used as `ts`; if the connection stalls, receipt time simply stops
 * advancing and the staleness bound in the aggregator does its job.
 */

import { parseDecimalTo18 } from '@whitespace/shared/decimal';

export const id = 'binance';

/** @param {string} symbol e.g. 'BTCUSDT' */
export function wsUrlFor(symbol) {
  return `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@bookTicker`;
}

/** Binance's bookTicker stream needs no subscribe message; the stream is the URL. */
export function subscribePayload() {
  return null;
}

/**
 * @param {unknown} message parsed JSON from the WS frame
 * @param {number} now receipt time, ms epoch — used as `ts` (see module doc)
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(message, now) {
  if (!message || typeof message !== 'object' || typeof message.b !== 'string' || typeof message.a !== 'string') {
    return null;
  }
  return { bid: parseDecimalTo18(message.b), ask: parseDecimalTo18(message.a), ts: now };
}
