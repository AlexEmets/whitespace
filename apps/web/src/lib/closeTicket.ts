/**
 * The arithmetic behind the close dialog. A close is a SHARE of the position, not an
 * amount: `closeTradeMarket` takes `closePercentage` in PRECISION_2 (10000 = all of it,
 * OstiumTrading.sol:28), so a typed amount is turned into a share at the contract's 0.01%
 * grain and the dialog shows what that share actually closes.
 */

/** A full close, in the contract's PRECISION_2 percent. */
export const FULL_SHARE = 10_000;

/** Base-asset size a share of the position closes. */
export function closeSizeForShare(sizeBaseRaw: bigint, share: number): bigint {
  return (sizeBaseRaw * BigInt(share)) / BigInt(FULL_SHARE);
}

/**
 * The share of the position a typed base amount represents, rounded half-up to 0.01% and
 * never below it — a real amount does not round to "close nothing". The full size or more
 * is a full close. `null` for nothing to close.
 */
export function shareForCloseSize(amountRaw: bigint, sizeBaseRaw: bigint): number | null {
  if (amountRaw <= 0n || sizeBaseRaw <= 0n) return null;
  if (amountRaw >= sizeBaseRaw) return FULL_SHARE;
  const share = Number((amountRaw * BigInt(FULL_SHARE) * 2n + sizeBaseRaw) / (sizeBaseRaw * 2n));
  return Math.min(FULL_SHARE, Math.max(1, share));
}

export interface MinPositionInputs {
  /** PRECISION_6 collateral of the position. */
  collateralRaw: bigint;
  /** PRECISION_2 leverage, e.g. 1000n for 10.00x. */
  leverageRaw: bigint;
  /** PRECISION_6 minimum leveraged position for the pair (`pairMinLevPos`). */
  minLevPosRaw: bigint;
}

/**
 * Whether closing `share` would leave a position below the market's minimum. The same
 * integer arithmetic as TradingLib.getCloseTradeRevert, so the dialog refuses exactly what
 * the contract would revert with `BelowMinLevPos` — before the wallet opens rather than in
 * a failed simulation.
 */
export function leavesTooLittle(p: MinPositionInputs & { share: number }): boolean {
  if (p.share >= FULL_SHARE) return false;
  const remainingCollateral = (p.collateralRaw * BigInt(FULL_SHARE - p.share)) / BigInt(FULL_SHARE);
  return (remainingCollateral * p.leverageRaw) / 100n < p.minLevPosRaw;
}

/**
 * The largest partial close that still leaves the minimum, or 0 when none does and only a
 * full close is possible. Found by bisection over `leavesTooLittle` itself, so it can never
 * disagree with the check by a rounding step.
 */
export function maxPartialShare(p: MinPositionInputs): number {
  let lo = 0;
  let hi = FULL_SHARE - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (leavesTooLittle({ ...p, share: mid })) hi = mid - 1;
    else lo = mid;
  }
  return lo === 0 || leavesTooLittle({ ...p, share: lo }) ? 0 : lo;
}

/** That share of an unrealised PnL estimate — what closing it would realise, before fees. */
export function pnlForShare(pnlRaw: bigint, share: number): bigint {
  return (pnlRaw * BigInt(share)) / BigInt(FULL_SHARE);
}
