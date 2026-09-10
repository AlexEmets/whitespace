'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Candle, CandleInterval, WsMessage } from '@/lib/types';
import { getWsClient } from '@/lib/ws';

/**
 * Historical candles from REST, with the in-progress candle updated live over WS
 * (`candles:<pairIndex>:<interval>`).
 *
 * WHY THIS ROUTES ON THE CHANNEL, NOT THE ENVELOPE TAG. This hook used to drop every
 * frame it received. It filtered on `msg.type !== 'candle'`, but services/api sends
 * `{"type":"update","channel":"candles:0:1m","data":{…}}` (services/api/src/ws.ts, the
 * single `JSON.stringify({ type: 'update', channel, data })` every channel is published
 * through). No frame ever carried `type: "candle"`, so the chart was fed exactly one REST
 * snapshot at mount and then sat still forever — it looked like a rendering problem and
 * was a wire-contract problem.
 *
 * The fix is not to swap one magic string for another. `WsClient` already demultiplexes
 * by `channel` and only calls this listener for the candle channel it was registered on,
 * so the channel *is* the discriminant; the envelope tag is redundant metadata that the
 * two sides disagreed about. What is left to check is the thing that actually matters and
 * was never checked: that `data` has the shape of a candle. `isCandle` does that
 * structurally, so a future envelope rename cannot silently blind the chart again, and a
 * malformed payload is rejected instead of being drawn as `NaN`.
 *
 * Note the payload is validated but NOT parsed here: `o/h/l/c` stay the human decimal
 * strings the API emits, and only src/lib/money.ts is allowed to give them a scale. See
 * that module's header.
 */

/**
 * Structural check for a `/candles` row. Every monetary field must be a string — the API
 * emits human decimals (money.ts's rule) and a JSON number here would mean the wire
 * format changed under us, which must fail loudly rather than round-trip through a float.
 */
export function isCandle(value: unknown): value is Candle {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.t === 'number' &&
    Number.isFinite(c.t) &&
    typeof c.o === 'string' &&
    typeof c.h === 'string' &&
    typeof c.l === 'string' &&
    typeof c.c === 'string' &&
    typeof c.v === 'string'
  );
}

/**
 * Folds one candle into a bucket-ordered series, keyed on `t`.
 *
 * The live channel re-sends the *same* bucket as it accumulates (open fixed, high/low
 * widening, close moving), so the common case is "replace the last element". Appending it
 * instead would draw the in-progress candle once per poll tick — a fake 30-bar rally out
 * of one real bucket. A bucket that is neither the last one nor already present is
 * inserted in order rather than dropped, so a frame that arrives late still lands in the
 * right place instead of being silently lost.
 */
export function upsertCandle(candles: Candle[], next: Candle): Candle[] {
  const last = candles[candles.length - 1];
  if (last === undefined) return [next];
  if (last.t === next.t) return [...candles.slice(0, -1), next];
  if (next.t > last.t) return [...candles, next];
  const at = candles.findIndex((c) => c.t === next.t);
  if (at >= 0) {
    const copy = candles.slice();
    copy[at] = next;
    return copy;
  }
  const before = candles.findIndex((c) => c.t > next.t);
  if (before < 0) return [...candles, next];
  return [...candles.slice(0, before), next, ...candles.slice(before)];
}

type Store = { key: string | null; candles: Candle[] };

export function useCandles(pairIndex: number | null, interval: CandleInterval, from: number, to: number) {
  const channel = pairIndex === null ? null : `candles:${pairIndex}:${interval}`;

  // Keyed by channel so switching interval cannot show the previous interval's bars for a
  // frame, and — more importantly — cannot append a 1m bucket onto a 1h series while the
  // new REST request is still in flight.
  const [store, setStore] = useState<Store>({ key: null, candles: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // The most recent live frame, kept so a REST response that resolves *after* it cannot
  // roll the chart back to the pre-push state. Both writers go through `upsertCandle`, so
  // whichever lands second still produces one correctly ordered series.
  const latestLive = useRef<{ key: string; candle: Candle } | null>(null);

  useEffect(() => {
    if (pairIndex === null || channel === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .candles(pairIndex, interval, from, to)
      .then((data) => {
        if (cancelled) return;
        const live = latestLive.current;
        setStore({ key: channel, candles: live && live.key === channel ? upsertCandle(data, live.candle) : data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pairIndex, interval, from, to, channel]);

  useEffect(() => {
    if (channel === null) return;
    const client = getWsClient();
    const unsubscribe = client.subscribe(channel, (msg: WsMessage) => {
      const data: unknown = msg.data;
      if (!isCandle(data)) return;
      latestLive.current = { key: channel, candle: data };
      setStore((prev) => (prev.key === channel ? { key: channel, candles: upsertCandle(prev.candles, data) } : prev));
    });
    return unsubscribe;
  }, [channel]);

  return { candles: store.key === channel ? store.candles : [], loading, error };
}
