/**
 * Runtime WS wiring for the four venues. This module is the I/O layer — it is not
 * unit-tested (per the task's constraints: "no network access in unit tests"); the
 * pure parse/reducer logic each venue file exports is what's tested. This file is
 * exercised by `node src/main.mjs` (manual, live-venue run — see README notes in
 * docs/decisions/phase-3-price-publisher.md for whether that was actually run).
 */

import WebSocket from 'ws';
import * as binance from './binance.mjs';
import * as bybit from './bybit.mjs';
import * as okx from './okx.mjs';
import * as whitebit from './whitebit.mjs';

export const VENUE_MODULES = { binance, bybit, okx, whitebit };

const RECONNECT_DELAY_MS = 2_000;

/**
 * Connects one venue's WS feed for one market symbol and calls `onTick` with every
 * normalized { venue, bid, ask, ts } update. Reconnects with a fixed backoff on
 * close/error — "venue disconnects -> drop it, continue on the rest" (design spec §7)
 * is enforced one level up, by the aggregator simply not seeing fresh ticks from a
 * venue that is down; this loop's job is only to keep trying to come back.
 *
 * @param {'binance'|'bybit'|'okx'|'whitebit'} venueId
 * @param {string} symbol venue-specific symbol, e.g. 'BTCUSDT' or 'BTC_USDT'
 * @param {(tick: { venue: string, bid: bigint, ask: bigint, ts: number }) => void} onTick
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} stop function
 */
export function connectVenue(venueId, symbol, onTick, onError = () => {}) {
  const mod = VENUE_MODULES[venueId];
  if (!mod) throw new Error(`connectVenue: unknown venue "${venueId}"`);

  let stopped = false;
  let ws;
  let book = venueId === 'whitebit' ? whitebit.createBook() : null;

  function connect() {
    if (stopped) return;
    const url = typeof mod.wsUrlFor === 'function' ? mod.wsUrlFor(symbol) : mod.wsUrl;
    ws = new WebSocket(url);

    ws.on('open', () => {
      const payload = mod.subscribePayload?.(symbol);
      if (payload) ws.send(JSON.stringify(payload));
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const tick = venueId === 'whitebit' ? mod.parseMessage(book, message) : mod.parseMessage(message, Date.now());
        if (tick) onTick({ venue: venueId, ...tick });
      } catch (err) {
        onError(err);
      }
    });

    ws.on('error', (err) => onError(err));

    ws.on('close', () => {
      if (venueId === 'whitebit') book = whitebit.createBook();
      if (!stopped) setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  connect();

  return function stop() {
    stopped = true;
    ws?.close();
  };
}
