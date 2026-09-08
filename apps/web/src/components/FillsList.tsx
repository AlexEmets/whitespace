'use client';

import { useAccount } from 'wagmi';
import { usePositionHistory } from '@/hooks/usePositionHistory';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatLeverage, formatMoney } from '@/lib/money';

/** Closed positions ("Fills" tab), from GET /positions/:address/history. */
export function FillsList() {
  const { address } = useAccount();
  const { history, loading, error } = usePositionHistory(address);

  if (!address) return <p>Connect your wallet to see fills.</p>;
  if (loading) return <p>Loading fills…</p>;
  if (error) return <p className="error-text">Failed to load fills: {error.message}</p>;
  if (history.length === 0) return <p data-testid="no-fills">No closed positions yet.</p>;

  return (
    <table className="data-table" data-testid="fills-table">
      <thead>
        <tr>
          <th>Side</th>
          <th>Leverage</th>
          <th>Entry</th>
          <th>Close</th>
          <th>Realised PnL</th>
        </tr>
      </thead>
      <tbody>
        {history.map((p, i) => (
          <tr key={`${p.pairIndex}-${p.index}-${p.closedAt}-${i}`}>
            <td className={p.buy ? 'pos' : 'neg'}>{p.buy ? 'Long' : 'Short'}</td>
            <td>{formatLeverage(p.leverage)}</td>
            <td>{formatMoney(p.openPrice, PRICE_DECIMALS_NUM)}</td>
            <td>{formatMoney(p.closePrice, PRICE_DECIMALS_NUM)}</td>
            <td className={BigInt(p.realisedPnl) >= 0n ? 'pos' : 'neg'}>
              {formatMoney(p.realisedPnl, COLLATERAL_DECIMALS, { signDisplay: true })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
