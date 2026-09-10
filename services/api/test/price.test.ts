import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedPriceReport } from './seed.js';
import { resetPublisherCache } from '../src/publisher.js';

/**
 * Stands up a fake price-publisher exposing only `GET /status`, and points the API at it.
 *
 * A stub rather than the real service because these tests are about the API's *choice* of
 * source and its fallback, not about venue aggregation — and because a test that reaches
 * for a publisher on a fixed port passes or fails based on what else is running on the
 * developer's machine. That is not hypothetical: this suite started asserting a seeded
 * 65,001 and receiving live BTC the moment the real publisher was brought up locally.
 */
async function startStubPublisher(feeds: Record<string, unknown>): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ feeds }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.PUBLISHER_URL = `http://127.0.0.1:${port}`;
  resetPublisherCache();
  return {
    close: () =>
      new Promise<void>((resolve) => {
        process.env.PUBLISHER_URL = '';
        resetPublisherCache();
        server.close(() => resolve());
      }),
  };
}

describe('GET /price/:pairIndex', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedMarket();
    // The client memoises /status for under a second; without this a case would inherit
    // the previous case's publisher answer.
    resetPublisherCache();
  });

  describe('with no publisher reachable', () => {
    it('returns 404 when no price report has been indexed yet for the market', async () => {
      const res = await fetch(`${server.baseUrl}/price/0`);
      expect(res.status).toBe(404);
    });

    it('falls back to the latest indexed on-chain price report, and says so', async () => {
      await seedPriceReport('65000000000000000000000', 1788881870, 1);
      await seedPriceReport('65001000000000000000000', 1788881876, 2); // most recent
      const res = await fetch(`${server.baseUrl}/price/0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.index).toBe('65001.000000000000000000');
      expect(body.mark).toBe('65001.000000000000000000');
      expect(body.updatedAt).toBe(1788881876);
      // The chain carries no venue health, so these stay null rather than being guessed.
      expect(body.healthyVenues).toBeNull();
      expect(body.degraded).toBeNull();
      // A caller must be able to tell a live quote from a frozen last-trade price.
      expect(body.source).toBe('chain');
      // A settled report is a single price; there is no book to recover a spread from.
      expect(body.bid).toBeNull();
      expect(body.ask).toBeNull();
    });
  });

  describe('with a publisher reachable', () => {
    let stub: { close: () => Promise<void> } | undefined;
    afterEach(async () => {
      await stub?.close();
      stub = undefined;
    });

    it('prefers the live publisher over the last on-chain report', async () => {
      // A stale on-chain report exists — the live price must win anyway. That is the
      // whole point: between orders the chain price is frozen and drifts from the market.
      await seedPriceReport('65001000000000000000000', 1788881876, 2);
      stub = await startStubPublisher({
        'BTC/USD': {
          mark: '78117064052017023348163',
          index: '78114005000000000000000',
          healthyCount: 4,
          healthyVenues: ['whitebit', 'bybit', 'okx', 'binance'],
          degraded: false,
          noData: false,
        },
      });

      const res = await fetch(`${server.baseUrl}/price/0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mark).toBe('78117.064052017023348163');
      expect(body.index).toBe('78114.005000000000000000');
      expect(body.healthyVenues).toEqual(['whitebit', 'bybit', 'okx', 'binance']);
      expect(body.degraded).toBe(false);
      expect(body.source).toBe('publisher');
    });

    it('serves the aggregated two-sided quote, which is what a fill price is computed from', async () => {
      stub = await startStubPublisher({
        'BTC/USD': {
          mark: '78123970720575855581107',
          index: '78121850000000000000000',
          indexBid: '78121800000000000000000',
          indexAsk: '78121900000000000000000',
          healthyCount: 3,
          healthyVenues: ['bybit', 'okx', 'binance'],
          degraded: false,
          noData: false,
        },
      });

      const body = await (await fetch(`${server.baseUrl}/price/0`)).json();
      expect(body.bid).toBe('78121.800000000000000000');
      expect(body.ask).toBe('78121.900000000000000000');
    });

    it('reports bid/ask as null rather than echoing the mark when the aggregate has no two-sided quote', async () => {
      // "no spread" and "spread unknown" price a fill differently, so the mark must never
      // be substituted for a missing side. A publisher predating these fields sends
      // `undefined`, which must normalise to null and not blow up the route.
      stub = await startStubPublisher({
        'BTC/USD': {
          mark: '78123970720575855581107',
          index: '78121850000000000000000',
          healthyCount: 3,
          healthyVenues: ['bybit', 'okx', 'binance'],
          degraded: false,
          noData: false,
        },
      });

      const res = await fetch(`${server.baseUrl}/price/0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bid).toBeNull();
      expect(body.ask).toBeNull();
      expect(body.mark).toBe('78123.970720575855581107');
    });

    it('falls back to the chain when the publisher reports it has no venue data', async () => {
      await seedPriceReport('65001000000000000000000', 1788881876, 2);
      stub = await startStubPublisher({
        'BTC/USD': { mark: null, index: null, healthyCount: 0, healthyVenues: [], degraded: true, noData: true },
      });

      const res = await fetch(`${server.baseUrl}/price/0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('chain');
      expect(body.mark).toBe('65001.000000000000000000');
    });

    it('serves a degraded publisher price, flagged, rather than hiding it', async () => {
      // Degraded means "fewer healthy venues than the threshold", not "no price". The UI
      // has a banner for exactly this state; suppressing it here would leave the trader
      // looking at a stale chain price with no warning at all.
      stub = await startStubPublisher({
        'BTC/USD': {
          mark: '78000000000000000000000',
          index: '78000000000000000000000',
          healthyCount: 1,
          healthyVenues: ['okx'],
          degraded: true,
          noData: false,
        },
      });

      const res = await fetch(`${server.baseUrl}/price/0`);
      const body = await res.json();
      expect(body.source).toBe('publisher');
      expect(body.degraded).toBe(true);
      expect(body.healthyVenues).toEqual(['okx']);
    });
  });

  it('returns 400 for a non-integer pairIndex', async () => {
    const res = await fetch(`${server.baseUrl}/price/abc`);
    expect(res.status).toBe(400);
  });
});
