'use client';

import Link from 'next/link';
import { notionalRaw } from '@/hooks/useTradeStats';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { formatLeverage, formatMoney } from '@/lib/money';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import type { MarketSummary, PositionSummary, PriceResponse } from '@/lib/types';
import { Dash, accountStyles as styles } from './AccountPage';
import { formatDuration, formatUtcMinute } from './formatTime';
import { marketLabel } from './TradeHistoryTable';

/**
 * Open positions across every market, valued at the live mark.
 *
 * Unrealised PnL comes from `estimateUnrealisedPnl` in src/lib/pnl.ts — the same estimate
 * the terminal shows, so the two screens can never quote a trader different numbers for
 * the same position. It is explicitly an estimate: spread, price impact, funding and
 * rollover all apply on settlement and are not reproduced client-side, which is why the
 * section carries that caveat rather than presenting the figure as a payout.
 *
 * No Close control here. Closing is a two-phase, wallet-signed action that belongs on the
 * terminal next to the price it executes against; a portfolio is a statement, not an order
 * ticket.
 */
export function OpenPositionsTable({
  positions,
  markets,
  prices,
}: {
  positions: PositionSummary[];
  markets: MarketSummary[];
  prices: Record<number, PriceResponse>;
}) {
  const ordered = [...positions].sort((a, b) => b.openedAt - a.openedAt);
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className={styles.tableWrap}>
      <table className="data-table" data-testid="open-positions-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th className={styles.num}>Size</th>
            <th className={styles.num}>Collateral</th>
            <th className={styles.num}>Notional</th>
            <th className={styles.num}>Entry</th>
            <th className={styles.num}>Mark</th>
            <th className={styles.num}>Unrealised PnL</th>
            <th className={styles.num}>Liq.</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((position) => {
            const price = prices[position.pairIndex];
            const pnl = price
              ? estimateUnrealisedPnl({
                  collateral: position.collateral,
                  leverage: position.leverage,
                  openPrice: position.openPrice,
                  markPrice: price.mark,
                  buy: position.buy,
                })
              : null;
            const sizeBase = estimatePositionSizeBase({
              collateral: position.collateral,
              leverage: position.leverage,
              openPrice: position.openPrice,
            });

            return (
              <tr
                key={`${position.pairIndex}-${position.index}`}
                data-testid={`portfolio-position-${position.pairIndex}-${position.index}`}
              >
                <td>
                  <Link href="/trade" style={{ textDecoration: 'none', color: 'inherit' }}>
                    {marketLabel(position.pairIndex, markets)}
                  </Link>{' '}
                  <span className={styles.subtle}>{formatLeverage(position.leverage)}</span>
                </td>
                <td className={position.buy ? 'pos' : 'neg'}>{position.buy ? 'Long' : 'Short'}</td>
                <td className={`${styles.num} ${position.buy ? 'pos' : 'neg'}`}>
                  {formatMoney(position.buy ? sizeBase : -sizeBase, PRICE_DECIMALS_NUM, {
                    fractionDigits: 4,
                    grouping: false,
                    signDisplay: true,
                  })}
                </td>
                <td className={styles.num}>{formatMoney(position.collateral, COLLATERAL_DECIMALS)}</td>
                <td className={styles.num}>
                  {formatMoney(notionalRaw(position.collateral, position.leverage), COLLATERAL_DECIMALS)}
                </td>
                <td className={styles.num}>{formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}</td>
                <td className={styles.num}>
                  {price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : <Dash reason="no live price for this market right now" />}
                </td>
                <td
                  className={`${styles.num} ${pnl === null ? '' : pnl >= 0n ? 'pos' : 'neg'}`}
                  data-testid="portfolio-position-pnl"
                >
                  {pnl === null ? (
                    <Dash reason="no live price for this market right now" />
                  ) : (
                    formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })
                  )}
                </td>
                {/* Same ruling as the terminal's Liq. column: the real trigger is a
                    tradeValue-vs-liqMarginValue test over on-chain funding and rollover
                    accumulators this app does not read, and the obvious view function
                    disagrees with it at the boundary. */}
                <td className={styles.num}>
                  <Dash reason="requires the on-chain funding/rollover state this app does not read — see Docs, Margin and liquidation" />
                </td>
                <td className={styles.rowTime}>
                  {formatUtcMinute(position.openedAt)}
                  <br />
                  <span className="dash">{formatDuration(now - position.openedAt)} ago</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
