'use client';

import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatLeverage, formatMoney } from '@/lib/money';
import type { MarketSummary } from '@/lib/types';
import { explainCloseReason, type ClosedTrade } from '@/hooks/useTradeStats';
import { Dash, accountStyles as styles } from './AccountPage';
import { formatDuration, formatUtcMinute } from './formatTime';

/** Re-exported so the existing importers here keep working; the implementation moved to
 * lib/markets.ts when the `-PERP` convention from terminal_design.pdf was adopted. The
 * local import is separate because `export ... from` does not bind the name in this
 * module's own scope, and the table below uses it. */
import { marketLabelByIndex } from '@/lib/markets';

export { marketLabelByIndex as marketLabel } from '@/lib/markets';

/**
 * Closed positions, newest first, straight from `GET /positions/:address/history`.
 *
 * Realised PnL is the API's own `realizedPnl` (`usdc_sent_to_trader - collateral`,
 * services/api/src/routes/positions.ts:69), not a re-derivation from prices — the payout
 * is the only figure that includes every fee the contract actually charged. Where a row
 * arrives without it, the cell is a dash rather than a zero.
 *
 * Known gap, stated on the page rather than hidden: the indexer does not write a
 * `closed_position` row for a *partial* close (docs/decisions/phase-4-indexer-api.md §6),
 * so this table is complete for fully-closed trades only.
 */
export function TradeHistoryTable({ trades, markets }: { trades: ClosedTrade[]; markets: MarketSummary[] }) {
  const ordered = [...trades].sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));

  return (
    <div className={styles.tableWrap}>
      <table className="data-table" data-testid="trade-history-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th className={styles.num}>Collateral</th>
            <th className={styles.num}>Notional</th>
            <th className={styles.num}>Entry</th>
            <th className={styles.num}>Exit</th>
            <th className={styles.num}>Realised PnL</th>
            <th>Closed</th>
            <th>Held</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((trade) => {
            const pnl = trade.realisedPnlRaw;
            return (
              <tr key={trade.rowKey} data-testid={`history-row-${trade.rowKey}`}>
                <td>
                  {marketLabelByIndex(trade.pairIndex, markets)}{' '}
                  <span className={styles.subtle}>{formatLeverage(trade.leverage)}</span>
                </td>
                <td className={trade.buy ? 'pos' : 'neg'}>{trade.buy ? 'Long' : 'Short'}</td>
                <td className={styles.num}>{formatMoney(trade.collateral, COLLATERAL_DECIMALS)}</td>
                <td className={styles.num}>{formatMoney(trade.notionalRaw, COLLATERAL_DECIMALS)}</td>
                <td className={styles.num}>{formatMoney(trade.openPrice, PRICE_DECIMALS_NUM)}</td>
                <td className={styles.num}>
                  {trade.closePrice === null ? (
                    <Dash reason="the history record for this trade carried no close price" />
                  ) : (
                    formatMoney(trade.closePrice, PRICE_DECIMALS_NUM)
                  )}
                </td>
                <td className={`${styles.num} ${pnl === null ? '' : pnl >= 0n ? 'pos' : 'neg'}`} data-testid="history-pnl">
                  {pnl === null ? (
                    <Dash reason="this history record carried neither realizedPnl nor usdcSentToTrader" />
                  ) : (
                    formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })
                  )}
                </td>
                <td className={styles.rowTime}>
                  {trade.closedAt === null ? <Dash reason="no close timestamp on this record" /> : formatUtcMinute(trade.closedAt)}
                </td>
                <td className={styles.rowTime}>
                  {trade.closedAt === null ? (
                    <Dash reason="no close timestamp on this record" />
                  ) : (
                    formatDuration(trade.closedAt - trade.openedAt)
                  )}
                </td>
                <td className={styles.subtle}>
                  {trade.isPartial ? `Partial ${trade.percentageClosed ?? ''}% · ` : ''}
                  {explainCloseReason(trade.closeReason) ?? <Dash reason="no close reason on this record" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
