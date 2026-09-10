'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useMarkPrices } from '@/hooks/useMarkPrices';
import { useMarkets } from '@/hooks/useMarkets';
import { useOrders } from '@/hooks/useOrders';
import { usePortfolioBalances } from '@/hooks/usePortfolioBalances';
import { usePositions } from '@/hooks/usePositions';
import { lockedCollateralRaw, openNotionalRaw, useTradeStats } from '@/hooks/useTradeStats';
import { explainCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { formatMoney } from '@/lib/money';
import { estimateUnrealisedPnl } from '@/lib/pnl';
import type { PositionSummary, PriceResponse } from '@/lib/types';
import {
  AccountState,
  DefRow,
  Defs,
  Dash,
  PageHead,
  Section,
  Tile,
  TileRow,
  TileUnit,
  accountStyles as styles,
} from './AccountPage';
import { OpenPositionsTable } from './OpenPositionsTable';
import { TradeHistoryTable, marketLabel } from './TradeHistoryTable';
import { formatUtcMinute } from './formatTime';

/**
 * Total unrealised PnL across every open position, or `null` if any one of them has no
 * live mark price.
 *
 * The `null` is the important part. A sum over the positions we happen to have a price for
 * is not "the account's unrealised PnL" — it is a different, smaller number wearing that
 * label, and on a leveraged account the difference is the whole point. So a single missing
 * price collapses the total to an honest dash instead of quietly under-reporting risk.
 */
export function totalUnrealisedPnl(
  positions: PositionSummary[],
  prices: Record<number, PriceResponse>,
): bigint | null {
  let total = 0n;
  for (const position of positions) {
    const price = prices[position.pairIndex];
    if (!price) return null;
    total += estimateUnrealisedPnl({
      collateral: position.collateral,
      leverage: position.leverage,
      openPrice: position.openPrice,
      markPrice: price.mark,
      buy: position.buy,
    });
  }
  return total;
}

/** Adds the four components of account value, propagating "unknown" rather than treating a
 * missing part as zero. */
export function sumAccountValue(parts: Array<bigint | null>): bigint | null {
  let total = 0n;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
  }
  return total;
}

export function PortfolioView() {
  const { address, isConnected } = useAccount();
  const { markets } = useMarkets();
  const { positions, loading: positionsLoading, error: positionsError } = usePositions(address);
  const { stats, loading: historyLoading, error: historyError } = useTradeStats(address);
  const { orders } = useOrders(address);
  const balances = usePortfolioBalances();

  const pairIndexes = useMemo(() => positions.map((p) => p.pairIndex), [positions]);
  const { prices, error: pricesError } = useMarkPrices(pairIndexes);

  const lockedRaw = lockedCollateralRaw(positions);
  const openNotional = openNotionalRaw(positions);
  const unrealisedRaw = totalUnrealisedPnl(positions, prices);
  const accountValueRaw = sumAccountValue([
    balances.walletRaw,
    lockedRaw,
    unrealisedRaw,
    balances.vaultAssetsRaw,
  ]);

  const pendingOrders = orders.filter((o) => o.status === 'pending');
  const resolvedOrders = orders.filter((o) => o.status !== 'pending');

  const head = (
    <PageHead
      eyebrow="Account"
      title="Portfolio"
      lede={
        <>
          Everything this address holds on Whitespace, in one place: USDW in the wallet, collateral locked in open
          positions, the LP vault position, and every trade already closed. Figures come from the read API and from
          direct contract reads — nothing on this page is estimated except where it says so.
        </>
      }
      meta={
        isConnected && address ? (
          <>
            <div>
              <strong>ADDRESS</strong> {address.slice(0, 6)}…{address.slice(-4)}
            </div>
            <div>
              <strong>COLLATERAL</strong> USDW · 6 dp
            </div>
            <div>
              <strong>NETWORK</strong> WHITECHAIN 1874
            </div>
          </>
        ) : null
      }
    />
  );

  if (!isConnected || !address) {
    return (
      <div className={styles.page} data-testid="portfolio-page">
        {head}
        <Section title="Connect to continue">
          <AccountState kind="disconnected" title="No wallet connected">
            A portfolio is address-scoped: there is nothing to show until you connect. Use <strong>Connect</strong> in
            the header, then this page reads your balances directly from Whitechain testnet 1874 — no signature and no
            transaction required to look.
          </AccountState>
        </Section>
        <Section
          title="What this page reports"
          note="Stated up front so the numbers are checkable, connected or not."
        >
          <Defs>
            <DefRow label="Wallet (USDW)" value={<span className={styles.subtle}>USDW.balanceOf(you)</span>} />
            <DefRow label="Margin in positions" value={<span className={styles.subtle}>Σ collateral · GET /positions/:you</span>} />
            <DefRow label="Unrealised PnL" value={<span className={styles.subtle}>estimate vs live mark</span>} />
            <DefRow label="LP vault position" value={<span className={styles.subtle}>vault.convertToAssets(shares)</span>} />
            <DefRow label="Realised PnL" value={<span className={styles.subtle}>Σ payout − collateral · closed trades</span>} />
          </Defs>
        </Section>
      </div>
    );
  }

  const loading = positionsLoading || historyLoading || balances.loading;
  const failure = positionsError ?? historyError ?? balances.error ?? pricesError;

  return (
    <div className={styles.page} data-testid="portfolio-page">
      {head}

      <TileRow>
        <Tile
          lead
          testId="tile-account-value"
          label="Account value"
          value={
            accountValueRaw === null ? (
              <Dash reason="one of the four components below could not be read, and a partial sum is not a total" />
            ) : (
              <>
                {formatMoney(accountValueRaw, COLLATERAL_DECIMALS)}
                <TileUnit>USDW</TileUnit>
              </>
            )
          }
          note="Wallet + margin in positions + unrealised PnL + LP vault."
        />
        <Tile
          testId="tile-wallet"
          label="Wallet"
          value={
            balances.walletRaw === null ? (
              <Dash reason="the USDW balanceOf call has not returned" />
            ) : (
              <>
                {formatMoney(balances.walletRaw, COLLATERAL_DECIMALS)}
                <TileUnit>USDW</TileUnit>
              </>
            )
          }
          note="Free collateral, not committed to anything."
        />
        <Tile
          testId="tile-margin"
          label="Margin in positions"
          value={
            <>
              {formatMoney(lockedRaw, COLLATERAL_DECIMALS)}
              <TileUnit>USDW</TileUnit>
            </>
          }
          note={
            <>
              {positions.length} open · {formatMoney(openNotional, COLLATERAL_DECIMALS)} USDW notional. Isolated margin:
              a loss is capped at the collateral in that one position.
            </>
          }
        />
        <Tile
          testId="tile-unrealised"
          label="Unrealised PnL"
          value={
            unrealisedRaw === null ? (
              <Dash reason="at least one open market has no live price right now" />
            ) : (
              <span className={unrealisedRaw >= 0n ? 'pos' : 'neg'}>
                {formatMoney(unrealisedRaw, COLLATERAL_DECIMALS, { signDisplay: true })}
                <TileUnit>USDW</TileUnit>
              </span>
            )
          }
          note="Estimate at the live mark. Spread, price impact, funding and rollover apply at settlement and are not included."
        />
        <Tile
          testId="tile-realised"
          label="Realised PnL"
          value={
            stats.realisedPnlRaw === null ? (
              <Dash reason="a closed-trade record was missing its payout figure, so the total would be incomplete" />
            ) : (
              <span className={stats.realisedPnlRaw >= 0n ? 'pos' : 'neg'}>
                {formatMoney(stats.realisedPnlRaw, COLLATERAL_DECIMALS, { signDisplay: true })}
                <TileUnit>USDW</TileUnit>
              </span>
            )
          }
          note={`Across ${stats.closedCount} fully-closed ${stats.closedCount === 1 ? 'trade' : 'trades'}. Payout minus collateral, so every fee the contract charged is already in it.`}
        />
        <Tile
          testId="tile-lp"
          label="LP vault"
          value={
            balances.vaultAssetsRaw === null ? (
              <Dash reason="the vault share balance has not been read yet" />
            ) : (
              <>
                {formatMoney(balances.vaultAssetsRaw, COLLATERAL_DECIMALS)}
                <TileUnit>USDW</TileUnit>
              </>
            )
          }
          note={
            balances.vaultSharesRaw === null ? (
              'Shares valued through vault.convertToAssets().'
            ) : (
              <>
                {formatMoney(balances.vaultSharesRaw, COLLATERAL_DECIMALS)} shares
                {balances.vaultTotalAssetsRaw !== null ? (
                  <> of a {formatMoney(balances.vaultTotalAssetsRaw, COLLATERAL_DECIMALS, { fractionDigits: 0 })} USDW vault</>
                ) : null}
                . <Link href="/vaults" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Manage</Link>
              </>
            )
          }
        />
      </TileRow>

      {failure ? (
        <Section title="Account value">
          <AccountState kind="error" title="Could not load this account" detail={failure.message}>
            One or more of the reads behind this page failed, so the figures above may be incomplete. They will refill
            on the next poll; nothing here is cached from an earlier session.
          </AccountState>
        </Section>
      ) : (
        <Section
          title="Account value"
          aside="Each row is one read. The total is only shown when all four resolved."
        >
          <Defs>
            <DefRow
              testId="def-wallet"
              label="Wallet (USDW)"
              value={
                balances.walletRaw === null ? (
                  <Dash reason="balanceOf has not returned" />
                ) : (
                  formatMoney(balances.walletRaw, COLLATERAL_DECIMALS)
                )
              }
            />
            <DefRow testId="def-margin" label="Margin in open positions" value={formatMoney(lockedRaw, COLLATERAL_DECIMALS)} />
            <DefRow
              testId="def-unrealised"
              label="Unrealised PnL (estimate)"
              value={
                unrealisedRaw === null ? (
                  <Dash reason="a live mark price is missing" />
                ) : (
                  <span className={unrealisedRaw >= 0n ? 'pos' : 'neg'}>
                    {formatMoney(unrealisedRaw, COLLATERAL_DECIMALS, { signDisplay: true })}
                  </span>
                )
              }
            />
            <DefRow
              testId="def-lp"
              label="LP vault position"
              value={
                balances.vaultAssetsRaw === null ? (
                  <Dash reason="the vault share balance has not been read" />
                ) : (
                  formatMoney(balances.vaultAssetsRaw, COLLATERAL_DECIMALS)
                )
              }
            />
            <DefRow
              total
              testId="def-total"
              label="Account value"
              value={
                accountValueRaw === null ? (
                  <Dash reason="a component above is unavailable" />
                ) : (
                  `${formatMoney(accountValueRaw, COLLATERAL_DECIMALS)} USDW`
                )
              }
            />
          </Defs>
        </Section>
      )}

      <Section
        title={`Open positions · ${positions.length}`}
        aside="Marks refresh every 5s from GET /price/:pairIndex. Close a position from the terminal."
      >
        {loading && positions.length === 0 ? (
          <AccountState kind="loading" title="Reading open positions">
            Fetching <code>GET /positions/{address.slice(0, 6)}…</code> and the live mark for each market.
          </AccountState>
        ) : positions.length === 0 ? (
          <AccountState kind="empty" title="No open positions">
            This address holds no open position on any market. <Link href="/trade">Open one from the terminal</Link> —
            remember the order is a request first: it fills, or it cancels and refunds, only once a keeper delivers a
            signed price report.
          </AccountState>
        ) : (
          <OpenPositionsTable positions={positions} markets={markets} prices={prices} />
        )}
      </Section>

      {pendingOrders.length > 0 || resolvedOrders.length > 0 ? (
        <Section
          title={`Orders in flight · ${pendingOrders.length}`}
          aside="An order is a request. It becomes a position — or a refund minus the oracle fee — only when a keeper delivers a signed price report."
        >
          <div className={styles.tableWrap}>
            <table className="data-table" data-testid="portfolio-orders-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className={styles.num}>Collateral</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {[...pendingOrders, ...resolvedOrders].map((order) => (
                  <tr key={order.orderId} data-testid={`portfolio-order-${order.orderId}`}>
                    <td>{marketLabel(order.pairIndex, markets)}</td>
                    <td className={order.buy ? 'pos' : 'neg'}>{order.buy ? 'Long' : 'Short'}</td>
                    <td className={styles.num}>
                      {/* GET /orders/:address cannot fill these for a still-pending OPEN
                          order — the indexer has no collateral until the fill event, and
                          the API sends null rather than fabricating it (phase-4 §6). */}
                      {order.collateral ? (
                        formatMoney(order.collateral, COLLATERAL_DECIMALS)
                      ) : (
                        <Dash reason="a pending open order has no on-chain collateral record until it fills" />
                      )}
                    </td>
                    <td className={styles.rowTime}>{formatUtcMinute(order.requestedAt)}</td>
                    <td>{order.status === 'pending' ? 'Pending — waiting for keeper' : order.status === 'executed' ? 'Executed' : 'Cancelled'}</td>
                    <td className={styles.subtle}>
                      {order.status === 'cancelled' ? (
                        <span className="error-text">{explainCancelReason(order.cancelReason ?? '')}</span>
                      ) : order.status === 'executed' ? (
                        'Position opened.'
                      ) : (
                        'No price report has arrived yet.'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section
        title={`Trade history · ${stats.closedCount}`}
        aside={
          stats.firstClosedAt !== null && stats.lastClosedAt !== null ? (
            <>
              {formatUtcMinute(stats.firstClosedAt)} → {formatUtcMinute(stats.lastClosedAt)} ·{' '}
              {stats.wins}W / {stats.losses}L · {formatMoney(stats.closedNotionalRaw, COLLATERAL_DECIMALS)} USDW traded
            </>
          ) : null
        }
        foot="Fully-closed positions only. The indexer does not write a history row for a partial close (docs/decisions/phase-4-indexer-api.md §6), so a partially-closed position stays in the open table until the remainder is closed."
      >
        {historyLoading && stats.closedCount === 0 ? (
          <AccountState kind="loading" title="Reading trade history">
            Fetching <code>GET /positions/{address.slice(0, 6)}…/history</code>.
          </AccountState>
        ) : historyError ? (
          <AccountState kind="error" title="Could not load trade history" detail={historyError.message}>
            The read API did not answer. Open positions above are unaffected — they come from a different endpoint.
          </AccountState>
        ) : stats.closedCount === 0 ? (
          <AccountState kind="empty" title="No closed trades yet">
            Nothing has been closed on this address, so there is no realised PnL to report. The realised figure above
            is 0.00 USDW because zero trades have settled — not because the data is missing.
          </AccountState>
        ) : (
          <TradeHistoryTable trades={stats.trades} markets={markets} />
        )}
      </Section>
    </div>
  );
}
