'use client';

import Link from 'next/link';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarket24h } from '@/hooks/useMarket24h';
import { usePrice } from '@/hooks/usePrice';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatMoney, parseRawUnits } from '@/lib/money';

function MarketRow({ pairIndex, from, to, openInterest }: { pairIndex: number; from: string; to: string; openInterest: { long: string; short: string } }) {
  const { data: price } = usePrice(pairIndex);
  const change = useMarket24h(pairIndex);
  // openInterest.{long,short} are collateral-denominated (6 decimals) per
  // IOstiumTradingStorage — same assumption as elsewhere in this app; see
  // docs/decisions/phase-5-frontend.md for the note that this is not spelled out by D3.
  const oiTotal = parseRawUnits(openInterest.long) + parseRawUnits(openInterest.short);

  return (
    <tr data-testid={`markets-table-row-${pairIndex}`}>
      <td>
        <Link href="/trade">
          {from}-{to}
        </Link>
      </td>
      <td>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : <span className="dash">—</span>}</td>
      <td className={change && change.changeBps >= 0n ? 'pos' : change ? 'neg' : 'dash'}>
        {change ? `${formatMoney(change.changeBps, 2, { grouping: false, signDisplay: true })}%` : '—'}
      </td>
      {/* No funding-rate endpoint in the read API (D3) — honest dash, not fabricated. */}
      <td className="dash">—</td>
      <td>{formatMoney(oiTotal, COLLATERAL_DECIMALS)}</td>
    </tr>
  );
}

/** Full markets table (landing page). Rendered directly from `/markets` — as many rows
 * as the API returns, never padded toward the mockup's "38 markets". */
export function MarketsTable() {
  const { markets, loading, error } = useMarkets();

  return (
    <div className="landing-section" data-testid="markets-table-section">
      <h2>
        Markets <span className="badge">{markets.length}</span>
      </h2>
      {loading ? <p>Loading…</p> : null}
      {error ? <p className="error-text">Failed to load markets: {error.message}</p> : null}
      {!loading && !error ? (
        <table className="markets-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Mark</th>
              <th>24h</th>
              <th>Funding</th>
              <th>Open interest</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <MarketRow key={m.pairIndex} pairIndex={m.pairIndex} from={m.from} to={m.to} openInterest={m.openInterest} />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
