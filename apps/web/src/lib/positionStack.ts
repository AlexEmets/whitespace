import { COLLATERAL_DECIMALS, LEVERAGE_DECIMALS, PRICE_DECIMALS_NUM } from './config';
import { collateralToRaw, formatExact, leverageToRaw, priceToRaw } from './money';
import { estimatePositionSizeBase } from './pnl';
import type { PositionSummary } from './types';

const PRICE_SCALE = 10n ** 18n;
const COLLATERAL_TO_PRICE = 10n ** 12n;

/**
 * Every open trade on one market in one direction, shown as the single position a trader
 * expects from a perp exchange.
 *
 * On chain they stay separate trades (Ostium keeps one Trade per slot, each with its own
 * entry, margin and liquidation level), so `legs` is what any write must address. `summary`
 * is the combined position in the same shape as one trade, so every display path that reads
 * a PositionSummary can render it:
 *  - collateral: the sum of the legs' margin;
 *  - leverage: total notional / total margin;
 *  - openPrice: the size-weighted average entry (total notional / total size), the price at
 *    which the combined size has the same PnL as the legs together;
 *  - tp / sl: the legs' level when they all share one, '0' otherwise (see tpMixed / slMixed).
 */
export interface PositionStack {
  key: string;
  pairIndex: number;
  buy: boolean;
  legs: PositionSummary[];
  summary: PositionSummary;
  /** Combined size in base units, PRECISION_18: the sum of the legs' sizes. */
  sizeBaseRaw: bigint;
  tpMixed: boolean;
  slMixed: boolean;
}

function commonLevel(values: string[]): { level: string; mixed: boolean } {
  const raws = values.map((v) => priceToRaw(v));
  const mixed = raws.some((r) => r !== raws[0]);
  return { level: mixed ? '0' : (values[0] ?? '0'), mixed };
}

/** Groups positions by market and side, in the order each group first appears. */
export function stackPositions(positions: PositionSummary[]): PositionStack[] {
  const groups = new Map<string, PositionSummary[]>();
  for (const p of positions) {
    const key = `${p.pairIndex}-${p.buy ? 'long' : 'short'}`;
    const legs = groups.get(key);
    if (legs) legs.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()].map(([key, unsorted]) => {
    const legs = [...unsorted].sort((a, b) => a.openedAt - b.openedAt || a.index - b.index);
    // A group exists only because a position was put in it.
    const first = legs[0]!;
    if (legs.length === 1) {
      return { key, pairIndex: first.pairIndex, buy: first.buy, legs, summary: first, sizeBaseRaw: estimatePositionSizeBase(first), tpMixed: false, slMixed: false };
    }
    let collateral = 0n;
    let notional = 0n; // PRECISION_6 × PRECISION_2
    let size = 0n;
    for (const leg of legs) {
      const c = collateralToRaw(leg.collateral);
      collateral += c;
      notional += c * leverageToRaw(leg.leverage);
      size += estimatePositionSizeBase(leg);
    }
    const leverage = collateral > 0n ? notional / collateral : 0n;
    const notional18 = (notional * COLLATERAL_TO_PRICE) / 10n ** BigInt(LEVERAGE_DECIMALS);
    const openPrice = size > 0n ? (notional18 * PRICE_SCALE) / size : 0n;
    const tp = commonLevel(legs.map((l) => l.tp));
    const sl = commonLevel(legs.map((l) => l.sl));
    return {
      key,
      pairIndex: first.pairIndex,
      buy: first.buy,
      legs,
      summary: {
        ...first,
        collateral: formatExact(collateral, COLLATERAL_DECIMALS),
        leverage: formatExact(leverage, LEVERAGE_DECIMALS),
        openPrice: formatExact(openPrice, PRICE_DECIMALS_NUM),
        tp: tp.level,
        sl: sl.level,
      },
      sizeBaseRaw: size,
      tpMixed: tp.mixed,
      slMixed: sl.mixed,
    };
  });
}

/**
 * The level at which the first leg is liquidated — the highest for a long, the lowest for a
 * short. Each leg is liquidated on its own, so this is where the combined position starts
 * losing margin to liquidation. Null while any leg's level is unknown: a partial answer
 * could hide the nearest one.
 */
export function nearestLiquidation(buy: boolean, levels: (bigint | null)[]): bigint | null {
  if (levels.length === 0 || levels.some((l) => l === null)) return null;
  const known = levels as bigint[];
  return known.reduce((best, l) => (buy ? (l > best ? l : best) : l < best ? l : best));
}
