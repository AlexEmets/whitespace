import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, resetPool } from '../src/db.js';
import { indexerSchemaFromEnv } from '../src/db.js';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll } from './seed.js';

/**
 * A redeploy indexes into a NEW Ponder schema so the old deployment's rows are left alone. The
 * API must then read every indexer table — including the candle volume the index series joins —
 * from that schema, chosen by INDEXER_SCHEMA, without being told table by table.
 */
describe('INDEXER_SCHEMA', () => {
  let server: TestServer;

  beforeAll(async () => {
    await truncateAll();
    await query('DROP SCHEMA IF EXISTS redeploy CASCADE');
    await query('CREATE SCHEMA redeploy');
    await query('CREATE TABLE redeploy.market (LIKE public.market INCLUDING ALL)');
    await query('CREATE TABLE redeploy.candle (LIKE public.candle INCLUDING ALL)');
    await query(
      `INSERT INTO redeploy.market (pair_index, from_symbol, to_symbol, feed_id, oracle, group_index, fee_index,
         max_leverage, max_open_interest, open_interest_long, open_interest_short, updated_at_block, updated_at)
       VALUES (3, 'WBT', 'USD', '0x00', 'WBT/USD', 0, 0, 2500, 100000000000, 0, 0, 1, 1)`,
    );
    process.env.INDEXER_SCHEMA = 'redeploy';
    resetPool();
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.INDEXER_SCHEMA;
    resetPool();
    await query('DROP SCHEMA IF EXISTS redeploy CASCADE');
  });

  it('serves markets from the configured schema, not public', async () => {
    const res = await fetch(`${server.baseUrl}/markets`);
    const body = (await res.json()) as { pairIndex: number; from: string }[];
    expect(body.map((m) => [m.pairIndex, m.from])).toEqual([[3, 'WBT']]);
  });
});

describe('indexerSchemaFromEnv', () => {
  it('defaults to public', () => {
    expect(indexerSchemaFromEnv({})).toBe('public');
  });
  it('accepts a plain identifier', () => {
    expect(indexerSchemaFromEnv({ INDEXER_SCHEMA: 'ws_1874_v2' })).toBe('ws_1874_v2');
  });
  it('refuses anything that is not a bare identifier, since it is spliced into SET search_path', () => {
    for (const bad of ['a;DROP TABLE x', 'a b', '1abc', 'a"b', '']) {
      expect(() => indexerSchemaFromEnv({ INDEXER_SCHEMA: bad })).toThrow(/INDEXER_SCHEMA/);
    }
  });
});
