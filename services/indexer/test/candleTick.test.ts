// Exercises recordTick() against a minimal in-memory fake of Ponder's
// context.db (find/insert/onConflictDoUpdate), which is exactly the surface
// recordTick uses. This proves the candle-aggregation wiring end to end
// (bucketing + OHLC accumulation + upsert), on top of the pure bucket-math
// tests in packages/shared/test/candles.test.mjs.
import { describe, it, expect, beforeEach } from 'vitest';
import { recordTick, quoteNotional } from '../src/lib/candleTick.js';
import { INTERVALS } from '@whitespace/shared/candles';

type Row = Record<string, unknown>;

function makeFakeDb() {
  const rows = new Map<string, Row>();
  const db = {
    async find(_table: unknown, key: { id: string }) {
      return rows.get(key.id) ?? null;
    },
    insert(_table: unknown) {
      return {
        values(v: Row) {
          return {
            async onConflictDoUpdate(patch: Row) {
              const id = v.id as string;
              if (rows.has(id)) {
                rows.set(id, { ...rows.get(id), ...patch });
              } else {
                rows.set(id, v);
              }
              return rows.get(id);
            },
          };
        },
      };
    },
  };
  return { db, rows };
}

describe('recordTick', () => {
  let ctx: ReturnType<typeof makeFakeDb>;
  beforeEach(() => {
    ctx = makeFakeDb();
  });

  it('creates one candle row per supported interval for a single tick', async () => {
    await recordTick(ctx.db, 0, 1000, 65001000000000000000000n, 0n);
    expect(ctx.rows.size).toBe(INTERVALS.length);
  });

  it('seeds open=high=low=close on the first tick', async () => {
    await recordTick(ctx.db, 0, 1000, 100n, 0n);
    const row = ctx.rows.get('0-1m-960')!; // bucketStart(1000,'1m') = 960
    expect(row.open).toBe(100n);
    expect(row.high).toBe(100n);
    expect(row.low).toBe(100n);
    expect(row.close).toBe(100n);
  });

  it('a second tick in the SAME bucket updates high/low/close but not open', async () => {
    await recordTick(ctx.db, 0, 1000, 100n, 10n);
    await recordTick(ctx.db, 0, 1010, 120n, 5n); // still in the 960-1020 1m bucket
    const row = ctx.rows.get('0-1m-960')!;
    expect(row.open).toBe(100n);
    expect(row.high).toBe(120n);
    expect(row.low).toBe(100n);
    expect(row.close).toBe(120n);
    expect(row.volume).toBe(15n);
  });

  it('a tick in the NEXT bucket creates a separate row, leaving the first untouched', async () => {
    await recordTick(ctx.db, 0, 1000, 100n, 10n);
    await recordTick(ctx.db, 0, 1070, 200n, 1n); // crosses into the next 1m bucket (1020-1080)
    const first = ctx.rows.get('0-1m-960')!;
    const second = ctx.rows.get('0-1m-1020')!;
    expect(first.close).toBe(100n); // unchanged by the later tick
    expect(second.open).toBe(200n);
    expect(second.close).toBe(200n);
  });

  it('different pairIndex values never share a candle row', async () => {
    await recordTick(ctx.db, 0, 1000, 100n, 0n);
    await recordTick(ctx.db, 1, 1000, 999n, 0n);
    expect(ctx.rows.get('0-1m-960')!.close).toBe(100n);
    expect(ctx.rows.get('1-1m-960')!.close).toBe(999n);
  });

  it('a down-tick lowers low but keeps high, in the 1h bucket too', async () => {
    await recordTick(ctx.db, 0, 1000, 100n, 0n);
    await recordTick(ctx.db, 0, 1500, 50n, 0n);
    const hourRow = ctx.rows.get('0-1h-0')!;
    expect(hourRow.high).toBe(100n);
    expect(hourRow.low).toBe(50n);
    expect(hourRow.close).toBe(50n);
  });
});

describe('quoteNotional', () => {
  it('matches the real proof trade: 999.000000 collateral * 10.00x = 9990.000000 USDW', () => {
    expect(quoteNotional(999000000n, 1000)).toBe(9990000000n);
  });

  it('is exact bigint math, no float rounding, for an odd leverage value', () => {
    // 100.123456 collateral * 3.33x -> 333.41111808 truncated to integer division
    expect(quoteNotional(100123456n, 333)).toBe((100123456n * 333n) / 100n);
  });

  it('zero leverage or zero collateral yields zero notional', () => {
    expect(quoteNotional(0n, 1000)).toBe(0n);
    expect(quoteNotional(999000000n, 0)).toBe(0n);
  });
});
