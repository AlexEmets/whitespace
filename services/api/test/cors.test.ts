import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';

/**
 * CORS is not decoration here — without it this API is unreachable from a browser at all.
 * Every request the web app makes is cross-origin (it runs on a different port), so
 * without an `Access-Control-Allow-Origin` header the browser fetches the response and
 * then throws it away. The server sees a perfectly normal 200 and logs nothing wrong; the
 * only symptom is an empty UI. That is how this shipped: the API's own 40 tests were green
 * the entire time, because none of them was a browser.
 *
 * These tests pin both directions. Allowing the right origin is half the contract; the
 * more important half is that a wrong origin gets NO header, because a wildcard that
 * "just works" is the tempting fix and it would have to be walked back the moment
 * anything here stops being world-readable.
 */
describe('CORS', () => {
  let server: TestServer;
  const allowed = 'http://localhost:3000';

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('echoes an allowed origin rather than wildcarding it', async () => {
    const res = await fetch(`${server.baseUrl}/health`, { headers: { Origin: allowed } });
    expect(res.headers.get('access-control-allow-origin')).toBe(allowed);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('marks the response as varying on Origin so caches cannot cross-serve it', async () => {
    const res = await fetch(`${server.baseUrl}/health`, { headers: { Origin: allowed } });
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('answers the preflight with 204 and the allowed methods', async () => {
    const res = await fetch(`${server.baseUrl}/markets`, {
      method: 'OPTIONS',
      headers: { Origin: allowed, 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('sends no CORS header at all for an origin that is not allowlisted', async () => {
    const res = await fetch(`${server.baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200); // the request still succeeds server-side …
    expect(res.headers.get('access-control-allow-origin')).toBeNull(); // … the browser is what refuses it
  });

  it('sends no CORS header for a same-origin request that carries no Origin', async () => {
    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still applies CORS to an error response, so the browser can read the failure', async () => {
    const res = await fetch(`${server.baseUrl}/no-such-route`, { headers: { Origin: allowed } });
    expect(res.status).toBe(404);
    // Without this the UI would see an opaque network error instead of "not found", which
    // is the difference between a debuggable failure and a mystery.
    expect(res.headers.get('access-control-allow-origin')).toBe(allowed);
  });
});
