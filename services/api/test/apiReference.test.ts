import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ENDPOINTS, WS_CHANNELS, WS_LIMITS, publicEndpoints } from '@whitespace/shared/api';
import type { AddressInfo } from 'node:net';
import { createApp, registeredRoutes, type App } from '../src/server.js';
import {
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  VALID_KINDS,
  parseChannel,
} from '../src/ws.js';
import { DEFAULT_CANDLE_LIMIT, MAX_CANDLE_LIMIT } from '../src/routes/markets.js';
import { POSITION_HISTORY_DEFAULT_LIMIT, POSITION_HISTORY_MAX_LIMIT } from '../src/routes/positions.js';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '../src/routes/orders.js';
import { FEES_DEFAULT_LIMIT, FEES_MAX_LIMIT } from '../src/routes/fees.js';
import { SETTLEMENTS_DEFAULT_LIMIT, SETTLEMENTS_MAX_LIMIT } from '../src/routes/vault.js';
import { LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT } from '../src/routes/points.js';
import { DEGRADED_LAG_SECONDS, DOWN_LAG_SECONDS } from '../src/routes/health.js';

/**
 * The published API reference (/docs/api) renders from @whitespace/shared/api. These tests
 * hold that description to the server: the same routes, the same limits, the same channels.
 * A route added here without a line there — or a limit changed on one side only — fails.
 */

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const WALLET = '0x00000000000000000000000000000000000000aa';

describe('the API reference', () => {
  it('lists every route the server answers, and nothing it does not', () => {
    expect(API_ENDPOINTS.map(key).sort()).toEqual(registeredRoutes().map(key).sort());
  });

  it('keeps the faucet, which spends real gas, out of the public list', () => {
    expect(publicEndpoints().map(key)).not.toContain('POST /faucet/wbt');
    expect(publicEndpoints().length).toBe(API_ENDPOINTS.length - 1);
  });

  it('gives every public endpoint a request to try that its own route answers', () => {
    for (const endpoint of publicEndpoints()) {
      const pattern = new RegExp(`^${endpoint.path.replace(/:[^/]+/g, '[^/]+')}$`);
      const pathname = new URL(endpoint.example!.replace(':address', WALLET), 'http://x').pathname;
      expect(pathname, endpoint.path).toMatch(pattern);
    }
  });

  it('quotes the ?limit= default and maximum each handler uses', () => {
    const limits = Object.fromEntries(API_ENDPOINTS.filter((e) => e.limit).map((e) => [e.path, e.limit]));
    expect(limits).toEqual({
      '/positions/:address/history': { default: POSITION_HISTORY_DEFAULT_LIMIT, max: POSITION_HISTORY_MAX_LIMIT },
      '/orders/:address/history': { default: HISTORY_DEFAULT_LIMIT, max: HISTORY_MAX_LIMIT },
      '/fees/:address': { default: FEES_DEFAULT_LIMIT, max: FEES_MAX_LIMIT },
      '/points/leaderboard': { default: LEADERBOARD_DEFAULT_LIMIT, max: LEADERBOARD_MAX_LIMIT },
      '/vault/settlements': { default: SETTLEMENTS_DEFAULT_LIMIT, max: SETTLEMENTS_MAX_LIMIT },
    });
  });

  it('quotes the candle counts and the health thresholds the handlers use', () => {
    const summary = (path: string) => API_ENDPOINTS.find((e) => e.path === path)!.summary;
    expect(summary('/markets/:pairIndex/candles')).toContain(`latest ${DEFAULT_CANDLE_LIMIT}`);
    expect(summary('/markets/:pairIndex/candles')).toContain(`at most ${MAX_CANDLE_LIMIT.toLocaleString('en-US')}`);
    expect(summary('/health')).toContain(`over ${DEGRADED_LAG_SECONDS} s`);
    expect(summary('/health')).toContain(`over ${DOWN_LAG_SECONDS / 60} min`);
  });

  it('lists every WebSocket channel the server accepts, each with an example it accepts', () => {
    expect(WS_CHANNELS.map((c) => c.kind).sort()).toEqual([...VALID_KINDS].sort());
    for (const channel of WS_CHANNELS) {
      expect(parseChannel(channel.example), channel.example).toEqual(expect.objectContaining({ kind: channel.kind }));
    }
  });

  it('quotes the WebSocket poll interval and per-client limits the server enforces', () => {
    expect(WS_LIMITS).toEqual({
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      subscriptionsPerSocket: MAX_SUBSCRIPTIONS_PER_SOCKET,
      connectionsPerIp: DEFAULT_MAX_CONNECTIONS_PER_IP,
    });
  });
});

describe('the limits the reference quotes, against the running server', () => {
  // A bare app, no schema setup: a ?limit= is validated before any query runs, so whether it
  // is refused does not depend on the database being there.
  let app: App;
  let baseUrl: string;
  beforeAll(async () => {
    app = createApp();
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    app.wsManager.stop();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });

  it('accepts ?limit= up to the quoted maximum and refuses one more', async () => {
    for (const endpoint of API_ENDPOINTS.filter((e) => e.limit)) {
      const path = endpoint.path.replace(':address', WALLET);
      const atMax = await fetch(`${baseUrl}${path}?limit=${endpoint.limit!.max}`);
      const over = await fetch(`${baseUrl}${path}?limit=${endpoint.limit!.max + 1}`);
      expect(atMax.status, `${path} at max`).not.toBe(400);
      expect(over.status, `${path} over max`).toBe(400);
    }
  });
});
