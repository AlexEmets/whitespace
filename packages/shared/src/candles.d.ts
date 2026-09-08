export const INTERVAL_SECONDS: Record<string, number>;
export const INTERVALS: readonly string[];
export function bucketStart(timestampSeconds: number, interval: string): number;
export function applyTick(
  existing: { open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint } | null | undefined,
  price: bigint,
  volume: bigint,
): { open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint };
