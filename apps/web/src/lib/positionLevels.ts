import { formatLeverage, priceToRaw } from './money';
import type { PositionSummary } from './types';

/**
 * The price levels of an open position that the chart draws over the candles: where it was
 * entered, its take-profit and stop-loss when set, and where it is liquidated. Prices are
 * raw 1e18 bigints, the same scale as the chart's own axis, so placing them is the chart's
 * usual pixel maths and labelling them goes through formatMoney like every other price.
 */

export type LevelKind = 'entry' | 'tp' | 'sl' | 'liq';

export interface PositionLevel {
  /** Unique across every position on the chart: pair, trade slot and kind. */
  key: string;
  kind: LevelKind;
  price: bigint;
  /** The short tag drawn on the line: "Long 100.00x" for the entry, "TP", "SL", "Liq.". */
  tag: string;
}

/**
 * A position's levels in a fixed order — entry, TP, SL, liquidation. A TP or SL of zero is
 * the contract's "none" and is left off; so is the liquidation price until the contract has
 * answered, because a level drawn at a guess is one a trader would size a stop against.
 */
export function positionLevels(position: PositionSummary, liq: bigint | null): PositionLevel[] {
  const key = (kind: LevelKind) => `${position.pairIndex}:${position.index}:${kind}`;
  const levels: PositionLevel[] = [
    {
      key: key('entry'),
      kind: 'entry',
      price: priceToRaw(position.openPrice),
      tag: `${position.buy ? 'Long' : 'Short'} ${formatLeverage(position.leverage)}`,
    },
  ];
  const tp = priceToRaw(position.tp);
  if (tp > 0n) levels.push({ key: key('tp'), kind: 'tp', price: tp, tag: 'TP' });
  const sl = priceToRaw(position.sl);
  if (sl > 0n) levels.push({ key: key('sl'), kind: 'sl', price: sl, tag: 'SL' });
  if (liq !== null && liq > 0n) levels.push({ key: key('liq'), kind: 'liq', price: liq, tag: 'Liq.' });
  return levels;
}

/** The levels the visible price range reaches, edges included; the rest have nowhere to go. */
export function levelsInView(levels: ReadonlyArray<PositionLevel>, min: bigint, max: bigint): PositionLevel[] {
  return levels.filter((l) => l.price >= min && l.price <= max);
}
