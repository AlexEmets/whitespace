/**
 * OKX — v5 public tickers channel. Verified live 2026-09-08 against
 * wss://ws.okx.com:8443/ws/v5/public:
 *   {"arg":{"channel":"tickers","instId":"BTC-USDT"},
 *    "data":[{"instId":"BTC-USDT","bidPx":"78760","askPx":"78760.1","ts":"1788882603169",...}]}
 * Each push is a full snapshot (bidPx/askPx are always present together), and `ts` is
 * the exchange's own event time in ms (as a decimal string), used directly.
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
 * @returns {{ bid: bigint, ask: bigint, ts: number }|null}
 */
export function parseMessage(message) {
  if (!message || typeof message !== 'object' || message.arg?.channel !== 'tickers') return null;
  const entry = message.data?.[0];
  if (!entry || typeof entry.bidPx !== 'string' || typeof entry.askPx !== 'string') return null;
  const ts = Number(entry.ts);
  if (!Number.isFinite(ts)) return null;
  return { bid: parseDecimalTo18(entry.bidPx), ask: parseDecimalTo18(entry.askPx), ts };
}
