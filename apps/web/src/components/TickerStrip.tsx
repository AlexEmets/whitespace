'use client';

import { useMarkets } from '@/hooks/useMarkets';
import { useMarket24h, formatWindowLabel } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { PRICE_DECIMALS_NUM } from '@/lib/config';
import { marketLabel } from '@/lib/markets';
import { formatMoney } from '@/lib/money';

function TickerItem({ pairIndex, from, to }: { pairIndex: number; from: string; to: string }) {
  const { data: price } = usePrice(pairIndex);
  const change = useMarket24h(pairIndex);

  return (
    <span className="ticker-item" data-testid={`ticker-${pairIndex}`}>
      {marketLabel({ from })}
      <strong>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</strong>
      {change ? (
        <span
          className={change.changeBps >= 0n ? 'pos' : 'neg'}
          title={change.truncated ? `Over ${formatWindowLabel(change.windowSeconds)} — this market is newer than 24h` : undefined}
        >
          {formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}%
        </span>
      ) : (
        <span className="dash">—</span>
      )}
    </span>
  );
}

/** Horizontal ticker strip on the landing page, from `/markets` — exactly as many items
 * as the API returns. Never padded to look fuller than it is. */
export function TickerStrip() {
  const { markets } = useMarkets();
  if (markets.length === 0) return null;

  return (
    <div className="ticker-strip" data-testid="ticker-strip">
      {markets.map((m) => (
        <TickerItem key={m.pairIndex} pairIndex={m.pairIndex} from={m.from} to={m.to} />
      ))}
    </div>
  );
}
