import pg from 'pg';

const { Pool } = pg;

// node-postgres returns NUMERIC and (8-byte) BIGINT columns as JS strings by
// default — NOT floats — which is exactly what this service depends on to
// avoid ever routing a money value through a JS `number`. Confirmed directly
// against a live Postgres instance (see docs/decisions/phase-4-indexer-api.md)
// rather than assumed from memory. Ponder's `bigint` schema columns (prices,
// collateral, notional) are backed by Postgres NUMERIC; integer columns
// (leverage's raw int, pairIndex, block counts) are backed by Postgres
// INTEGER, which pg returns as `number` — safe, since int32 always fits
// exactly in a JS number.

let pool: pg.Pool | undefined;

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The Postgres schema the indexer (Ponder) writes to. A redeploy indexes into a NEW schema so the
 * previous deployment's rows are left untouched, and the API follows it through this one setting
 * instead of per-table qualifiers. Spliced into `SET search_path`, so only a bare identifier is
 * accepted. `public` stays on the path after it for anything not moved.
 */
export function indexerSchemaFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env.INDEXER_SCHEMA;
  if (raw === undefined) return 'public';
  if (!IDENTIFIER_RE.test(raw)) {
    throw new Error(`INDEXER_SCHEMA must be a bare lowercase identifier, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Pool sizing and timeouts. Exported so the defaults and their env overrides are testable. */
export type PoolTuning = {
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMs: number;
  idleTimeoutMillis: number;
};

/**
 * `max`: production runs the API, the Ponder indexer and the bots against one small Postgres
 * (docker-compose.yml caps it at max_connections=60). pg's default of 10 is kept but made
 * explicit so the connection budget is visible here and adjustable without a code change.
 *
 * `connectionTimeoutMillis`: pg's default is 0 — wait forever. While Postgres is in crash
 * recovery a connect can stall, so every request (and every WS poll tick) piled up behind a
 * connect that never resolved instead of failing fast and freeing the slot.
 *
 * `statementTimeoutMs`: a server-side cap per statement, so one pathological query cannot hold
 * a pooled connection (and Postgres memory) indefinitely on a 2 GB box.
 */
export function poolTuningFromEnv(env: Record<string, string | undefined> = process.env): PoolTuning {
  return {
    max: positiveIntEnv(env, 'PG_POOL_MAX', 10),
    connectionTimeoutMillis: positiveIntEnv(env, 'PG_CONNECT_TIMEOUT_MS', 5_000),
    statementTimeoutMs: positiveIntEnv(env, 'PG_STATEMENT_TIMEOUT_MS', 15_000),
    idleTimeoutMillis: positiveIntEnv(env, 'PG_IDLE_TIMEOUT_MS', 30_000),
  };
}

function positiveIntEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    const schema = indexerSchemaFromEnv();
    const tuning = poolTuningFromEnv();
    pool = new Pool({
      connectionString,
      // A startup parameter, not a `SET` on connect: it is in force before the first query of
      // every connection, with no extra round trip racing the caller's own query.
      ...(schema === 'public' ? {} : { options: `-c search_path=${schema},public` }),
      max: tuning.max,
      connectionTimeoutMillis: tuning.connectionTimeoutMillis,
      idleTimeoutMillis: tuning.idleTimeoutMillis,
      statement_timeout: tuning.statementTimeoutMs,
    });
    // An idle pooled client whose backend goes away (Postgres restarted, crash recovery,
    // pg_terminate_backend) is reported as an 'error' on the POOL, outside any query. With no
    // listener that emit is an uncaught exception, so every Postgres restart took the API down
    // with it. The pool has already discarded the dead client and the next query opens a fresh
    // one, so logging is the whole of the handling.
    pool.on('error', (err) => {
      console.error('[api] idle postgres client error:', err.message);
    });
  }
  return pool;
}

/**
 * Runs `fn` until it succeeds, sleeping with capped exponential backoff between attempts.
 *
 * Used for the boot-time schema setup: if Postgres is down or still in crash recovery when the
 * API starts, exiting only hands the retry to systemd's restart loop and its StartLimitBurst,
 * after which the unit stays dead. Waiting here means the API recovers by itself the moment
 * Postgres does.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    label: string;
    initialDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (msg: string) => void;
  },
): Promise<T> {
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((msg: string) => console.error(msg));
  let delay = Math.min(opts.initialDelayMs ?? 500, max);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      log(`[api] ${opts.label} failed (attempt ${attempt}): ${(err as Error).message}; retrying in ${delay} ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

/** Used by tests to point the API at a fresh ephemeral database and to
 * force a clean pool between test files. */
export function resetPool(): void {
  pool?.end().catch(() => undefined);
  pool = undefined;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
