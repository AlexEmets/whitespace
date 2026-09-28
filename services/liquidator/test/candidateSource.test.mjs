import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createCandidateSource, pgQuery } from '../src/candidateSource.mjs';

// The real SQL runs against a real Postgres engine (PGlite, in-process): tables shaped
// like Ponder's output for services/indexer/ponder.schema.ts `position` (bigint columns
// are NUMERIC(78,0), integers INTEGER, hex TEXT) and the spec §9.1 `limit_order`.
const POSITION_DDL = `
  CREATE TABLE position (
    trade_id numeric(78,0) PRIMARY KEY, trader text NOT NULL, pair_index integer NOT NULL,
    "index" integer NOT NULL, buy boolean NOT NULL, collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL, open_price numeric(78,0) NOT NULL, tp numeric(78,0) NOT NULL,
    sl numeric(78,0) NOT NULL, is_day_trade boolean NOT NULL, open_order_id numeric(78,0) NOT NULL,
    open_tx_hash text NOT NULL, opened_at integer NOT NULL, opened_at_block numeric(78,0) NOT NULL)`;
const LIMIT_DDL = `
  CREATE TABLE limit_order (
    id text PRIMARY KEY, trader text NOT NULL, pair_index integer NOT NULL, "index" integer NOT NULL,
    order_type text NOT NULL, buy boolean NOT NULL, collateral numeric(78,0) NOT NULL,
    leverage integer NOT NULL, trigger_price numeric(78,0) NOT NULL, tp numeric(78,0) NOT NULL,
    sl numeric(78,0) NOT NULL, placed_at integer NOT NULL, updated_at integer NOT NULL, placed_tx text NOT NULL)`;

const TRADER = '0xAbCdEf0000000000000000000000000000000001';
// Above 2^53 on purpose: must survive as an exact bigint, never through a JS number.
const BIG_PRICE = '98765432109876543210123';

let db;
let query;

before(async () => {
  db = new PGlite();
  await db.exec(POSITION_DDL);
  await db.exec(`CREATE SCHEMA indexer`);
  await db.exec(POSITION_DDL.replace('TABLE position', 'TABLE indexer.position'));
  await db.exec(LIMIT_DDL.replace('TABLE limit_order', 'TABLE indexer.limit_order'));
  await db.query(
    `INSERT INTO position VALUES (7, $1, 1, 2, true, 1000000000, 1000, $2, 0, 90000000000000000000, false, 1, '0x', 0, 0)`,
    [TRADER, BIG_PRICE],
  );
  await db.query(
    `INSERT INTO indexer.limit_order VALUES ('x', $1, 0, 3, 'STOP', false, 5000000, 250, $2, 1, 2, 10, 11, '0x')`,
    [TRADER, BIG_PRICE],
  );
  query = async (text, params) => (await db.query(text, params)).rows;
});

after(async () => {
  await db?.close();
});

test('positions are parsed with exact bigints and a lowercase trader', async () => {
  const source = createCandidateSource({ query });
  const positions = await source.listPositions();
  assert.deepEqual(positions, [
    {
      tradeId: 7n,
      trader: TRADER.toLowerCase(),
      pairIndex: 1,
      index: 2,
      buy: true,
      collateral: 1_000_000000n,
      leverage: 1000n,
      openPrice: BigInt(BIG_PRICE),
      tp: 0n,
      sl: 90n * 10n ** 18n,
      isDayTrade: false,
    },
  ]);
});

test('a missing limit_order table is reported as unavailable, not thrown', async () => {
  const source = createCandidateSource({ query }); // public has no limit_order
  const all = await source.list();
  assert.equal(all.positions.length, 1);
  assert.deepEqual(all.limitOrders, []);
  assert.equal(all.limitOrdersAvailable, false);
});

test('limit orders are read from the configured schema and mapped to chain field names', async () => {
  const source = createCandidateSource({ query, schema: 'indexer' });
  const all = await source.list();
  assert.equal(all.positions.length, 0, 'indexer.position is empty');
  assert.equal(all.limitOrdersAvailable, true);
  assert.deepEqual(all.limitOrders, [
    {
      trader: TRADER.toLowerCase(),
      pairIndex: 0,
      index: 3,
      orderType: 'STOP',
      buy: false,
      collateral: 5_000000n,
      leverage: 250n,
      targetPrice: BigInt(BIG_PRICE),
      tp: 1n,
      sl: 2n,
      updatedAt: 11,
    },
  ]);
});

test('any other database error propagates (a sweep must not act on a partial view)', async () => {
  const source = createCandidateSource({
    query: async () => {
      const err = new Error('connection terminated');
      err.code = '57P01';
      throw err;
    },
  });
  await assert.rejects(source.list(), /connection terminated/);
  await assert.rejects(source.listLimitOrders(), /connection terminated/);
});

test('rejects a schema name that is not a plain identifier', () => {
  assert.throws(() => createCandidateSource({ query, schema: 'public"; DROP TABLE position; --' }), /invalid schema/);
  assert.throws(() => createCandidateSource({ query, schema: '' }), /invalid schema/);
});

test('pgQuery unwraps node-postgres results and passes params through', async () => {
  const calls = [];
  const q = pgQuery({ query: async (text, params) => (calls.push([text, params]), { rows: [{ a: 1 }] }) });
  assert.deepEqual(await q('SELECT 1', [2]), [{ a: 1 }]);
  assert.deepEqual(await q('SELECT 2'), [{ a: 1 }]);
  assert.deepEqual(calls, [['SELECT 1', [2]], ['SELECT 2', []]]);
});
