'use client';

import { useMarket24h } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { collateralToRaw, formatMoney, leverageToRaw } from '@/lib/money';
import type { MarketSummary } from '@/lib/types';

/**
 * Centre header: market name, the real per-market max leverage (design-honesty ruling:
 * "Isolated · <maxLeverage> max", not the mockup's "Cross · 50x max" — Ostium positions
 * are isolated, not cross), last/index price, and four stat cells. FUNDING has no
 * backing endpoint in the read API and is shown as an honest dash rather than invented.
 * 24H VOLUME is derived from real candle data (useMarket24h), not fabricated.
 */
export function MarketHeaderBar({ market }: { market: MarketSummary | undefined }) {
  const { data: price } = usePrice(market?.pairIndex ?? null);
  const change = useMarket24h(market?.pairIndex ?? null);

  if (!market) return <div className="market-header">Select a market</div>;

  const maxLeverageX = Math.round(Number(leverageToRaw(market.maxLeverage)) / 100);
  const oiTotal = collateralToRaw(market.openInterest.long) + collateralToRaw(market.openInterest.short);

  return (
    <div className="market-header" data-testid="market-header">
      <div className="name-block">
        <span className="symbol">
          {market.from}-{market.to}
        </span>
        <div className="chip" data-testid="isolated-chip">
          ISOLATED · {maxLeverageX}× MAX
        </div>
      </div>
      <div>
        {/* `mark-price` lives here since the chart's duplicate readout was removed — the
            reference prints the price once. tests/e2e/trade-flow.spec.ts asserts on it. */}
        <div className="last-price" data-testid="mark-price">
          {price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}
        </div>
        {change ? (
          <div className={change.changeBps >= 0n ? 'pos' : 'neg'}>
            {formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}% · 24h
          </div>
        ) : (
          <div className="dash">— · 24h</div>
        )}
      </div>
      <div className="stat-cell mono-upper">
        Index
        <span className="stat-value" data-testid="index-price">
          {price ? formatMoney(price.index, PRICE_DECIMALS_NUM) : '—'}
        </span>
      </div>
      <div className="stat-cell mono-upper">
        Funding · 1h
        <span className="stat-value dash" title="No funding-rate endpoint in the read API">
          —
        </span>
      </div>
      <div className="stat-cell mono-upper">
        Open interest
        <span className="stat-value">{formatMoney(oiTotal, COLLATERAL_DECIMALS)}</span>
      </div>
      <div className="stat-cell mono-upper">
        24h volume
        <span className="stat-value">{change ? formatMoney(change.volume, COLLATERAL_DECIMALS) : '—'}</span>
      </div>
    </div>
  );
}
