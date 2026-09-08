'use client';

import { useMarkets } from '@/hooks/useMarkets';
import { useMarket24h } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatMoney } from '@/lib/money';

function TickerItem({ pairIndex, from, to }: { pairIndex: number; from: string; to: string }) {
  const { data: price } = usePrice(pairIndex);
  const change = useMarket24h(pairIndex);

  return (
    <span className="ticker-item" data-testid={`ticker-${pairIndex}`}>
      {from}-{to}
      <strong>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</strong>
      {change ? (
        <span className={change.changeBps >= 0n ? 'pos' : 'neg'}>
          {formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}%
        </span>
      ) : (
        <span className="dash">—</span>
      )}
    </span>
  );
}

/** Horizontal ticker strip on the landing page, from `/markets` — exactly as many items
 * as the API returns (currently one: BTC/USD). Never padded to look fuller than it is. */
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
