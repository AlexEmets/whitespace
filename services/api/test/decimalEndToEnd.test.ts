// End-to-end decimal precision: insert a value that WOULD be corrupted by
// any float in the path, round-trip it through real Postgres NUMERIC, an
// HTTP response, and JSON.parse, and assert the exact string survives.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestServer } from './testServer.js';
import { truncateAll, seedMarket, TRADER } from './seed.js';
import { getPool } from '../src/db.js';

// 2^53 + 1 = 9007199254740993 — the smallest integer a float64 cannot
// represent exactly. Confirmed to actually demonstrate corruption: naive
// `String(Number(raw) / 1e6)` yields "...740992" (wrong) where the correct
// bigint-based decimal yields "...740993" (right) — see the assertion
// below, which fails loudly if this stops being a real discriminator.
const DANGEROUS_COLLATERAL = '9007199254740993';
const DANGEROUS_PRICE = '9007199254740993000000000'; // same digits, scaled into an 18-decimal price

describe('decimal precision end to end (no float contamination)', () => {
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

  it('a position collateral value past 2^53 survives Postgres NUMERIC -> HTTP -> JSON exactly', async () => {
    await getPool().query(
      `INSERT INTO "position" (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, tp, sl, is_day_trade, open_order_id, open_tx_hash, opened_at, opened_at_block)
       VALUES (777, $1, 0, 1, true, $2, 100, '1', 0, 0, false, 777, '0x00', 1000, 1)`,
      [TRADER, DANGEROUS_COLLATERAL],
    );

    const res = await fetch(`${server.baseUrl}/positions/${TRADER}`);
    const text = await res.text();

    // Sanity: prove naive float formatting WOULD have corrupted this value,
    // so the test is actually discriminating.
    const naiveFloatString = String(Number(DANGEROUS_COLLATERAL) / 1e6);
    const body = JSON.parse(text);
    expect(body[0].collateral).not.toBe(naiveFloatString);

    // The real assertion: the exact base-1000000 integer is preserved,
    // scaled to a decimal string with no rounding — note the final digit
    // (...993) which the naive float path above got wrong (...992).
    expect(body[0].collateral).toBe('9007199254.740993');
  });

  it('an 18-decimal price past the float-safe range round-trips exactly through /markets/:pairIndex/candles', async () => {
    await getPool().query(
      `INSERT INTO candle (id, pair_index, interval, bucket_start, open, high, low, close, volume)
       VALUES ('0-1m-0', 0, '1m', 0, $1, $1, $1, $1, '0')`,
      [DANGEROUS_PRICE],
    );
    const res = await fetch(`${server.baseUrl}/markets/0/candles?interval=1m&from=0&to=0`);
    const body = await res.json();
    expect(body[0].o).toBe('9007199.254740993000000000');
    expect(body[0].c).toBe('9007199.254740993000000000');
  });

  it('the raw HTTP response body never contains an unquoted large integer for a money field', async () => {
    await getPool().query(
      `INSERT INTO "position" (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, tp, sl, is_day_trade, open_order_id, open_tx_hash, opened_at, opened_at_block)
       VALUES (778, $1, 0, 2, true, $2, 100, '1', 0, 0, false, 778, '0x00', 1000, 1)`,
      [TRADER, DANGEROUS_COLLATERAL],
    );
    const res = await fetch(`${server.baseUrl}/positions/${TRADER}`);
    const text = await res.text();
    // If this were serialized as a bare JSON number, the raw text would
    // contain the digits directly adjacent to a colon with no quotes.
    expect(text).not.toMatch(/"collateral":9007/);
    expect(text).toMatch(/"collateral":"9007199254\.740993"/);
  });
});
