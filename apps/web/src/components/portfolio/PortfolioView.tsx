'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { accountShares, cumulativeRealisedPnl, tradePerformance, winRate, type AccountPart } from '@/lib/portfolio';
import type { PositionSummary, PriceResponse } from '@/lib/types';
import { FundingButtons } from '@/components/FundingButtons';
import { AccountState, DefRow, Defs, Dash, Section, accountStyles } from './AccountPage';
import { OpenPositionsTable } from './OpenPositionsTable';
import { PnlSparkline } from './PnlSparkline';
import { TradeHistoryTable, marketLabel } from './TradeHistoryTable';
import { formatDuration, formatUtcMinute } from './formatTime';
import styles from './portfolio.module.css';

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

const TABS = ['positions', 'orders', 'history', 'vault'] as const;
type PortfolioTab = (typeof TABS)[number];

const TAB_LABELS: Record<PortfolioTab, string> = {
  positions: 'Positions',
  orders: 'Orders',
  history: 'History',
  vault: 'LP vault',
};

const PART_LABELS: Record<AccountPart, string> = {
  wallet: 'Wallet',
  margin: 'Margin in positions',
  unrealised: 'Unrealised PnL',
  lp: 'LP vault',
};

const PARTS = Object.keys(PART_LABELS) as AccountPart[];

const money = (raw: bigint, signed = false) => formatMoney(raw, COLLATERAL_DECIMALS, { signDisplay: signed });
const signClass = (raw: bigint) => (raw > 0n ? 'pos' : raw < 0n ? 'neg' : undefined);

/**
 * /portfolio: one account value and what it is made of, how the closed trades went, and a
 * single tabbed panel for the rows behind both. Every figure is shown once — the earlier
 * layout printed the balances as tiles, again as a funding list and a third time as a
 * reconciliation table.
 */
export function PortfolioView() {
  const { address, isConnected } = useAccount();
  const { markets } = useMarkets();
  const { positions, loading: positionsLoading, error: positionsError } = usePositions(address);
  const { stats, loading: historyLoading, error: historyError } = useTradeStats(address);
  const { orders } = useOrders(address);
  const balances = usePortfolioBalances();
  const [tab, setTab] = useState<PortfolioTab>('positions');
  const tabRefs = useRef<Partial<Record<PortfolioTab, HTMLButtonElement | null>>>({});

  const pairIndexes = useMemo(() => positions.map((p) => p.pairIndex), [positions]);
  const { prices, error: pricesError } = useMarkPrices(pairIndexes);

  const lockedRaw = lockedCollateralRaw(positions);
  const openNotional = openNotionalRaw(positions);
  const unrealisedRaw = totalUnrealisedPnl(positions, prices);
  const parts: Record<AccountPart, bigint | null> = {
    wallet: balances.walletRaw,
    margin: lockedRaw,
    unrealised: unrealisedRaw,
    lp: balances.vaultAssetsRaw,
  };
  const accountValueRaw = sumAccountValue(PARTS.map((part) => parts[part]));
  const shares = accountShares(parts);

  const performance = useMemo(() => tradePerformance(stats.trades), [stats.trades]);
  const pnlSeries = useMemo(() => cumulativeRealisedPnl(stats.trades), [stats.trades]);
  const rate = winRate(stats.wins, stats.losses);
  const historyPending = historyLoading && stats.closedCount === 0;

  const pendingOrders = orders.filter((o) => o.status === 'pending');
  const resolvedOrders = orders.filter((o) => o.status !== 'pending');

  const head = (
    <header className={styles.head}>
      <div>
        <div className={`${styles.eyebrow} mono-upper`}>Account</div>
        <h1 className={styles.title}>Portfolio</h1>
      </div>
      {isConnected && address ? (
        <div className={styles.headSide}>
          <span className={styles.addressChip} title={address} data-testid="portfolio-address">
            <strong>
              {address.slice(0, 6)}…{address.slice(-4)}
            </strong>{' '}
            · Whitechain 1874 · USDW
          </span>
          <Link href="/trade" className={styles.terminalLink}>
            Open terminal →
          </Link>
        </div>
      ) : null}
    </header>
  );

  if (!isConnected || !address) {
    return (
      <div className={accountStyles.page} data-testid="portfolio-page">
        {head}
        <Section title="Connect to continue">
          <AccountState kind="disconnected" title="No wallet connected">
            A portfolio is address-scoped: there is nothing to show until you connect. Use <strong>Connect</strong> in
            the header, then this page reads your balances directly from Whitechain testnet 1874 — no signature and no
            transaction required to look.
          </AccountState>
        </Section>
        <Section title="What this page reports" note="Stated up front so the numbers are checkable, connected or not.">
          <Defs>
            <DefRow label="Wallet (USDW)" value={<span className={accountStyles.subtle}>USDW.balanceOf(you)</span>} />
            <DefRow label="Margin in positions" value={<span className={accountStyles.subtle}>Σ collateral · GET /positions/:you</span>} />
            <DefRow label="Unrealised PnL" value={<span className={accountStyles.subtle}>estimate vs live mark</span>} />
            <DefRow label="LP vault position" value={<span className={accountStyles.subtle}>vault.convertToAssets(shares)</span>} />
            <DefRow label="Realised PnL" value={<span className={accountStyles.subtle}>Σ payout − collateral · every close</span>} />
          </Defs>
        </Section>
      </div>
    );
  }

  const failure = positionsError ?? historyError ?? balances.error ?? pricesError;

  const counts: Partial<Record<PortfolioTab, number>> = {
    positions: positions.length,
    orders: pendingOrders.length,
    history: stats.closedCount,
  };

  const tabNotes: Record<PortfolioTab, ReactNode> = {
    positions: 'Marks refresh every 5s. Close a position from the terminal.',
    orders: 'An order is a request: it fills, or refunds minus the oracle fee, once a keeper reports a price.',
    history:
      stats.firstClosedAt !== null && stats.lastClosedAt !== null
        ? `${formatUtcMinute(stats.firstClosedAt)} → ${formatUtcMinute(stats.lastClosedAt)}`
        : null,
    vault: 'Both directions are requests the vault settles on its own schedule.',
  };

  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? tab;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={accountStyles.page} data-testid="portfolio-page">
      {head}

      <div className={styles.overview}>
        <section className={styles.valueCard} data-testid="portfolio-value" aria-label="Account value">
          <div className={styles.valueHead}>
            <div>
              <div className={styles.label}>Account value</div>
              <div className={styles.bigValue} data-testid="account-value">
                {accountValueRaw === null ? (
                  <Dash reason="one of its four parts could not be read, and a partial sum is not a total" />
                ) : (
                  <>
                    {money(accountValueRaw)}
                    <span className={styles.unit}>USDW</span>
                  </>
                )}
              </div>
            </div>
            <p className={styles.valueCaption}>Wallet + margin + unrealised PnL + LP vault, each a live read.</p>
          </div>

          <CompositionBar shares={shares} />

          <div className={styles.legend}>
            <Part part="wallet" note="Free collateral">
              {parts.wallet === null ? <Dash reason="the USDW balanceOf call has not returned" /> : money(parts.wallet)}
            </Part>
            <Part part="margin" note={`${positions.length} open · ${money(openNotional)} notional`}>
              {money(lockedRaw)}
            </Part>
            <Part
              part="unrealised"
              note={
                <span title="Spread, price impact, funding and rollover apply at settlement and are not included.">
                  Estimate at the live mark
                </span>
              }
            >
              {unrealisedRaw === null ? (
                <Dash reason="at least one open market has no live price right now" />
              ) : (
                <span className={signClass(unrealisedRaw)}>{money(unrealisedRaw, true)}</span>
              )}
            </Part>
            <Part
              part="lp"
              note={
                <>
                  {balances.vaultSharesRaw === null ? 'Vault shares' : `${money(balances.vaultSharesRaw)} shares`}
                  {' · '}
                  <button type="button" className={styles.inlineAction} onClick={() => setTab('vault')} data-testid="part-lp-manage">
                    Deposit / withdraw
                  </button>
                </>
              }
            >
              {parts.lp === null ? <Dash reason="the vault share balance has not been read yet" /> : money(parts.lp)}
            </Part>
          </div>
        </section>

        <section className={styles.perfCard} data-testid="portfolio-performance" aria-label="Performance">
          <div className={styles.perfHead}>
            <span className={styles.label}>Performance</span>
            <span className={styles.faint}>all time</span>
          </div>
          <div className={styles.perfGrid}>
            <Stat
              testId="perf-realised"
              label="Realised PnL"
              note={`${stats.closedCount} ${stats.closedCount === 1 ? 'close' : 'closes'}`}
            >
              {historyPending ? (
                <Dash reason="the trade history has not loaded yet" />
              ) : stats.realisedPnlRaw === null ? (
                <Dash reason="a close was missing its payout figure, so the total would be incomplete" />
              ) : (
                <span className={signClass(stats.realisedPnlRaw)}>{money(stats.realisedPnlRaw, true)}</span>
              )}
            </Stat>
            <Stat testId="perf-winrate" label="Win rate" note={`${stats.wins} wins · ${stats.losses} losses`}>
              {rate === null ? <Dash reason="no close has realised a profit or a loss yet" /> : `${Math.round(rate * 100)}%`}
            </Stat>
            <Stat testId="perf-volume" label="Volume" note="USDW notional closed">
              {historyPending ? <Dash reason="the trade history has not loaded yet" /> : money(stats.closedNotionalRaw)}
            </Stat>
            <Stat
              testId="perf-hold"
              label="Avg. hold"
              note={
                performance.bestRaw !== null && performance.worstRaw !== null
                  ? `best ${money(performance.bestRaw, true)} · worst ${money(performance.worstRaw, true)}`
                  : null
              }
            >
              {performance.avgHoldSeconds === null ? (
                <Dash reason="no close has both an open and a close time" />
              ) : (
                formatDuration(performance.avgHoldSeconds)
              )}
            </Stat>
          </div>
          {pnlSeries && pnlSeries.length > 1 ? (
            <div className={styles.spark}>
              <PnlSparkline values={pnlSeries.map((v) => Number(v) / 10 ** COLLATERAL_DECIMALS)} />
            </div>
          ) : null}
        </section>
      </div>

      {failure ? (
        <div className={styles.failure}>
          <AccountState kind="error" title="Could not load this account" detail={failure.message}>
            One or more of the reads behind this page failed, so the figures above may be incomplete. They will refill
            on the next poll; nothing here is cached from an earlier session.
          </AccountState>
        </div>
      ) : null}

      <section className={styles.tabs} data-testid="portfolio-tabs">
        <div className={styles.tabBar}>
          <div role="tablist" aria-label="Account detail" className={styles.tabList}>
            {TABS.map((t) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                type="button"
                role="tab"
                id={`portfolio-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="portfolio-tabpanel"
                tabIndex={tab === t ? 0 : -1}
                className={styles.tab}
                onClick={() => setTab(t)}
                onKeyDown={onTabKey}
                data-testid={`portfolio-tab-${t}`}
              >
                {TAB_LABELS[t]}
                {counts[t] !== undefined ? <span className={styles.tabCount}>{counts[t]}</span> : null}
              </button>
            ))}
          </div>
          {tabNotes[tab] ? <span className={styles.tabNote}>{tabNotes[tab]}</span> : null}
        </div>

        <div role="tabpanel" id="portfolio-tabpanel" aria-labelledby={`portfolio-tab-${tab}`} className={styles.panel}>
          {tab === 'positions' ? (
            positionsLoading && positions.length === 0 ? (
              <AccountState kind="loading" title="Reading open positions">
                Fetching <code>GET /positions/{address.slice(0, 6)}…</code> and the live mark for each market.
              </AccountState>
            ) : positions.length === 0 ? (
              <AccountState kind="empty" title="No open positions">
                This address holds no open position on any market. <Link href="/trade">Open one from the terminal</Link> —
                the order is a request first: it fills, or it cancels and refunds, only once a keeper delivers a signed
                price report.
              </AccountState>
            ) : (
              <OpenPositionsTable positions={positions} markets={markets} prices={prices} />
            )
          ) : null}

          {tab === 'orders' ? (
            orders.length === 0 ? (
              <AccountState kind="empty" title="No orders in flight">
                Nothing is waiting on a keeper for this address.
              </AccountState>
            ) : (
              <div className={accountStyles.tableWrap}>
                <table className="data-table" data-testid="portfolio-orders-table">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Side</th>
                      <th className={accountStyles.num}>Collateral</th>
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
                        <td className={accountStyles.num}>
                          {/* GET /orders/:address cannot fill these for a still-pending OPEN
                              order — the indexer has no collateral until the fill event, and
                              the API sends null rather than fabricating it (phase-4 §6). */}
                          {order.collateral ? (
                            formatMoney(order.collateral, COLLATERAL_DECIMALS)
                          ) : (
                            <Dash reason="a pending open order has no on-chain collateral record until it fills" />
                          )}
                        </td>
                        <td className={accountStyles.rowTime}>{formatUtcMinute(order.requestedAt)}</td>
                        <td>
                          {order.status === 'pending'
                            ? 'Pending — waiting for keeper'
                            : order.status === 'executed'
                              ? 'Executed'
                              : 'Cancelled'}
                        </td>
                        <td className={accountStyles.subtle}>
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
            )
          ) : null}

          {tab === 'history' ? (
            historyPending ? (
              <AccountState kind="loading" title="Reading trade history">
                Fetching <code>GET /positions/{address.slice(0, 6)}…/history</code>.
              </AccountState>
            ) : historyError ? (
              <AccountState kind="error" title="Could not load trade history" detail={historyError.message}>
                The read API did not answer. Open positions are unaffected — they come from a different endpoint.
              </AccountState>
            ) : stats.closedCount === 0 ? (
              <AccountState kind="empty" title="No closed trades yet">
                Nothing has been closed on this address, so there is no realised PnL to report — the 0.00 above means
                zero trades have settled, not that the data is missing.
              </AccountState>
            ) : (
              <TradeHistoryTable trades={stats.trades} markets={markets} address={address} />
            )
          ) : null}

          {tab === 'vault' ? (
            <div className={styles.vault} data-testid="portfolio-funding">
              <Defs>
                <DefRow
                  testId="funding-free"
                  label="Free in wallet"
                  value={
                    balances.walletRaw === null ? (
                      <Dash reason="the USDW balanceOf call has not returned" />
                    ) : (
                      `${money(balances.walletRaw)} USDW`
                    )
                  }
                />
                <DefRow
                  testId="funding-vault"
                  label="In the LP vault"
                  value={
                    balances.vaultAssetsRaw === null ? (
                      <Dash reason="the vault share balance has not been read yet" />
                    ) : (
                      <>
                        {money(balances.vaultAssetsRaw)} USDW
                        {balances.vaultSharesRaw === null ? null : (
                          <span className={accountStyles.subtle}>
                            {' · '}
                            {money(balances.vaultSharesRaw)} shares
                            {balances.vaultTotalAssetsRaw !== null
                              ? ` of a ${formatMoney(balances.vaultTotalAssetsRaw, COLLATERAL_DECIMALS, { fractionDigits: 0 })} USDW vault`
                              : null}
                          </span>
                        )}
                      </>
                    )
                  }
                />
              </Defs>

              <div className={styles.vaultActions}>
                <FundingButtons idPrefix="portfolio" className={accountStyles.fundingActions} />
                {/* Which way each button moves money, said once. "Request deposit" was read as
                    "request USDW" and submitted from an empty wallet — naming the direction is
                    what stops that. The faucet is the other way entirely, and is its own page. */}
                <p className={accountStyles.fundingNote}>
                  <strong>Deposit</strong> sends USDW from your wallet into the LP vault and returns shares.{' '}
                  <strong>Withdraw</strong> redeems those shares back into USDW. Neither mints anything — for testnet
                  collateral use the <Link href="/faucet">faucet</Link>.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * The account value as one bar, split by part. A part too small to see at its true width
 * (98 USDW of margin beside a 19,884 USDW wallet) still gets a sliver, so the bar never
 * claims a part is empty when it is not.
 */
function CompositionBar({ shares }: { shares: Record<AccountPart, number> | null }) {
  const label = shares
    ? PARTS.map((part) => `${PART_LABELS[part]} ${(shares[part] * 100).toFixed(1)}%`).join(', ')
    : 'Split unavailable: a part of the account could not be read';
  return (
    <div className={styles.bar} role="img" aria-label={label} data-testid="account-bar">
      {shares
        ? PARTS.filter((part) => shares[part] > 0).map((part) => (
            <span key={part} className={styles.barSegment} data-part={part} style={{ flexGrow: shares[part] }} />
          ))
        : null}
    </div>
  );
}

function Part({ part, note, children }: { part: AccountPart; note: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.part} data-testid={`part-${part}`}>
      <span className={styles.partLabel}>
        <span className={styles.swatch} data-part={part} aria-hidden="true" />
        {PART_LABELS[part]}
      </span>
      <span className={styles.partValue}>{children}</span>
      <span className={styles.partNote}>{note}</span>
    </div>
  );
}

function Stat({ label, note, testId, children }: { label: string; note: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div className={styles.stat} data-testid={testId}>
      <span className={styles.label}>{label}</span>
      <span className={styles.statValue}>{children}</span>
      {note ? <span className={styles.partNote}>{note}</span> : null}
    </div>
  );
}
