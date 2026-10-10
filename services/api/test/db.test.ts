import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import pg from 'pg';
import { getPool, resetPool, poolTuningFromEnv, retryWithBackoff } from '../src/db.js';

/**
 * The API shares one small Postgres with the indexer and the bots. These pin the pool
 * behaviour that decides whether a Postgres restart is a blip or an API outage.
 */
describe('postgres pool resilience', () => {
  const savedEnv = { ...process.env };
  // An 'error' emitted with no listener is an uncaught exception — in production the process
  // dying. Capture them so the test fails on the crash itself.
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    resetPool();
  });
  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    for (const key of ['PG_STATEMENT_TIMEOUT_MS', 'PG_CONNECT_TIMEOUT_MS', 'PG_POOL_MAX']) delete process.env[key];
    process.env.DATABASE_URL = savedEnv.DATABASE_URL;
    resetPool();
  });

  it('survives the backend of an idle pooled client being killed, and the next query works', async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0].pid;
    expect(pool.idleCount).toBe(1);

    // What a Postgres restart does to every idle client, done to just this one.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await admin.end();
    // Wait until the pool has noticed and dropped the dead client.
    const deadline = Date.now() + 3000;
    while (pool.totalCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    expect(uncaught).toEqual([]);
    const after = await pool.query<{ one: number }>('SELECT 1 AS one');
    expect(after.rows[0].one).toBe(1);
  });

  it('cancels a statement that runs past PG_STATEMENT_TIMEOUT_MS', async () => {
    process.env.PG_STATEMENT_TIMEOUT_MS = '150';
    resetPool();
    await expect(getPool().query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
  });

  it('lets a statement inside PG_STATEMENT_TIMEOUT_MS finish (boundary)', async () => {
    process.env.PG_STATEMENT_TIMEOUT_MS = '2000';
    resetPool();
    await expect(getPool().query('SELECT pg_sleep(0.05)')).resolves.toBeDefined();
  });

  it('applies a default statement timeout when none is configured', async () => {
    const { rows } = await getPool().query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(rows[0].statement_timeout).toBe('15s');
  });

  it('gives up on a connect that never completes instead of waiting forever', async () => {
    // Accepts the TCP connection and then says nothing — what a Postgres stuck in recovery,
    // or a half-dead network path, looks like to the client.
    const sockets: net.Socket[] = [];
    const blackhole = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', r));
    const { port } = blackhole.address() as net.AddressInfo;
    try {
      process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/x`;
      process.env.PG_CONNECT_TIMEOUT_MS = '200';
      resetPool();
      const started = Date.now();
      await expect(getPool().query('SELECT 1')).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => blackhole.close(r));
    }
  });
});

describe('poolTuningFromEnv', () => {
  it('has explicit defaults', () => {
    expect(poolTuningFromEnv({})).toEqual({
      max: 10,
      connectionTimeoutMillis: 5000,
      statementTimeoutMs: 15000,
      idleTimeoutMillis: 30000,
    });
  });

  it('treats an empty value as unset', () => {
    expect(poolTuningFromEnv({ PG_POOL_MAX: '' }).max).toBe(10);
  });

  it('honours overrides', () => {
    expect(
      poolTuningFromEnv({ PG_POOL_MAX: '4', PG_CONNECT_TIMEOUT_MS: '1', PG_STATEMENT_TIMEOUT_MS: '999', PG_IDLE_TIMEOUT_MS: '7' }),
    ).toEqual({ max: 4, connectionTimeoutMillis: 1, statementTimeoutMs: 999, idleTimeoutMillis: 7 });
  });

  it.each(['0', '-1', 'abc', '1.5', '1e3', '9999999999'])('rejects PG_POOL_MAX=%s', (raw) => {
    expect(() => poolTuningFromEnv({ PG_POOL_MAX: raw })).toThrow(/PG_POOL_MAX/);
  });
});

describe('retryWithBackoff', () => {
  function harness() {
    const sleeps: number[] = [];
    const logs: string[] = [];
    return {
      sleeps,
      logs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: (m: string) => logs.push(m),
    };
  }

  it('returns the first success without sleeping', async () => {
    const h = harness();
    await expect(retryWithBackoff(async () => 42, { label: 'x', sleep: h.sleep, log: h.log })).resolves.toBe(42);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('keeps retrying through failures with doubling delays, then returns the value', async () => {
    const h = harness();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls <= 3) throw new Error('the database system is in recovery mode');
        return 'ok';
      },
      { label: 'schema setup', initialDelayMs: 100, sleep: h.sleep, log: h.log },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(h.sleeps).toEqual([100, 200, 400]);
    expect(h.logs[0]).toMatch(/schema setup failed \(attempt 1\): the database system is in recovery mode/);
  });

  it('caps the delay at maxDelayMs', async () => {
    const h = harness();
    let calls = 0;
    await retryWithBackoff(
      async () => {
        if (++calls <= 5) throw new Error('down');
      },
      { label: 'x', initialDelayMs: 500, maxDelayMs: 1500, sleep: h.sleep, log: h.log },
    );
    expect(h.sleeps).toEqual([500, 1000, 1500, 1500, 1500]);
  });

  it('clamps an initial delay above the cap', async () => {
    const h = harness();
    let calls = 0;
    await retryWithBackoff(
      async () => {
        if (++calls <= 1) throw new Error('down');
      },
      { label: 'x', initialDelayMs: 5000, maxDelayMs: 1000, sleep: h.sleep, log: h.log },
    );
    expect(h.sleeps).toEqual([1000]);
  });
});
