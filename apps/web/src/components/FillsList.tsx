'use client';

import { useAccount } from 'wagmi';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositionHistory } from '@/hooks/usePositionHistory';
import { toClosedTrade } from '@/hooks/useTradeStats';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { marketLabel } from '@/lib/markets';
import { formatLeverage, formatMoney } from '@/lib/money';

/**
 * Closed positions ("Trade history" tab), from GET /positions/:address/history.
 *
 * Rows go through `toClosedTrade`, the same normaliser /portfolio uses: the API sends the
 * PnL as `realizedPnl`, and reading the type's `realisedPnl` directly crashed the tab on
 * the first real close (`BigInt(undefined)`). A trade closed in parts is one row per part,
 * keyed by its close order.
 */
export function FillsList() {
  const { address } = useAccount();
  const { history, loading, error } = usePositionHistory(address);
  const { markets } = useMarkets();

  if (!address) return <p>Connect your wallet to see fills.</p>;
  if (loading) return <p>Loading fills…</p>;
  if (error) return <p className="error-text">Failed to load fills: {error.message}</p>;
  if (history.length === 0) return <p data-testid="no-fills">No closed positions yet.</p>;

  const trades = history.map(toClosedTrade);

  return (
    <table className="data-table" data-testid="fills-table">
      <thead>
        <tr>
          <th>Market</th>
          <th>Side</th>
          <th>Leverage</th>
          <th>Entry</th>
          <th>Close</th>
          <th>Realised PnL</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const market = markets.find((m) => m.pairIndex === t.pairIndex);
          return (
            <tr key={t.rowKey} data-testid={`fill-row-${t.rowKey}`}>
              <td>{market ? marketLabel(market) : `#${t.pairIndex}`}</td>
              <td className={t.buy ? 'pos' : 'neg'}>{t.buy ? 'Long' : 'Short'}</td>
              <td>{formatLeverage(t.leverage)}</td>
              <td>{formatMoney(t.openPrice, PRICE_DECIMALS_NUM)}</td>
              <td>{t.closePrice !== null ? formatMoney(t.closePrice, PRICE_DECIMALS_NUM) : <span className="dash">—</span>}</td>
              <td
                data-testid={`fill-pnl-${t.rowKey}`}
                className={t.realisedPnlRaw === null ? 'dash' : t.realisedPnlRaw >= 0n ? 'pos' : 'neg'}
              >
                {t.realisedPnlRaw === null ? '—' : formatMoney(t.realisedPnlRaw, COLLATERAL_DECIMALS, { signDisplay: true })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
