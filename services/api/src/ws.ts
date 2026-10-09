import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { queryOne } from './db.js';
import { price as fmtPrice, collateral as fmtCollateral } from './format.js';
import { readLatestIndexCandle } from './indexSeries.js';
import { resolveOrders } from './routes/orders.js';
import { resolvePositions } from './routes/positions.js';
import { resolvePrice } from './routes/price.js';
import { resolveLimitOrders } from './routes/limitOrders.js';
import { resolveFees } from './routes/fees.js';
import { parseAddress, rateLimitKey } from './validate.js';
import { clientIp } from './routes/faucet.js';
import { INTERVALS } from '@whitespace/shared/candles';

type ChannelKind = 'price' | 'positions' | 'orders' | 'candles' | 'limitOrders' | 'fees';
const VALID_KINDS: ChannelKind[] = ['price', 'positions', 'orders', 'candles', 'limitOrders', 'fees'];
/** Channels whose argument is a wallet; the address must be well-formed, so a client cannot
 * create an unbounded number of distinct polled channels out of arbitrary strings. */
const ADDRESS_KINDS: ChannelKind[] = ['positions', 'orders', 'limitOrders', 'fees'];

/** Every channel a socket holds is re-queried each poll; this caps what one socket can
 * make the server do per tick. A trading UI needs a handful. */
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 64;

/** Largest inbound frame accepted. Clients only ever send `{type, channel}` (well under
 * 200 bytes); the `ws` default of 100 MiB let one socket make the server buffer and
 * JSON.parse an arbitrarily large message. Anything bigger closes the socket with 1009. */
export const MAX_PAYLOAD_BYTES = 4096;

export type ParsedChannel = { kind: ChannelKind; args: string[] };

/** Parses "price:<pairIndex>" | "positions:<address>" | "orders:<address>"
 * | "limitOrders:<address>" | "fees:<address>" | "candles:<pairIndex>:<interval>". Returns null for anything else — the
 * caller must reject the subscription rather than silently accept garbage. */
export function parseChannel(channel: string): ParsedChannel | null {
  const parts = channel.split(':');
  const kind = parts[0] as ChannelKind;
  if (!VALID_KINDS.includes(kind)) return null;
  if (kind === 'candles') {
    if (parts.length !== 3 || !PAIR_INDEX_RE.test(parts[1])) return null;
    if (!(INTERVALS as readonly string[]).includes(parts[2])) return null;
    return { kind, args: [parts[1], parts[2]] };
  }
  if (parts.length !== 2 || !parts[1]) return null;
  if (ADDRESS_KINDS.includes(kind)) {
    const address = parseAddress(parts[1]);
    return address ? { kind, args: [address] } : null;
  }
  // price
  if (!PAIR_INDEX_RE.test(parts[1])) return null;
  return { kind, args: [parts[1]] };
}

/**
 * A pair index in canonical decimal form: no sign, no leading zeros, no exponent or hex.
 * Anything looser lets one market be spelled many ways ("1", "01", "1e0", "0x1"), and every
 * spelling was a separate channel the poller re-queried each tick, while a non-number
 * ("price:abc") went to Postgres as NaN on every tick only to fail there. Four digits is far
 * beyond any market count this deployment lists.
 */
const PAIR_INDEX_RE = /^(0|[1-9]\d{0,3})$/;

/** Open sockets allowed from one client (IPv4 address or IPv6 /64, see rateLimitKey). A
 * browser opens one per tab; this leaves room for a trader with many tabs while stopping
 * one host from exhausting the process with idle sockets. */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 20;
/** Open sockets allowed in total. Each holds buffers and a keep-alive timer, and the API
 * shares a 2 GB box with Postgres and the indexer. */
export const DEFAULT_MAX_CONNECTIONS = 1000;
/** Close code for a refused connection: 1013 "Try Again Later". */
export const WS_CLOSE_TOO_MANY = 1013;

export async function fetchChannelData(parsed: ParsedChannel): Promise<unknown> {
  switch (parsed.kind) {
    case 'price': {
      // Same resolver the REST route uses — publisher first, last on-chain report as
      // fallback. See routes/price.ts for why these must not be two separate queries.
      return resolvePrice(Number(parsed.args[0]));
    }
    case 'positions': {
      // Same bounded resolver as GET /positions/:address.
      return resolvePositions(parsed.args[0]);
    }
    case 'orders': {
      // Same resolver the REST route uses. These were two independent queries with
      // different WHERE clauses and different columns, so whether an order appeared to
      // exist depended on which transport last answered.
      return resolveOrders(parsed.args[0]);
    }
    case 'limitOrders': {
      // Same resolver as GET /limit-orders/:address.
      return resolveLimitOrders(parsed.args[0]);
    }
    case 'fees': {
      // Same resolver and default window (200 newest) as GET /fees/:address.
      return resolveFees(parsed.args[0]);
    }
    case 'candles': {
      const pairIndex = Number(parsed.args[0]);
      const interval = parsed.args[1];
      // The index series, so the in-progress candle this pushes keeps moving between
      // trades — the whole point of the live channel.
      const row =
        (await readLatestIndexCandle(pairIndex, interval)) ??
        (await queryOne<{
          bucket_start: number;
          open: string;
          high: string;
          low: string;
          close: string;
          volume: string;
        }>(
          'SELECT bucket_start, open, high, low, close, volume FROM candle WHERE pair_index = $1 AND interval = $2 ORDER BY bucket_start DESC LIMIT 1',
          [pairIndex, interval],
        ));
      if (!row) return null;
      return {
        t: row.bucket_start,
        o: fmtPrice(row.open),
        h: fmtPrice(row.high),
        l: fmtPrice(row.low),
        c: fmtPrice(row.close),
        v: fmtCollateral(row.volume),
      };
    }
  }
}

export type WsManager = {
  attach: (server: Server) => WebSocketServer;
  subscribe: (ws: WebSocket, channel: string) => boolean;
  unsubscribe: (ws: WebSocket, channel: string) => void;
  unsubscribeAll: (ws: WebSocket) => void;
  pollOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
  channelSubscriberCount: (channel: string) => number;
};

/**
 * Poll-based pub/sub over WebSocket. Ponder writes directly to Postgres with
 * no built-in change-notification hook, so rather than bolt on Postgres
 * LISTEN/NOTIFY triggers (whose interaction with Ponder's own reorg-revert
 * SQL was not verified in this project), this polls each *actively
 * subscribed* channel on a fixed interval, computes the current payload, and
 * only pushes to sockets when the payload actually changed since the last
 * push. See docs/decisions/phase-4-indexer-api.md for the tradeoff — this
 * is a deliberate, disclosed limitation, not an oversight.
 */
export type WsManagerOptions = {
  pollIntervalMs?: number;
  pingIntervalMs?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  /** Test seam: what one channel's payload is read with. */
  fetchChannelData?: (parsed: ParsedChannel) => Promise<unknown>;
};

export function createWsManager(opts: WsManagerOptions = {}): WsManager {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const fetchData = opts.fetchChannelData ?? fetchChannelData;
  const subscribers = new Map<string, Set<WebSocket>>();
  const lastPayload = new Map<string, string>();

  const perSocket = new Map<WebSocket, Set<string>>();

  function subscribe(ws: WebSocket, channel: string): boolean {
    if (!parseChannel(channel)) return false;
    const held = perSocket.get(ws) ?? new Set<string>();
    if (!held.has(channel) && held.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) return false;
    held.add(channel);
    perSocket.set(ws, held);
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel)!.add(ws);
    return true;
  }

  function unsubscribe(ws: WebSocket, channel: string): void {
    const held = perSocket.get(ws);
    held?.delete(channel);
    if (held && held.size === 0) perSocket.delete(ws);
    const set = subscribers.get(channel);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      subscribers.delete(channel);
      lastPayload.delete(channel);
    }
  }

  function unsubscribeAll(ws: WebSocket): void {
    for (const channel of [...(perSocket.get(ws) ?? [])]) {
      unsubscribe(ws, channel);
    }
  }

  function channelSubscriberCount(channel: string): number {
    return subscribers.get(channel)?.size ?? 0;
  }

  // One sweep at a time. setInterval fires regardless of whether the previous sweep has
  // finished, and a sweep is one awaited query per subscribed channel: once Postgres slowed
  // down (or a connect stalled during recovery) sweeps started stacking, each holding pool
  // connections and payload copies, making the slowdown that caused them worse. A tick that
  // finds a sweep still running joins it instead of starting another.
  let inFlight: Promise<void> | null = null;
  function pollOnce(): Promise<void> {
    inFlight ??= sweep().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function sweep(): Promise<void> {
    for (const [channel, sockets] of subscribers) {
      if (sockets.size === 0) continue;
      const parsed = parseChannel(channel);
      if (!parsed) continue;
      let data: unknown;
      try {
        data = await fetchData(parsed);
      } catch {
        continue; // transient DB error: skip this channel this tick, try again next poll
      }
      const payload = JSON.stringify({ type: 'update', channel, data });
      if (lastPayload.get(channel) === payload) continue;
      lastPayload.set(channel, payload);
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      pollOnce().catch(() => undefined);
    }, pollIntervalMs);
  }
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function attach(server: Server): WebSocketServer {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });
    // `ws` re-emits the HTTP server's errors here; an EventEmitter 'error' with no listener
    // throws, so without this one a server-level error would take the whole process down.
    wss.on('error', (err) => {
      console.error('[api] websocket server error:', err.message);
    });
    const perIp = new Map<string, number>();
    let open = 0;
    wss.on('connection', (ws, req) => {
      // A protocol violation from the peer (RSV bits set, a bad opcode, an oversized frame,
      // invalid UTF-8) is reported as an 'error' on that one socket, after which `ws` closes
      // it. With no listener the emit throws out of the socket's data handler as an uncaught
      // exception, so six hostile bytes after an upgrade killed the API for every user. The
      // socket is already being torn down; logging is all that is left to do.
      ws.on('error', (err) => {
        console.error('[api] websocket client error:', err.message);
      });

      // Connection caps, checked here rather than in a handshake hook because 'connection'
      // is synchronous with the count update: no window in which two handshakes both see
      // room for one. The peer is keyed like the faucet keys it (Caddy's X-Forwarded-For,
      // IPv6 collapsed to its /64), since every socket arrives from Caddy on loopback.
      const ipKey = rateLimitKey(clientIp(req));
      const fromIp = perIp.get(ipKey) ?? 0;
      if (open >= maxConnections || fromIp >= maxConnectionsPerIp) {
        ws.close(WS_CLOSE_TOO_MANY, 'too many connections');
        return;
      }
      open++;
      perIp.set(ipKey, fromIp + 1);

      // Cloudflare closes a proxied WebSocket once no data has crossed it in EITHER
      // direction for ~100 s, and pollOnce deliberately sends nothing while a channel's
      // payload is unchanged (see the dedup at `lastPayload.get(channel) === payload`
      // above). So a trader subscribed to a quiet `positions:` or `orders:` channel emits
      // and receives literal silence, and the tunnel drops the socket roughly every two
      // minutes. This never reproduces locally, where no proxy sits in the path.
      //
      // A protocol-level ping counts as traffic for the proxy, and browsers answer it
      // inside their WebSocket stack, so apps/web/src/lib/ws.ts needs no matching change.
      // Hosting design §6.
      //
      // The same ping doubles as dead-peer detection: a client that has not answered the
      // previous ping by the next tick (a laptop lid closed, a NAT entry dropped) never sent
      // a FIN, so without this its socket, subscriptions and per-IP slot were held forever
      // and its channels kept being polled for nobody.
      let alive = true;
      ws.on('pong', () => {
        alive = true;
      });
      const keepAlive = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        if (ws.readyState === ws.OPEN) ws.ping();
      }, pingIntervalMs);

      ws.on('message', (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
          return;
        }
        if (
          typeof msg !== 'object' ||
          msg === null ||
          !('type' in msg) ||
          !('channel' in msg) ||
          typeof (msg as { channel: unknown }).channel !== 'string'
        ) {
          ws.send(JSON.stringify({ type: 'error', error: 'expected {type, channel}' }));
          return;
        }
        const { type, channel } = msg as { type: string; channel: string };
        if (type === 'subscribe') {
          const ok = subscribe(ws, channel);
          ws.send(
            JSON.stringify(
              ok ? { type: 'subscribed', channel } : { type: 'error', channel, error: 'invalid channel or too many subscriptions' },
            ),
          );
        } else if (type === 'unsubscribe') {
          unsubscribe(ws, channel);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
        } else {
          ws.send(JSON.stringify({ type: 'error', channel, error: `unknown type "${type}"` }));
        }
      });
      ws.on('close', () => {
        clearInterval(keepAlive);
        unsubscribeAll(ws);
        open--;
        const left = (perIp.get(ipKey) ?? 1) - 1;
        if (left > 0) perIp.set(ipKey, left);
        else perIp.delete(ipKey);
      });
    });
    start();
    return wss;
  }

  return { attach, subscribe, unsubscribe, unsubscribeAll, pollOnce, start, stop, channelSubscriberCount };
}
