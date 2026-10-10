import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket } from './seed.js';
import { query } from '../src/db.js';

describe('unexpected errors', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
    await truncateAll();
    await seedMarket();
  });
  afterAll(async () => {
    await server.close();
  });

  it('answers 500 with a generic body and logs the real error server-side', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A missing relation is a realistic internal failure whose message names schema objects.
    await query('ALTER TABLE market RENAME TO market_hidden');
    try {
      const res = await fetch(`${server.baseUrl}/markets`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal error' });
      expect(text).not.toMatch(/market|relation/);
      const lines = logged.mock.calls.map((args) => args.map(String).join(' '));
      expect(lines.some((l) => l.includes('GET /markets') && l.includes('relation "market" does not exist'))).toBe(true);
    } finally {
      await query('ALTER TABLE market_hidden RENAME TO market');
      logged.mockRestore();
    }
  });

  it('still answers the same route normally once the cause is gone', async () => {
    const res = await fetch(`${server.baseUrl}/markets`);
    expect(res.status).toBe(200);
  });
});
