/**
 * OKX — v5 public tickers channel. Verified live 2026-09-08 against
 * wss://ws.okx.com:8443/ws/v5/public:
 *   {"arg":{"channel":"tickers","instId":"BTC-USDT"},
 *    "data":[{"instId":"BTC-USDT","bidPx":"78760","askPx":"78760.1","ts":"1788882603169",...}]}
 * Each push is a full snapshot (bidPx/askPx are always present together). The frame's
 * own `ts` (exchange event time) is deliberately not used.
 *
 * `ts` is the caller's RECEIPT time, not the exchange's event time. Staleness is judged
 * against this box's clock, so an exchange timestamp put any clock offset between the two
 * straight into the 2 s staleness bound: a venue whose clock (or ours) ran 2 s apart was
 * rejected as stale on every tick while delivering perfectly live data.
 */

import { parseDecimalTo18 } from '@whitespace/shared/decimal';

export const id = 'okx';

export const wsUrl = 'wss://ws.okx.com:8443/ws/v5/public';

/** @param {string} instId e.g. 'BTC-USDT' */
export function subscribePayload(instId) {
  return { op: 'subscribe', args: [{ channel: 'tickers', instId }] };
}

/**
 * @param {unknown} message parsed JSON from the WS frame
 * @param {number} [now] receipt time, ms epoch — used as `ts` (see module doc)
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(message, now = Date.now()) {
  if (!message || typeof message !== 'object' || message.arg?.channel !== 'tickers') return null;
  const entry = message.data?.[0];
  if (!entry || typeof entry.bidPx !== 'string' || typeof entry.askPx !== 'string') return null;
  return { bid: parseDecimalTo18(entry.bidPx), ask: parseDecimalTo18(entry.askPx), ts: now };
}
