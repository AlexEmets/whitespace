import { getPool } from '../src/db.js';

// Real values from deployments/1874-operational.json's proof trade, plus
// synthetic rows for cases the one real trade doesn't cover (pending
// orders, a second trader, boundary candle buckets). Trader addresses are
// lowercased on write, mirroring what the indexer stores (Ponder's `hex`
// column type lowercases addresses) and what the API's route handlers do
// when reading a path param.
export const TRADER = '0x2b8ba090dedf879f8045c0dda5a78762ced90d19';
// A well-formed 20-byte address (it was 19 bytes, which the address-validating routes
// now reject with 400 rather than answer with an empty list).
export const OTHER_TRADER = '0x00000000000000000000000000000000000000aa';
export const OPEN_PRICE = '65001000000000000000000';
export const COLLATERAL = '999000000';

export async function truncateAll(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `TRUNCATE market, price_request, price_report, "order", "position", closed_position, lp_activity, candle, sync_status,
       limit_order, order_event, fee_charge, liquidation, vault_settlement, partial_close,
       points_event, wallet_points, points_daily, wallet_streak, wallet_lp`,
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
  // Same story for the faucet's own cooldown ledger (src/faucet.ts): its own schema, guarded
  // so a file that runs before the schema is bootstrapped does not error here.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('api_faucet.faucet_claims') IS NOT NULL THEN
        TRUNCATE api_faucet.faucet_claims;
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

/** A wallet_points aggregate row (points at 6 dp, as raw base units). */
export async function seedWalletPoints(
  over: { trader?: string; missions?: string; time?: string; streak?: string; lp?: string; updatedAt?: number } = {},
): Promise<void> {
  const missions = over.missions ?? '0';
  const time = over.time ?? '0';
  const streak = over.streak ?? '0';
  const lp = over.lp ?? '0';
  const total = (BigInt(missions) + BigInt(time) + BigInt(streak) + BigInt(lp)).toString();
  await getPool().query(
    `INSERT INTO wallet_points (trader, missions_raw, time_raw, streak_raw, lp_raw, total_raw, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [over.trader ?? TRADER, missions, time, streak, lp, total, over.updatedAt ?? 1788881880],
  );
}

/** A wallet_streak state row. */
export async function seedWalletStreak(
  over: { trader?: string; lastQualifiedDay?: number; currentLength?: number; longest?: number } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO wallet_streak (trader, last_qualified_day, current_length, longest, updated_at)
     VALUES ($1, $2, $3, $4, 1788881880)`,
    [over.trader ?? TRADER, over.lastQualifiedDay ?? 20705, over.currentLength ?? 1, over.longest ?? 1],
  );
}

/** A wallet_lp balance-state row (USDW assets at 6 dp). */
export async function seedWalletLp(
  over: { owner?: string; balanceRaw?: string; lastAccrualAt?: number } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO wallet_lp (owner, balance_raw, last_accrual_at) VALUES ($1, $2, $3)`,
    [over.owner ?? TRADER, over.balanceRaw ?? '8500000000', over.lastAccrualAt ?? 1788881880],
  );
}

/** A ledger row for an unlocked mission. */
export async function seedMissionEvent(
  missionId: string,
  over: { trader?: string; pointsRaw?: string; at?: number } = {},
): Promise<void> {
  const trader = over.trader ?? TRADER;
  const raw = over.pointsRaw ?? '50000000';
  await getPool().query(
    `INSERT INTO points_event (id, trader, component, points_raw, requested_raw, day_index, ref_id, at, tx_hash)
     VALUES ($1, $2, 'mission', $3, $3, 20705, $4, $5, $6)`,
    [`mission-${trader}-${missionId}`, trader, raw, missionId, over.at ?? 1788881880, TX_A],
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

export async function seedOrder(
  orderId: number,
  over: { kind?: string; status?: string; requestedAt?: number; trader?: string; cancelReason?: string | null } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO "order" (order_id, trader, pair_index, kind, trade_id, index, buy, collateral, leverage, status, requested_at, requested_at_block, request_tx_hash, resolved_at, cancel_reason)
     VALUES ($1, $2, 0, $3, NULL, NULL, NULL, NULL, NULL, $4, $5, 7285600, $6, NULL, $7)`,
    [orderId, over.trader ?? TRADER, over.kind ?? 'open', over.status ?? 'pending', over.requestedAt ?? 1000, TX_B, over.cancelReason ?? null],
  );
}

export async function seedOrderEvent(
  id: string,
  over: { kind?: string; at?: number; trader?: string } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO order_event (id, trader, pair_index, index, kind, order_type, buy, collateral, leverage, trigger_price, tp, sl, order_id, trade_id, at, block_number, tx_hash)
     VALUES ($1, $2, 0, 1, $3, 'STOP', false, 25000000, 500, '59000000000000000000000', 0, '61000000000000000000000', NULL, NULL, $4, 900, $5)`,
    [id, over.trader ?? TRADER, over.kind ?? 'limit_placed', over.at ?? 1000, TX_A],
  );
}

export async function seedFee(
  id: string,
  kind: string,
  amount: string,
  over: { at?: number; tradeId?: number | null; trader?: string; pairIndex?: number | null } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO fee_charge (id, trader, trade_id, pair_index, kind, amount, at, block_number, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 7285600, $8)`,
    [id, over.trader ?? TRADER, over.tradeId === undefined ? 2 : over.tradeId, over.pairIndex === undefined ? 0 : over.pairIndex, kind, amount, over.at ?? 1000, TX_A],
  );
}

/** A partial close of the proof trade (tradeId 2): 25 % of 999 USDW closed, 260 sent back
 * -> +10.25 realised. */
export async function seedPartialClose(
  over: { orderId?: number; closedAt?: number; tradeId?: number; sent?: string; reason?: string } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO partial_close (order_id, trade_id, trader, pair_index, index, buy, collateral, leverage, open_price, close_price, close_reason, percent_profit, usdc_sent_to_trader, percentage_closed, opened_at, closed_at, close_tx_hash)
     VALUES ($1, $2, $3, 0, 0, true, 249750000, 1000, $4, '65700000000000000000000', $5, 41041041, $6, 2500, 1788881876, $7, $8)`,
    [over.orderId ?? 5, over.tradeId ?? 2, TRADER, OPEN_PRICE, over.reason ?? 'close', over.sent ?? '260000000', over.closedAt ?? 1788881878, TX_B],
  );
}
