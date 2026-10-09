import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import net from 'node:net';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedPriceReport, TRADER, seedOpenPosition, seedLimitOrder, seedFee } from './seed.js';
import {
  parseChannel,
  createWsManager,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  MAX_PAYLOAD_BYTES,
  WS_CLOSE_TOO_MANY,
} from '../src/ws.js';
import { MAX_POSITIONS } from '../src/routes/positions.js';
import { getPool } from '../src/db.js';

function onceMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('WS /ws', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 30 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
  });

  it('acks a subscribe message with {type: "subscribed", channel}', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    const ack = await onceMessage(ws);
    expect(ack).toEqual({ type: 'subscribed', channel: 'price:0' });
    ws.close();
  });

  it('rejects a subscribe to a malformed channel with {type: "error"}', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'not-a-real-channel' }));
    const ack = await onceMessage(ws);
    expect(ack.type).toBe('error');
    ws.close();
  });

  it('pushes a price update to a subscribed client when a new price report lands', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(ws); // the "subscribed" ack

    const updatePromise = onceMessage(ws);
    await seedPriceReport('65001000000000000000000', 1788881876, 2);
    const update = await updatePromise;
    expect(update.type).toBe('update');
    expect(update.channel).toBe('price:0');
    expect((update.data as { index: string }).index).toBe('65001.000000000000000000');
    ws.close();
  });

  it('does NOT push to a client that unsubscribed (filter proven both ways: A stays subscribed, B unsubscribes)', async () => {
    const a = await connect(server.wsUrl);
    const b = await connect(server.wsUrl);

    a.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(a);
    b.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(b);

    b.send(JSON.stringify({ type: 'unsubscribe', channel: 'price:0' }));
    await onceMessage(b); // "unsubscribed" ack

    let bReceivedUpdate = false;
    b.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'update') bReceivedUpdate = true;
    });

    const aUpdatePromise = onceMessage(a);
    await seedPriceReport('65001000000000000000000', 1788881876, 2);

    // A (still subscribed) must receive the update.
    const aUpdate = await aUpdatePromise;
    expect(aUpdate.type).toBe('update');

    // B (unsubscribed) must NOT have received it, even though A did — this
    // proves the filter actually discriminates rather than either
    // broadcasting to everyone or silently dropping everyone.
    expect(bReceivedUpdate).toBe(false);

    a.close();
    b.close();
  });

  it('stops pushing to a channel entirely once its only subscriber disconnects', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    await onceMessage(ws);
    ws.close();
    await waitForCondition(() => server.app.wsManager.channelSubscriberCount('price:0') === 0);
    expect(server.app.wsManager.channelSubscriberCount('price:0')).toBe(0);
  });

  it('supports the positions:<address> channel and reflects the real proof position', async () => {
    await seedOpenPosition();
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: `positions:${TRADER}` }));
    await onceMessage(ws);
    await server.app.wsManager.pollOnce();
    const update = await onceMessage(ws);
    expect(update.type).toBe('update');
    const data = update.data as Array<{ tradeId: string; collateral: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].tradeId).toBe('2');
    expect(data[0].collateral).toBe('999.000000');
    ws.close();
  });

  it('supports the candles:<pairIndex>:<interval> channel', async () => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'candles:0:1m' }));
    await onceMessage(ws);
    ws.close();
  });

  async function subscribeAndWaitForUpdate(channel: string, seed: () => Promise<void>) {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
    expect(await onceMessage(ws)).toEqual({ type: 'subscribed', channel });
    const updates: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => updates.push(JSON.parse(raw.toString())));
    await seed();
    await waitForCondition(() => updates.some((u) => Array.isArray(u.data) && (u.data as unknown[]).length > 0));
    ws.close();
    return updates.find((u) => Array.isArray(u.data) && (u.data as unknown[]).length > 0)!;
  }

  it('supports limitOrders:<address> with the REST shape', async () => {
    const update = await subscribeAndWaitForUpdate(`limitOrders:${TRADER}`, () => seedLimitOrder());
    expect(update.channel).toBe(`limitOrders:${TRADER}`);
    const [order] = update.data as Array<Record<string, unknown>>;
    expect(order).toMatchObject({ id: `${TRADER}-0-0`, orderType: 'LIMIT', collateral: '50.000000', triggerPrice: '60000.000000000000000000' });
    const rest = await (await fetch(`${server.baseUrl}/limit-orders/${TRADER}`)).json();
    expect(update.data).toEqual(rest);
  });

  it('supports fees:<address> with the REST shape', async () => {
    const update = await subscribeAndWaitForUpdate(`fees:${TRADER}`, () => seedFee('0xa-1-funding', 'funding', '-5'));
    const rest = await (await fetch(`${server.baseUrl}/fees/${TRADER}`)).json();
    expect(update.data).toEqual(rest);
    expect((update.data as Array<{ amount: string }>)[0].amount).toBe('-0.000005');
  });

  it.each(['limitOrders:0x12', 'fees:nope', 'limitOrders:', 'fees'])('rejects the malformed channel %s', async (channel) => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
    expect((await onceMessage(ws)).type).toBe('error');
    ws.close();
  });
});

describe('WS polling is bounded', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 30 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('the positions:<address> poll reads at most MAX_POSITIONS rows', async () => {
    // Every subscribed wallet is re-queried every poll; an unbounded SELECT made each
    // tick's cost (and the payload held in lastPayload) grow with the wallet's row count.
    await getPool().query(
      `INSERT INTO "position" (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, tp, sl, is_day_trade, open_order_id, open_tx_hash, opened_at, opened_at_block)
       SELECT g, $1, 0, 0, true, 1, 100, 1, 0, 0, false, g, '0x01', g, g FROM generate_series(1, $2::int) g`,
      [TRADER, MAX_POSITIONS + 1],
    );
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: `positions:${TRADER}` }));
    await onceMessage(ws);
    const update = await onceMessage(ws);
    expect((update.data as unknown[]).length).toBe(MAX_POSITIONS);
    // Newest first, so the one dropped is the oldest.
    expect((update.data as Array<{ tradeId: string }>)[0].tradeId).toBe(String(MAX_POSITIONS + 1));
    const rest = await (await fetch(`${server.baseUrl}/positions/${TRADER}`)).json();
    expect(rest).toEqual(update.data);
    ws.close();
  });

  it('one socket cannot subscribe to more than MAX_SUBSCRIPTIONS_PER_SOCKET channels', async () => {
    const ws = await connect(server.wsUrl);
    // The 30 ms poll interleaves `update` pushes for the channels already held, so read
    // only the replies to our own subscribe/unsubscribe messages.
    const replies: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'update') replies.push(msg);
    });
    const nextReply = async () => {
      await waitForCondition(() => replies.length > 0);
      return replies.shift()!;
    };
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SOCKET; i++) {
      ws.send(JSON.stringify({ type: 'subscribe', channel: `price:${i}` }));
      expect((await nextReply()).type).toBe('subscribed');
    }
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:999' }));
    const refused = await nextReply();
    expect(refused).toMatchObject({ type: 'error', channel: 'price:999' });
    expect(server.app.wsManager.channelSubscriberCount('price:999')).toBe(0);
    // Re-subscribing to a channel it already holds is not a new subscription.
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    expect((await nextReply()).type).toBe('subscribed');
    // Freeing one makes room again.
    ws.send(JSON.stringify({ type: 'unsubscribe', channel: 'price:1' }));
    await nextReply();
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:999' }));
    expect((await nextReply()).type).toBe('subscribed');
    ws.close();
  });

  it.each(['positions:garbage', 'orders:0x12'])('rejects a wallet channel with a malformed address: %s', async (channel) => {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel }));
    expect((await onceMessage(ws)).type).toBe('error');
    ws.close();
  });
});

describe('WS survives hostile peers', () => {
  let server: TestServer;
  // An 'error' emitted with no listener is thrown as an uncaught exception — in production
  // that is the process dying. Capture them here so the test fails on the crash itself.
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 30 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
  });
  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  /** Upgrades a raw TCP socket, then writes `frame` and resolves when the server hangs up. */
  function rawUpgradeThenSend(frame: Buffer): Promise<void> {
    const { port } = new URL(server.baseUrl);
    return new Promise((resolve, reject) => {
      const s = net.connect(Number(port), '127.0.0.1', () => {
        s.write(
          'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let upgraded = false;
      s.on('data', (chunk) => {
        if (!upgraded && chunk.toString().startsWith('HTTP/1.1 101')) {
          upgraded = true;
          s.write(frame);
        }
      });
      s.on('error', () => undefined);
      s.on('close', () => (upgraded ? resolve() : reject(new Error('upgrade never completed'))));
    });
  }

  async function stillServing(): Promise<void> {
    const ws = await connect(server.wsUrl);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
    expect(await onceMessage(ws)).toEqual({ type: 'subscribed', channel: 'price:0' });
    ws.close();
  }

  it('a frame with reserved RSV bits set closes that socket without crashing the process', async () => {
    // FIN + RSV1-3 + text opcode, masked, zero-length: a protocol violation `ws` reports
    // as an 'error' on the socket.
    await rawUpgradeThenSend(Buffer.from([0xf1, 0x80, 0, 0, 0, 0]));
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
    await stillServing();
  });

  it('closes a socket that sends more than MAX_PAYLOAD_BYTES with 1009, and keeps serving', async () => {
    const ws = await connect(server.wsUrl);
    ws.on('error', () => undefined);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send('x'.repeat(MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
    await stillServing();
  });

  it('accepts a message of exactly MAX_PAYLOAD_BYTES (boundary) and answers it', async () => {
    const ws = await connect(server.wsUrl);
    // Valid JSON padded to the limit with whitespace, so the reply proves it was processed.
    const body = JSON.stringify({ type: 'subscribe', channel: 'price:0' });
    ws.send(body + ' '.repeat(MAX_PAYLOAD_BYTES - body.length));
    expect(await onceMessage(ws)).toEqual({ type: 'subscribed', channel: 'price:0' });
    ws.close();
  });
});

describe('parseChannel', () => {
  it('lowercases the address of the new wallet channels', () => {
    expect(parseChannel('fees:0x2B8BA090DEdF879F8045C0DDa5a78762CED90D19')).toEqual({
      kind: 'fees',
      args: ['0x2b8ba090dedf879f8045c0dda5a78762ced90d19'],
    });
    expect(parseChannel(`limitOrders:${TRADER}`)).toEqual({ kind: 'limitOrders', args: [TRADER] });
  });

  it.each(['price:0', 'price:7', 'price:9999'])('accepts the canonical pair index %s', (channel) => {
    expect(parseChannel(channel)).toEqual({ kind: 'price', args: [channel.split(':')[1]] });
  });

  // Each of these used to be accepted as its own polled channel.
  it.each(['price:abc', 'price:01', 'price:-1', 'price:1e0', 'price:0x1', 'price:1.0', 'price: 1', 'price:10000'])(
    'rejects the non-canonical pair index %s',
    (channel) => {
      expect(parseChannel(channel)).toBeNull();
    },
  );

  it.each(['1m', '5m', '15m', '1h', '4h', '1d'])('accepts candles with the supported interval %s', (interval) => {
    expect(parseChannel(`candles:0:${interval}`)).toEqual({ kind: 'candles', args: ['0', interval] });
  });

  it.each(['candles:0:7m', 'candles:0:1H', 'candles:abc:1m', 'candles:01:1m', 'candles:0:', 'candles:0:1m:x'])(
    'rejects the malformed candles channel %s',
    (channel) => {
      expect(parseChannel(channel)).toBeNull();
    },
  );
});

describe('WS poll sweeps never overlap', () => {
  it('a slow sweep is joined, not stacked, by later ticks', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const manager = createWsManager({
      pollIntervalMs: 5,
      fetchChannelData: async () => {
        calls++;
        await gate;
        return null;
      },
    });
    // A fake socket is enough: the sweep only reads readyState and calls send.
    const fake = { readyState: 1, OPEN: 1, send: () => undefined } as unknown as WebSocket;
    expect(manager.subscribe(fake, 'price:0')).toBe(true);
    manager.start();
    try {
      // Many ticks elapse while the first sweep is stuck on its query.
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(1);
      // A direct call during the stall joins the same sweep too.
      const joined = manager.pollOnce();
      expect(calls).toBe(1);
      release();
      await joined;
      // Once it finishes, the next tick starts a fresh sweep.
      await waitForCondition(() => calls >= 2);
    } finally {
      manager.stop();
    }
  });

  it('a failing sweep does not wedge the poller', async () => {
    let calls = 0;
    const manager = createWsManager({
      pollIntervalMs: 5,
      fetchChannelData: async () => {
        calls++;
        throw new Error('db down');
      },
    });
    const fake = { readyState: 1, OPEN: 1, send: () => undefined } as unknown as WebSocket;
    manager.subscribe(fake, 'price:0');
    manager.start();
    try {
      await waitForCondition(() => calls >= 3);
    } finally {
      manager.stop();
    }
  });
});

describe('WS connection caps', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 1000, ws: { maxConnectionsPerIp: 2, maxConnections: 3 } });
  });
  afterAll(async () => {
    await server.close();
  });

  // The close code is recorded from the moment of connecting: a refused socket is closed
  // right after the handshake, before a listener attached later would see it.
  const closeCodes = new WeakMap<WebSocket, Promise<number>>();

  function connectAs(ip: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(server.wsUrl, { headers: { 'x-forwarded-for': ip } });
      closeCodes.set(ws, new Promise((r) => ws.once('close', (code) => r(code))));
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  /** Resolves with the close code if the server hangs up within `ms`, else null. */
  function closedWithin(ws: WebSocket, ms = 300): Promise<number | null> {
    return Promise.race([closeCodes.get(ws)!, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  }

  async function closeAndWait(ws: WebSocket): Promise<void> {
    if (ws.readyState === ws.CLOSED) return;
    const done = closeCodes.get(ws)!;
    ws.close();
    await done;
    // Let the server's own 'close' handler (which frees the slot) run too.
    await new Promise((r) => setTimeout(r, 50));
  }

  it('enforces the per-IP and total caps, and frees a slot when a socket closes', async () => {
    const a1 = await connectAs('203.0.113.10');
    const a2 = await connectAs('203.0.113.10');
    expect(await closedWithin(a1)).toBeNull();
    expect(await closedWithin(a2)).toBeNull();

    // Third from the same IP: over the per-IP cap.
    const a3 = await connectAs('203.0.113.10');
    expect(await closedWithin(a3)).toBe(WS_CLOSE_TOO_MANY);

    // A different client still gets in (total now 3, at the cap)...
    const b1 = await connectAs('203.0.113.11');
    expect(await closedWithin(b1)).toBeNull();
    // ...and the next one from anywhere is over the total cap.
    const c1 = await connectAs('203.0.113.12');
    expect(await closedWithin(c1)).toBe(WS_CLOSE_TOO_MANY);

    // Closing one of A's sockets frees both its per-IP slot and a total slot.
    await closeAndWait(a1);
    const a4 = await connectAs('203.0.113.10');
    expect(await closedWithin(a4)).toBeNull();

    for (const ws of [a2, b1, a4]) await closeAndWait(ws);
  });

  it('counts every address in one IPv6 /64 as the same client', async () => {
    const x1 = await connectAs('2001:db8:1:2::1');
    const x2 = await connectAs('2001:db8:1:2::2');
    const x3 = await connectAs('2001:db8:1:2:ffff::3');
    expect(await closedWithin(x1)).toBeNull();
    expect(await closedWithin(x2)).toBeNull();
    expect(await closedWithin(x3)).toBe(WS_CLOSE_TOO_MANY);
    for (const ws of [x1, x2]) await closeAndWait(ws);
  });
});

describe('WS dead-peer detection', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ wsPollIntervalMs: 1000, ws: { pingIntervalMs: 40 } });
  });
  afterAll(async () => {
    await server.close();
  });

  it('terminates a socket that stops answering pings, and drops its subscriptions', async () => {
    // autoPong off: the client receives pings but never answers, like a peer that vanished
    // without a FIN.
    const ws = new WebSocket(server.wsUrl, { autoPong: false });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:42' }));
    await onceMessage(ws);
    expect(server.app.wsManager.channelSubscriberCount('price:42')).toBe(1);
    const code = await new Promise<number>((resolve) => ws.once('close', resolve));
    expect(code).toBe(1006); // terminated, no close frame
    await waitForCondition(() => server.app.wsManager.channelSubscriberCount('price:42') === 0);
  });

  it('keeps a socket that answers pings open across many ping intervals', async () => {
    const ws = await connect(server.wsUrl);
    let closed = false;
    ws.on('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, 400)); // ten ping intervals
    expect(closed).toBe(false);
    ws.close();
  });
});
