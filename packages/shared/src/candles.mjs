// Candle (OHLCV) bucketing helpers shared by the indexer (writes candles as
// price ticks and trades arrive) and the API (validates the ?interval= query
// param). Bucket math is done on integer unix seconds only — no floats.

/** Supported chart intervals and their length in seconds. */
export const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

export const INTERVALS = Object.keys(INTERVAL_SECONDS);

/**
 * Floor a unix-second timestamp down to the start of its bucket for the
 * given interval.
 *
 * @param {number} timestampSeconds
 * @param {string} interval one of INTERVALS
 * @returns {number} bucket start, unix seconds
 */
export function bucketStart(timestampSeconds, interval) {
  const len = INTERVAL_SECONDS[interval];
  if (!len) {
    throw new TypeError(`unknown interval: ${interval}`);
  }
  if (!Number.isInteger(timestampSeconds)) {
    throw new TypeError(`timestampSeconds must be an integer, got ${timestampSeconds}`);
  }
  return Math.floor(timestampSeconds / len) * len;
}

/**
 * Apply one price/volume tick to a candle accumulator, in place semantics
 * (returns a new object; caller decides how to persist it). If `existing`
 * is null/undefined, this is the first tick in the bucket: o=h=l=c=price.
 * Otherwise: h=max(h,price), l=min(l,price), c=price, v+=volume.
 *
 * All price/volume arguments and returned fields are bigint — no floats
 * anywhere in this path.
 *
 * @param {{open: bigint, high: bigint, low: bigint, close: bigint, volume: bigint} | null | undefined} existing
 * @param {bigint} price
 * @param {bigint} volume non-negative volume delta contributed by this tick
 */
export function applyTick(existing, price, volume) {
  if (existing == null) {
    return { open: price, high: price, low: price, close: price, volume };
  }
  return {
    open: existing.open,
    high: price > existing.high ? price : existing.high,
    low: price < existing.low ? price : existing.low,
    close: price,
    volume: existing.volume + volume,
  };
}
