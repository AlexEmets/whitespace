import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedSyncStatus } from './seed.js';

describe('GET /health', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('reports status=down with no indexedBlock when the indexer has never run', async () => {
    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'down', chainId: 1874, indexedBlock: null, lagSeconds: null });
  });

  it('reports status=ok with a fresh sync_status row (lag near zero)', async () => {
    await seedSyncStatus(Math.floor(Date.now() / 1000));
    const res = await fetch(`${server.baseUrl}/health`);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.chainId).toBe(1874);
    expect(body.indexedBlock).toBe('7285512');
    expect(body.lagSeconds).toBeLessThan(5);
  });

  it('reports status=degraded when the last synced block is stale (30-300s behind)', async () => {
    await seedSyncStatus(Math.floor(Date.now() / 1000) - 60);
    const res = await fetch(`${server.baseUrl}/health`);
    const body = await res.json();
    expect(body.status).toBe('degraded');
  });

  it('reports status=down when the last synced block is very stale (>300s behind)', async () => {
    await seedSyncStatus(Math.floor(Date.now() / 1000) - 1000);
    const res = await fetch(`${server.baseUrl}/health`);
    const body = await res.json();
    expect(body.status).toBe('down');
  });

  it('indexedBlock is a decimal string, never a JSON number (precision)', async () => {
    await seedSyncStatus(Math.floor(Date.now() / 1000));
    const res = await fetch(`${server.baseUrl}/health`);
    const text = await res.text();
    expect(text).toContain('"indexedBlock":"7285512"');
    expect(text).not.toContain('"indexedBlock":7285512');
  });
});
