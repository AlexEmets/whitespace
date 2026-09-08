'use client';

import { useMarkets } from '@/hooks/useMarkets';
import { useMarket24h } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatMoney } from '@/lib/money';

function RailRow({
  pairIndex,
  from,
  to,
  active,
  onSelect,
}: {
  pairIndex: number;
  from: string;
  to: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { data: price } = usePrice(pairIndex);
  const change = useMarket24h(pairIndex);

  return (
    <button type="button" className={`rail-row${active ? ' active' : ''}`} onClick={onSelect} data-testid={`rail-row-${pairIndex}`}>
      <span className="symbol">
        {from}-{to}
      </span>
      <span className="price-line">
        <span>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</span>
        <span className={change && change.changeBps >= 0n ? 'pos' : change ? 'neg' : 'dash'}>
          {change ? `${formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}%` : '—'}
        </span>
      </span>
    </button>
  );
}

/** Left markets rail. Rendered directly from `/markets` — as many rows as the API
 * returns (currently one, BTC/USD), never padded toward a fuller-looking list. */
export function MarketsRail({ pairIndex, onSelect }: { pairIndex: number | null; onSelect: (pairIndex: number) => void }) {
  const { markets, loading } = useMarkets();

  return (
    <div className="terminal-rail" data-testid="markets-rail">
      <div className="rail-header mono-upper">Markets {markets.length}</div>
      {loading ? <p style={{ padding: '0.6rem 0.9rem', color: 'var(--fg-muted)' }}>Loading…</p> : null}
      {markets.map((m) => (
        <RailRow key={m.pairIndex} pairIndex={m.pairIndex} from={m.from} to={m.to} active={m.pairIndex === pairIndex} onSelect={() => onSelect(m.pairIndex)} />
      ))}
    </div>
  );
}
