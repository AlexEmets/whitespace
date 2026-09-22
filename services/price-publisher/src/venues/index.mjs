/**
 * Runtime WS wiring for the venues. This module is the I/O layer — it is not
 * unit-tested (per the task's constraints: "no network access in unit tests"); the
 * pure parse/reducer logic each venue file exports is what's tested. This file is
 * exercised by `node src/main.mjs` (manual, live-venue run — see README notes in
 * docs/decisions/phase-3-price-publisher.md for whether that was actually run).
 *
 * Venues come in two shapes and the difference is a capability, not an identity: a venue
 * whose module exports `createBook` streams incremental order-book diffs and needs a
 * locally maintained book threaded through `parseMessage(book, message)`, while the rest
 * push self-contained snapshots parsed as `parseMessage(message, now)`. This used to be
 * branched on `venueId === 'whitebit'` in three places, which silently excluded any second
 * diff-based venue from book handling — it would connect, parse nothing, and simply never
 * produce a tick.
 */

import WebSocket from 'ws';
import * as binance from './binance.mjs';
import * as bybit from './bybit.mjs';
import * as okx from './okx.mjs';
import * as whitebit from './whitebit.mjs';
import * as whitebit_perp from './whitebit_perp.mjs';

export const VENUE_MODULES = { binance, bybit, okx, whitebit, whitebit_perp };

/** Whether a venue module maintains an incremental order book across messages. */
function usesLocalBook(mod) {
  return typeof mod.createBook === 'function';
}

const RECONNECT_DELAY_MS = 2_000;

/**
 * Liveness, because "the socket is open" and "the venue is still talking to us" are not
 * the same claim.
 *
 * This loop used to reconnect only on `close`/`error`. A TCP connection whose peer
 * vanished without a FIN or RST — a dropped NAT mapping, a silently rebooted edge node,
 * a network partition — stays `ESTABLISHED` forever and emits neither event, so
 * `connect()` was never rescheduled. Observed exactly that on this stack: all four venue
 * sockets sat open with empty queues, `healthyCount` was 0, and the publisher went 9.6
 * hours without producing a single tick. Nothing recovered it because nothing could:
 * there was no code path from "half-open" back to "connect".
 *
 * That is a total outage for the product, not a degradation — the keeper has no signed
 * report to deliver, so no order can be filled at all.
 *
 * Two mechanisms, because they fail differently:
 *   - a periodic protocol-level PING, which forces the peer to prove it is there;
 *   - an idle watchdog on ANY inbound frame (message or pong), which catches the case
 *     where the peer is technically alive but has stopped sending our subscription.
 * Every venue here pushes at least one frame per second under normal conditions, so a
 * 20s silence is unambiguous rather than a slow-market false positive.
 */
const PING_INTERVAL_MS = 8_000;
const IDLE_TIMEOUT_MS = 20_000;

/**
 * Connects one venue's WS feed for one market symbol and calls `onTick` with every
 * normalized { venue, bid, ask, ts } update. Reconnects with a fixed backoff on
 * close/error — "venue disconnects -> drop it, continue on the rest" (design spec §7)
 * is enforced one level up, by the aggregator simply not seeing fresh ticks from a
 * venue that is down; this loop's job is only to keep trying to come back.
 *
 * @param {'binance'|'bybit'|'okx'|'whitebit'|'whitebit_perp'} venueId
 * @param {string} symbol venue-specific symbol, e.g. 'BTCUSDT', 'BTC_USDT' or 'WBT_PERP'
 * @param {(tick: { venue: string, bid: bigint, ask: bigint, ts: number }) => void} onTick
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} stop function
 */
export function connectVenue(venueId, symbol, onTick, onError = () => {}) {
  const mod = VENUE_MODULES[venueId];
  if (!mod) throw new Error(`connectVenue: unknown venue "${venueId}"`);

  const bookBased = usesLocalBook(mod);

  let stopped = false;
  let ws;
  let book = bookBased ? mod.createBook() : null;

  function connect() {
    if (stopped) return;
    const url = typeof mod.wsUrlFor === 'function' ? mod.wsUrlFor(symbol) : mod.wsUrl;
    const socket = new WebSocket(url);
    ws = socket;

    let lastSeen = Date.now();
    let pingTimer = null;
    let idleTimer = null;
    // One reconnect per connection attempt. Without this, terminating a stale socket
    // schedules a reconnect from the watchdog AND again from the `close` it provokes,
    // and the venue ends up with two live sockets racing each other.
    let settled = false;

    const clearTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (idleTimer) clearInterval(idleTimer);
      pingTimer = null;
      idleTimer = null;
    };

    const reconnect = (reason) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (reason) onError(new Error(`${venueId}: ${reason}`));
      // `terminate`, not `close`: a graceful close waits for a FIN that a half-open peer
      // will never send, which is the exact state being escaped here.
      socket.terminate();
      if (bookBased) book = mod.createBook();
      if (!stopped) setTimeout(connect, RECONNECT_DELAY_MS);
    };

    const seen = () => {
      lastSeen = Date.now();
    };

    socket.on('open', () => {
      seen();
      const payload = mod.subscribePayload?.(symbol);
      if (payload) socket.send(JSON.stringify(payload));

      pingTimer = setInterval(() => {
        // readyState is checked because a socket can leave OPEN between ticks of this
        // timer, and ping() on a closing socket throws.
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.ping();
          } catch {
            reconnect('ping failed');
          }
        }
      }, PING_INTERVAL_MS);

      idleTimer = setInterval(() => {
        if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
          reconnect(`no frame for ${Math.round((Date.now() - lastSeen) / 1000)}s — assuming half-open`);
        }
      }, IDLE_TIMEOUT_MS / 2);
    });

    // A pong counts as liveness even though it carries no market data: it proves the peer
    // is answering, which is what distinguishes "quiet market" from "dead socket".
    socket.on('pong', seen);
    socket.on('ping', seen);

    socket.on('message', (raw) => {
      seen();
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const tick = bookBased ? mod.parseMessage(book, message) : mod.parseMessage(message, Date.now());
        if (tick) onTick({ venue: venueId, ...tick });
      } catch (err) {
        onError(err);
      }
    });

    socket.on('error', (err) => {
      onError(err);
      // Do not reconnect here — `ws` follows an 'error' with a 'close', and reconnecting
      // from both would double up. The guard in `reconnect` would catch it, but relying on
      // the guard for the ordinary path hides which handler owns recovery.
    });

    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (bookBased) book = mod.createBook();
      if (!stopped) setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  connect();

  return function stop() {
    stopped = true;
    ws?.terminate();
  };
}
