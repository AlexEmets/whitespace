import { candle } from '../../ponder.schema.js';
import { bucketStart, applyTick, INTERVALS } from '@whitespace/shared/candles';

// See the comment on `type Db = any` in src/lib/db.ts for why this is
// deliberately untyped rather than structurally matching Ponder's branded
// context.db type — this helper is also used directly from a plain fake-db
// object in test/candleTick.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * Feed one price tick into every supported candle interval for a pair.
 *
 * Called from both the price-report handler (every PriceReceived, i.e. the
 * index/mark price stream) and the trade-execution handlers (every
 * MarketOpenExecuted / MarketCloseExecutedV2 / LimitOpenExecuted /
 * LimitCloseExecuted), per the task's "derive candles from price reports
 * and/or executed trades" instruction. `volume` should be 0n for pure price
 * ticks (price reports) and the trade's quote notional for executed trades
 * — see the volume-definition note in docs/decisions/phase-4-indexer-api.md
 * for why notional is computed as collateral*leverage/100 rather than the
 * event's `tradeNotional` field (which is base-asset denominated, not USDW).
 */
export async function recordTick(
  db: Db,
  pairIndex: number,
  timestampSeconds: number,
  price: bigint,
  volume: bigint,
): Promise<void> {
  for (const interval of INTERVALS) {
    const start = bucketStart(timestampSeconds, interval);
    const id = `${pairIndex}-${interval}-${start}`;
    const existing = (await db.find(candle, { id })) as
      | { open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint }
      | null;
    const next = applyTick(existing, price, volume);
    await db
      .insert(candle)
      .values({
        id,
        pairIndex,
        interval,
        bucketStart: start,
        open: next.open,
        high: next.high,
        low: next.low,
        close: next.close,
        volume: next.volume,
      })
      .onConflictDoUpdate({
        high: next.high,
        low: next.low,
        close: next.close,
        volume: next.volume,
      });
  }
}

/** Quote notional (PRECISION_6 USDW) for a trade: collateral * leverage / 100,
 * exact bigint math (leverage is PRECISION_2, so /100 rescales it to a
 * whole-number multiplier). */
export function quoteNotional(collateral: bigint, leverage: number): bigint {
  return (collateral * BigInt(leverage)) / 100n;
}
