import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { query, queryOne } from './db.js';
import { price as fmtPrice, collateral as fmtCollateral, leverage as fmtLeverage, id as fmtId } from './format.js';
import { readLatestIndexCandle } from './indexSeries.js';
import { resolveOrders } from './routes/orders.js';
import { resolvePrice } from './routes/price.js';

type ChannelKind = 'price' | 'positions' | 'orders' | 'candles';
const VALID_KINDS: ChannelKind[] = ['price', 'positions', 'orders', 'candles'];

type ParsedChannel = { kind: ChannelKind; args: string[] };

/** Parses "price:<pairIndex>" | "positions:<address>" | "orders:<address>"
 * | "candles:<pairIndex>:<interval>". Returns null for anything else — the
 * caller must reject the subscription rather than silently accept garbage. */
export function parseChannel(channel: string): ParsedChannel | null {
  const parts = channel.split(':');
  const kind = parts[0] as ChannelKind;
  if (!VALID_KINDS.includes(kind)) return null;
  if (kind === 'candles') {
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
    return { kind, args: [parts[1], parts[2]] };
  }
  if (parts.length !== 2 || !parts[1]) return null;
  return { kind, args: [parts[1]] };
}

async function fetchChannelData(parsed: ParsedChannel): Promise<unknown> {
  switch (parsed.kind) {
    case 'price': {
      // Same resolver the REST route uses — publisher first, last on-chain report as
      // fallback. See routes/price.ts for why these must not be two separate queries.
      return resolvePrice(Number(parsed.args[0]));
    }
    case 'positions': {
      const trader = parsed.args[0].toLowerCase();
      const rows = await query<{
        pair_index: number;
        index: number;
        buy: boolean;
        collateral: string;
        leverage: number;
        open_price: string;
        tp: string;
        sl: string;
        opened_at: number;
        trade_id: string;
      }>('SELECT * FROM position WHERE trader = $1 ORDER BY opened_at DESC', [trader]);
      return rows.map((r) => ({
        pairIndex: r.pair_index,
        index: r.index,
        buy: r.buy,
        collateral: fmtCollateral(r.collateral),
        leverage: fmtLeverage(r.leverage),
        openPrice: fmtPrice(r.open_price),
        tp: fmtPrice(r.tp),
        sl: fmtPrice(r.sl),
        openedAt: r.opened_at,
        tradeId: fmtId(r.trade_id),
      }));
    }
    case 'orders': {
      // Same resolver the REST route uses. These were two independent queries with
      // different WHERE clauses and different columns, so whether an order appeared to
      // exist depended on which transport last answered.
      return resolveOrders(parsed.args[0]);
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
export function createWsManager(opts: { pollIntervalMs?: number } = {}): WsManager {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const subscribers = new Map<string, Set<WebSocket>>();
  const lastPayload = new Map<string, string>();

  function subscribe(ws: WebSocket, channel: string): boolean {
    if (!parseChannel(channel)) return false;
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel)!.add(ws);
    return true;
  }

  function unsubscribe(ws: WebSocket, channel: string): void {
    const set = subscribers.get(channel);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      subscribers.delete(channel);
      lastPayload.delete(channel);
    }
  }

  function unsubscribeAll(ws: WebSocket): void {
    for (const channel of [...subscribers.keys()]) {
      unsubscribe(ws, channel);
    }
  }

  function channelSubscriberCount(channel: string): number {
    return subscribers.get(channel)?.size ?? 0;
  }

  async function pollOnce(): Promise<void> {
    for (const [channel, sockets] of subscribers) {
      if (sockets.size === 0) continue;
      const parsed = parseChannel(channel);
      if (!parsed) continue;
      let data: unknown;
      try {
        data = await fetchChannelData(parsed);
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
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
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
            JSON.stringify(ok ? { type: 'subscribed', channel } : { type: 'error', channel, error: 'invalid channel' }),
          );
        } else if (type === 'unsubscribe') {
          unsubscribe(ws, channel);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
        } else {
          ws.send(JSON.stringify({ type: 'error', channel, error: `unknown type "${type}"` }));
        }
      });
      ws.on('close', () => unsubscribeAll(ws));
    });
    start();
    return wss;
  }

  return { attach, subscribe, unsubscribe, unsubscribeAll, pollOnce, start, stop, channelSubscriberCount };
}
