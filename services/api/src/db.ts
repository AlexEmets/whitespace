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

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
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
