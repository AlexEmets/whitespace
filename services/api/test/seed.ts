import { getPool } from '../src/db.js';

// Real values from deployments/1874-operational.json's proof trade, plus
// synthetic rows for cases the one real trade doesn't cover (pending
// orders, a second trader, boundary candle buckets). Trader addresses are
// lowercased on write, mirroring what the indexer stores (Ponder's `hex`
// column type lowercases addresses) and what the API's route handlers do
// when reading a path param.
export const TRADER = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19';
export const OTHER_TRADER = '0x000000000000000000000000000000000000aa';
export const OPEN_PRICE = '65001000000000000000000';
export const COLLATERAL = '999000000';

export async function truncateAll(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `TRUNCATE market, price_request, price_report, "order", "position", closed_position, lp_activity, candle, sync_status,
       limit_order, order_event, fee_charge, liquidation, vault_settlement`,
  );
  // Not in the list above: that TRUNCATE names Ponder's tables, and this one is the
  // API's own (src/indexSeries.ts). Guarded because a test file may run before any
  // server has bootstrapped the schema — and guarded with to_regclass rather than a
  // swallowed error, so a genuine failure here still surfaces instead of leaving rows
  // to leak into the next test.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('api_series.index_candle') IS NOT NULL THEN
        TRUNCATE api_series.index_candle;
      END IF;
    END $$;
  `);
}

/** An index-series candle, as the recorder would have written it. */
export async function seedIndexCandle(
  interval: string,
  bucketStart: number,
  ohlc: { open: string; high: string; low: string; close: string },
  pairIndex = 0,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO api_series.index_candle (pair_index, interval, bucket_start, open, high, low, close, tick_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $3)`,
    [pairIndex, interval, bucketStart, ohlc.open, ohlc.high, ohlc.low, ohlc.close],
  );
}

export async function seedMarket(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO market (pair_index, from_symbol, to_symbol, feed_id, oracle, group_index, fee_index, max_leverage, max_open_interest, open_interest_long, open_interest_short, updated_at_block, updated_at)
     VALUES (0, 'BTC', 'USD', '0x4254432f55534400000000000000000000000000000000000000000000000000', 'BTC/USD', 0, 0, 10000, 1000000000000, 9990000000, 0, 7284583, 1788881000)`,
  );
}

export async function seedSyncStatus(blockTimestamp: number): Promise<void> {
  const pool = getPool();
  await pool.query(`INSERT INTO sync_status (chain_id, block_number, block_timestamp) VALUES (1874, 7285512, $1)`, [
    blockTimestamp,
  ]);
}

export async function seedOpenPosition(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO "position" (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, tp, sl, is_day_trade, open_order_id, open_tx_hash, opened_at, opened_at_block)
     VALUES (2, $1, 0, 0, true, $2, 1000, $3, 0, 0, false, 2, '0x14b55e4006195f32cd51eeb65c96a7b26e446d3101ba873e10fb1541e5e61011', 1788881876, 7284716)`,
    [TRADER, COLLATERAL, OPEN_PRICE],
  );
}

export async function seedClosedPosition(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO closed_position (trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, close_price, tp, sl, close_reason, percent_profit, usdc_sent_to_trader, percentage_closed, open_order_id, close_order_id, opened_at, closed_at, close_tx_hash)
     VALUES (2, $1, 0, 0, true, $2, 1000, $3, '64999000000000000000000', 0, 0, 'close', -30768, 998692628, 10000, 2, 3, 1788881876, 1788881880, '0xaa0d4683a5b2213e8b6886073712d1bde606dac54868b77382be7b97203d37b5')`,
    [TRADER, COLLATERAL, OPEN_PRICE],
  );
}

export async function seedPendingOrder(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO "order" (order_id, trader, pair_index, kind, trade_id, index, buy, collateral, leverage, status, requested_at, requested_at_block, request_tx_hash)
     VALUES (99, $1, 0, 'open', NULL, NULL, NULL, NULL, NULL, 'pending', 1788882000, 7285600, '0x0000000000000000000000000000000000000000000000000000000000000001')`,
    [TRADER],
  );
}

export async function seedPriceReport(price: string, blockTimestamp: number, orderId = 2): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO price_report (order_id, pair_index, price, native_fee, block_number, block_timestamp, tx_hash)
     VALUES ($1, 0, $2, 0, 7284716, $3, '0x14b55e4006195f32cd51eeb65c96a7b26e446d3101ba873e10fb1541e5e61011')`,
    [orderId, price, blockTimestamp],
  );
}

export async function seedCandle(
  interval: string,
  bucketStart: number,
  ohlc: { o: string; h: string; l: string; c: string; v: string },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO candle (id, pair_index, interval, bucket_start, open, high, low, close, volume)
     VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8)`,
    [`0-${interval}-${bucketStart}`, interval, bucketStart, ohlc.o, ohlc.h, ohlc.l, ohlc.c, ohlc.v],
  );
}

export const TX_A = '0x00000000000000000000000000000000000000000000000000000000000000a1';
export const TX_B = '0x00000000000000000000000000000000000000000000000000000000000000b2';

export async function seedLimitOrder(
  over: { index?: number; orderType?: string; placedAt?: number; trader?: string } = {},
): Promise<void> {
  const trader = over.trader ?? TRADER;
  const index = over.index ?? 0;
  await getPool().query(
    `INSERT INTO limit_order (id, trader, pair_index, index, order_type, buy, collateral, leverage, trigger_price, tp, sl, placed_at, updated_at, placed_tx)
     VALUES ($1, $2, 0, $3, $4, true, 50000000, 1000, '60000000000000000000000', '70000000000000000000000', 0, $5, $5, $6)`,
    [`${trader}-0-${index}`, trader, index, over.orderType ?? 'LIMIT', over.placedAt ?? 1788882000, TX_A],
  );
}
