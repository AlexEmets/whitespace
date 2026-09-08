import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, seedPriceReport } from './seed.js';

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
  });

  it('returns 404 when no price report has been indexed yet for the market', async () => {
    const res = await fetch(`${server.baseUrl}/price/0`);
    expect(res.status).toBe(404);
  });

  it('serves index/mark from the latest indexed on-chain price report, not a publisher', async () => {
    await seedPriceReport('65000000000000000000000', 1788881870, 1);
    await seedPriceReport('65001000000000000000000', 1788881876, 2); // most recent
    const res = await fetch(`${server.baseUrl}/price/0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBe('65001.000000000000000000');
    expect(body.mark).toBe('65001.000000000000000000');
    expect(body.updatedAt).toBe(1788881876);
    // No price-publisher exists in this project yet — honestly null, not fabricated.
    expect(body.healthyVenues).toBeNull();
    expect(body.degraded).toBeNull();
  });

  it('returns 400 for a non-integer pairIndex', async () => {
    const res = await fetch(`${server.baseUrl}/price/abc`);
    expect(res.status).toBe(400);
  });
});
