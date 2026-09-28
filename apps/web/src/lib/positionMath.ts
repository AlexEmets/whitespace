/**
 * Per-position figures for the positions table that are pure arithmetic on values the chain or
 * the API already supplied. Scales: prices 1e18, USDW 1e6.
 */

/**
 * How far a position has travelled from its entry toward its liquidation price, in percent:
 * 0 at entry (or in profit), 100 at liquidation. This is the table's "Margin usage": the
 * share of the maintenance buffer the price move has already consumed.
 */
export function marginUsagePercent(p: { buy: boolean; entry: bigint; mark: bigint; liq: bigint }): number {
  const toLiq = p.buy ? p.entry - p.liq : p.liq - p.entry;
  if (toLiq <= 0n) return 0;
  const moved = p.buy ? p.entry - p.mark : p.mark - p.entry;
  if (moved <= 0n) return 0;
  const bps = (moved * 10_000n) / toLiq;
  return Math.min(100, Number(bps) / 100);
}

/** Notional value of a base quantity at a price, 1e6 USDW. */
export function valueAt(sizeBaseRaw: bigint, price: bigint): bigint {
  return (sizeBaseRaw * price) / 10n ** 30n;
}

/**
 * The holding cost a position has accrued, as the trader sees it: funding plus rollover, both
 * signed "owed by the trader" on chain, returned NEGATED so a cost reads negative and a funding
 * receipt reads positive — the same sign convention as PnL.
 */
export function netFundingForDisplay(fundingOwed: bigint, rolloverOwed: bigint): bigint {
  return -(fundingOwed + rolloverOwed);
}

/**
 * Funding rate per hour in percent at 1e18 scale, from the contract's per-block rate
 * (PRECISION_18 fraction per block) at 1 s blocks. Positive: longs pay shorts.
 */
export function fundingRatePerHourP(ratePerBlock: bigint, blocksPerHour = 3600n): bigint {
  return ratePerBlock * blocksPerHour * 100n;
}
