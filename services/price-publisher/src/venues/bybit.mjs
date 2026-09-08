/**
 * Bybit — v5 public spot, top-of-book depth (NOT the `tickers` channel: verified live
 * 2026-09-08 that `tickers.BTCUSDT` carries only lastPrice/24h stats, no bid/ask at
 * all — using it would violate "mid of best bid/ask, never last trade"). Subscribing
 * to `orderbook.1.<symbol>` gives depth-1 top-of-book, and at depth 1 every message
 * observed was a full snapshot (not an incremental patch):
 *   {"topic":"orderbook.1.BTCUSDT","ts":1788882595939,"type":"snapshot",
 *    "data":{"s":"BTCUSDT","b":[["78779.7","0.144931"]],"a":[["78779.8","0.584126"]],...}}
 */

import { parseDecimalTo18 } from '@whitespace/shared/decimal';

export const id = 'bybit';

export const wsUrl = 'wss://stream.bybit.com/v5/public/spot';

/** @param {string} symbol e.g. 'BTCUSDT' */
export function subscribePayload(symbol) {
  return { op: 'subscribe', args: [`orderbook.1.${symbol}`] };
}

/**
 * @param {unknown} message parsed JSON from the WS frame
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.topic !== 'string') return null;
  if (!message.topic.startsWith('orderbook.')) return null;
  const data = message.data;
  const bidLevel = data?.b?.[0];
  const askLevel = data?.a?.[0];
  if (!bidLevel || !askLevel || typeof message.ts !== 'number') return null;
  return { bid: parseDecimalTo18(bidLevel[0]), ask: parseDecimalTo18(askLevel[0]), ts: message.ts };
}
