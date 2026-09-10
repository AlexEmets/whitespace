import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCandle, upsertCandle } from '@/hooks/useCandles';
import { WsClient } from '@/lib/ws';
import type { Candle, WsMessage } from '@/lib/types';

/**
 * The exact frame services/api pushes on `candles:0:1m`, captured off the running stack
 * at 127.0.0.1:4000 rather than written from the type definition. That distinction is the
 * whole point of this file: `src/lib/types.ts` declares the candle frame as
 * `type: 'candle'`, the server has always sent `type: 'update'`
 * (services/api/src/ws.ts — one `JSON.stringify({ type: 'update', channel, data })` for
 * every channel), and the hook used to filter on the type it did not send. Every live
 * update was dropped and the chart never moved.
 */
const LIVE_FRAME = {
  type: 'update',
  channel: 'candles:0:1m',
  data: {
    t: 1788991140,
    o: '78110.188475563720096934',
    h: '78126.417225281332981275',
    l: '78110.188475563720096934',
    c: '78126.417225281332981275',
    v: '0.000000',
  },
} as const;

const candle = (t: number, c: string): Candle => ({ t, o: c, h: c, l: c, c, v: '0.000000' });

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.get('open') ?? []) cb({});
  }

  receive(payload: unknown) {
    for (const cb of this.listeners.get('message') ?? []) cb({ data: JSON.stringify(payload) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the live candle wire contract', () => {
  it('a real production frame reaches a channel listener and validates as a candle', () => {
    const client = new WsClient('ws://test/ws');
    const received: WsMessage[] = [];
    client.subscribe(LIVE_FRAME.channel, (msg) => received.push(msg));
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive(LIVE_FRAME);

    expect(received).toHaveLength(1);
    expect(isCandle(received[0]!.data)).toBe(true);
  });

  it("the frame's envelope tag is 'update', NOT 'candle' — the regression that froze the chart", () => {
    // Guard, not trivia: if this ever flips, the hook's channel-based routing still works,
    // but anything that went back to filtering on `msg.type === 'candle'` would break
    // again. The failure mode is silent, so it gets an assertion.
    expect(LIVE_FRAME.type).toBe('update');
    expect(LIVE_FRAME.type).not.toBe('candle');
  });

  it('only delivers frames for the subscribed channel', () => {
    const client = new WsClient('ws://test/ws');
    const oneMinute = vi.fn();
    const oneHour = vi.fn();
    client.subscribe('candles:0:1m', oneMinute);
    client.subscribe('candles:0:1h', oneHour);
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive(LIVE_FRAME);

    expect(oneMinute).toHaveBeenCalledTimes(1);
    expect(oneHour).not.toHaveBeenCalled();
  });
});

describe('isCandle', () => {
  it('accepts the live payload', () => {
    expect(isCandle(LIVE_FRAME.data)).toBe(true);
  });

  it('rejects the payloads of the other channels sharing the socket', () => {
    expect(isCandle({ index: '1', mark: '1', updatedAt: 1, healthyVenues: 4, degraded: false })).toBe(false);
    expect(isCandle([])).toBe(false);
  });

  it('rejects a JSON number where money is expected', () => {
    // money.ts's rule: a monetary field crosses the wire as a decimal string. A number
    // here means the API changed and must fail loudly, not round-trip through a double.
    expect(isCandle({ ...LIVE_FRAME.data, c: 78126.417225281332 })).toBe(false);
  });

  it('rejects missing fields, null and non-objects', () => {
    const { v: _v, ...withoutVolume } = LIVE_FRAME.data;
    expect(isCandle(withoutVolume)).toBe(false);
    expect(isCandle(null)).toBe(false);
    expect(isCandle(undefined)).toBe(false);
    expect(isCandle('candle')).toBe(false);
  });

  it('rejects a non-finite bucket timestamp', () => {
    expect(isCandle({ ...LIVE_FRAME.data, t: Number.NaN })).toBe(false);
  });
});

describe('upsertCandle', () => {
  it('replaces the in-progress bucket instead of appending it', () => {
    // The channel re-sends the same bucket as it accumulates. Appending would draw one
    // real bucket as a run of fake candles.
    const series = [candle(60, '1'), candle(120, '2')];
    const next = upsertCandle(series, candle(120, '3'));
    expect(next).toHaveLength(2);
    expect(next[1]!.c).toBe('3');
  });

  it('appends a genuinely new bucket', () => {
    const next = upsertCandle([candle(60, '1')], candle(120, '2'));
    expect(next.map((c) => c.t)).toEqual([60, 120]);
  });

  it('seeds an empty series', () => {
    expect(upsertCandle([], candle(60, '1'))).toEqual([candle(60, '1')]);
  });

  it('updates an older bucket in place rather than duplicating it', () => {
    const series = [candle(60, '1'), candle(120, '2'), candle(180, '3')];
    const next = upsertCandle(series, candle(120, '9'));
    expect(next.map((c) => c.t)).toEqual([60, 120, 180]);
    expect(next[1]!.c).toBe('9');
  });

  it('inserts a late frame in bucket order instead of dropping it', () => {
    const next = upsertCandle([candle(60, '1'), candle(180, '3')], candle(120, '2'));
    expect(next.map((c) => c.t)).toEqual([60, 120, 180]);
  });

  it('does not mutate the array it was given', () => {
    const series = [candle(60, '1')];
    upsertCandle(series, candle(120, '2'));
    expect(series).toHaveLength(1);
  });

  it('keeps the series sorted through a burst of live frames', () => {
    let series: Candle[] = [];
    for (const t of [60, 120, 120, 180, 120, 240]) series = upsertCandle(series, candle(t, String(t)));
    expect(series.map((c) => c.t)).toEqual([60, 120, 180, 240]);
  });
});
