/**
 * The continuous index-price series, and the OHLC candles built from it.
 *
 * THE PROBLEM THIS SOLVES. Until now the only candle source was `public.candle`, which
 * the indexer fills from `PriceReceived` logs. A price report reaches the chain only when
 * an order needs one, so that table holds exactly as many ticks as the market has ever
 * had orders — three, at the time this was written, across two buckets two days apart.
 * The chart was not broken; it was faithfully drawing a series that only moves when
 * someone trades. No amount of frontend work fixes that, because the data does not exist.
 *
 * WHERE THE PRICES COME FROM. The publisher already computes the index continuously from
 * its venue connections — that is the number the protocol prices trades at. This module
 * samples it on a timer and buckets it, so the chart shows the same index the order form
 * quotes and the keeper signs. Nothing here invents, interpolates or smooths a price: a
 * bucket exists only if at least one sample landed in it, and `tick_count` records how
 * many did.
 *
 * WHY ITS OWN SCHEMA. `public` belongs to Ponder, which owns its tables through builds,
 * crash recovery and reorg reverts. A table of ours sitting in there is one recovery path
 * away from being a surprise. `api_series` is owned by this service alone.
 *
 * VOLUME IS NOT FROM HERE. An index tick has no volume — nothing traded. Volume stays
 * where it is real, in the indexer's on-chain candle, and `readIndexCandles` joins it in
 * per bucket. A bucket with price movement and no trades reports zero volume, which is
 * the truth about it.
 */

import { INTERVALS, bucketStart } from '@whitespace/shared/candles';
import { query } from './db.js';
import { feedNameOf, getPublisherFeeds } from './publisher.js';

const SCHEMA = 'api_series';

/**
 * Creates the schema and table if they are absent. Called once at startup.
 *
 * `open` is written only on insert and never updated, which is what makes the
 * ON CONFLICT below an exact OHLC accumulator: first sample in the bucket sets the open,
 * later ones can only widen high/low and move close. Doing it as one upsert rather than
 * read-modify-write means two API instances sampling the same second cannot interleave
 * into a lost update.
 *
 * NUMERIC with no precision, not BIGINT: an 18-decimal price above ~9.2 is already past
 * int64. `pg` hands NUMERIC back as a string, which is exactly what the money formatter
 * wants and what keeps this off JS floats end to end.
 */
export async function ensureIndexSeriesSchema(): Promise<void> {
  await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.index_candle (
      pair_index   integer  NOT NULL,
      interval     text     NOT NULL,
      bucket_start integer  NOT NULL,
      open         numeric  NOT NULL,
      high         numeric  NOT NULL,
      low          numeric  NOT NULL,
      close        numeric  NOT NULL,
      tick_count   integer  NOT NULL DEFAULT 1,
      updated_at   integer  NOT NULL,
      PRIMARY KEY (pair_index, interval, bucket_start)
    )
  `);
}

/**
 * Folds one index price into every interval's current bucket.
 *
 * `priceRaw` is the raw PRECISION_18 integer as digits — the publisher's own wire form.
 * It is interpolated into the statement as a literal cast, not passed as a parameter,
 * only for `bucket_start`; the price itself is parameterised.
 */
export async function recordIndexTick(pairIndex: number, priceRaw: string, atSeconds: number): Promise<void> {
  for (const interval of INTERVALS) {
    // Same bucketing function the indexer uses for the on-chain series. Sharing it is
    // what lets readIndexCandles join the two tables on bucket_start at all — two
    // independent floor-divisions that merely agree today would drift the moment either
    // side changed an interval length.
    const bucket = bucketStart(atSeconds, interval);
    await query(
      `INSERT INTO ${SCHEMA}.index_candle
         (pair_index, interval, bucket_start, open, high, low, close, tick_count, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 1, $5)
       ON CONFLICT (pair_index, interval, bucket_start) DO UPDATE SET
         high       = GREATEST(${SCHEMA}.index_candle.high, EXCLUDED.high),
         low        = LEAST(${SCHEMA}.index_candle.low, EXCLUDED.low),
         close      = EXCLUDED.close,
         tick_count = ${SCHEMA}.index_candle.tick_count + 1,
         updated_at = EXCLUDED.updated_at`,
      [pairIndex, interval, bucket, priceRaw, atSeconds],
    );
  }
}

export type IndexCandleRow = {
  bucket_start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

/**
 * Candles for the chart: OHLC from the index series, volume from whatever actually
 * traded in that bucket on chain. `COALESCE(..., 0)` because a bucket with no trades has
 * no row on the indexer side, and the honest volume for "nobody traded" is zero.
 */
export async function readIndexCandles(
  pairIndex: number,
  interval: string,
  from: number,
  to: number,
): Promise<IndexCandleRow[]> {
  return query<IndexCandleRow>(
    `SELECT i.bucket_start,
            i.open, i.high, i.low, i.close,
            COALESCE(c.volume, 0) AS volume
       FROM ${SCHEMA}.index_candle i
       LEFT JOIN public.candle c
              ON c.pair_index = i.pair_index
             AND c.interval   = i.interval
             AND c.bucket_start = i.bucket_start
      WHERE i.pair_index = $1 AND i.interval = $2
        AND i.bucket_start >= $3 AND i.bucket_start <= $4
      ORDER BY i.bucket_start ASC`,
    [pairIndex, interval, from, to],
  );
}

/** The most recent index candle for a bucket, for the WS `candles:` channel. */
export async function readLatestIndexCandle(pairIndex: number, interval: string): Promise<IndexCandleRow | null> {
  const rows = await query<IndexCandleRow>(
    `SELECT i.bucket_start,
            i.open, i.high, i.low, i.close,
            COALESCE(c.volume, 0) AS volume
       FROM ${SCHEMA}.index_candle i
       LEFT JOIN public.candle c
              ON c.pair_index = i.pair_index
             AND c.interval   = i.interval
             AND c.bucket_start = i.bucket_start
      WHERE i.pair_index = $1 AND i.interval = $2
      ORDER BY i.bucket_start DESC
      LIMIT 1`,
    [pairIndex, interval],
  );
  return rows[0] ?? null;
}

/** Has this pair any index history at all? Lets a route fall back to the on-chain
 * candle table on a fresh database rather than render an empty chart. */
export async function hasIndexHistory(pairIndex: number, interval: string): Promise<boolean> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${SCHEMA}.index_candle WHERE pair_index = $1 AND interval = $2`,
    [pairIndex, interval],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}

/**
 * Samples the publisher and records a tick for every market it tracks, on a timer.
 *
 * The pair list is re-read from `market` each tick rather than cached at startup: markets
 * are added on chain by governance, and a recorder that cached the list at boot would
 * silently never chart a market added afterwards.
 *
 * `mark` is the sampled price, not `index` — mark is the EMA the protocol actually prices
 * against (see the publisher's engine), so the chart and the execution price agree.
 * A feed reporting `noData`, `degraded`, or a null mark contributes no tick: a gap in the
 * chart is the correct rendering of "the venues were not answering", and inventing a
 * flat continuation across an outage would hide exactly the event a trader needs to see.
 */
export function startIndexRecorder(opts: { intervalMs?: number } = {}): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 5000;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // a slow DB must not stack overlapping sweeps
    running = true;
    try {
      const feeds = await getPublisherFeeds();
      if (!feeds) return;
      const markets = await query<{ pair_index: number; from_symbol: string; to_symbol: string }>(
        'SELECT pair_index, from_symbol, to_symbol FROM market',
      );
      const at = Math.floor(Date.now() / 1000);
      for (const market of markets) {
        const feed = feeds[feedNameOf(market.from_symbol, market.to_symbol)];
        if (!feed || feed.noData || feed.degraded || feed.mark === null) continue;
        await recordIndexTick(market.pair_index, feed.mark, at);
      }
    } catch (err) {
      // Never let a transient DB or publisher fault kill the timer — the next sweep is
      // 5 seconds away and the gap is visible in the chart either way.
      console.error('[api] index recorder tick failed:', (err as Error).message);
    } finally {
      running = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
