'use client';

import { useFundingRate } from '@/hooks/useFundingRate';
import { useMarket24h, formatWindowLabel } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { marketLabel } from '@/lib/markets';
import { collateralToRaw, formatMoney, leverageToRaw } from '@/lib/money';
import type { MarketSummary } from '@/lib/types';

/**
 * Centre header: market name, the real per-market max leverage (design-honesty ruling:
 * "Isolated · <maxLeverage> max", not the mockup's "Cross · 50x max" — Ostium positions
 * are isolated, not cross), mark/index price, and the stat cells. FUNDING is the pair's
 * live per-block rate read from OstiumPairInfos, expressed per hour. 24H VOLUME is derived
 * from real candle data (useMarket24h), not fabricated.
 */
export function MarketHeaderBar({ market }: { market: MarketSummary | undefined }) {
  const { data: price } = usePrice(market?.pairIndex ?? null);
  const change = useMarket24h(market?.pairIndex ?? null);
  const funding = useFundingRate(market?.pairIndex ?? null);

  if (!market) return <div className="market-header panel">Select a market</div>;

  const maxLeverageX = Math.round(Number(leverageToRaw(market.maxLeverage)) / 100);
  const oiTotal = collateralToRaw(market.openInterest.long) + collateralToRaw(market.openInterest.short);

  return (
    <div className="market-header panel" data-testid="market-header">
      <div className="name-block">
        <span className="symbol">{marketLabel(market)}</span>
        <span className="chip" data-testid="isolated-chip">
          Isolated · {maxLeverageX}× max
        </span>
      </div>
      <div className="price-block">
        {/* `mark-price` is the one place the terminal prints the mark — the chart's own
            readout was a duplicate. tests/e2e/trade-flow.spec.ts asserts on it. */}
        <span className="last-price" data-testid="mark-price">
          {price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}
        </span>
        {/* The caption is the window the figure actually covers, not a fixed "24h": a
            market listed this morning has hours of history, and labelling its change as a
            day's would be a number and a period that never met. */}
        {change ? (
          <span className={`price-change ${change.changeBps >= 0n ? 'pos' : 'neg'}`}>
            {formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}% · {formatWindowLabel(change.windowSeconds)}
          </span>
        ) : (
          <span className="price-change dash">— · 24h</span>
        )}
      </div>
      <span className="spacer" />
      <div className="stat-cell">
        Index
        <span className="stat-value" data-testid="index-price">
          {price ? formatMoney(price.index, PRICE_DECIMALS_NUM) : '—'}
        </span>
      </div>
      <div className="stat-cell stat-tertiary">
        Funding · 1h
        <span
          className={`stat-value${funding === null ? ' dash' : ''}`}
          data-testid="funding-rate"
          title="Positive: longs pay shorts. Charged continuously every block."
        >
          {funding === null ? '—' : `${formatMoney(funding, 18, { fractionDigits: 4, grouping: false, signDisplay: true })}%`}
        </span>
      </div>
      <div className="stat-cell stat-secondary">
        Open interest
        <span className="stat-value">{formatMoney(oiTotal, COLLATERAL_DECIMALS)}</span>
      </div>
      <div className="stat-cell stat-secondary">
        24h volume
        <span className="stat-value">{change ? formatMoney(change.volume, COLLATERAL_DECIMALS) : '—'}</span>
      </div>
    </div>
  );
}
