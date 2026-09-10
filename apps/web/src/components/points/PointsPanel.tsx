'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositions } from '@/hooks/usePositions';
import { groupByMarket, openNotionalRaw, useTradeStats } from '@/hooks/useTradeStats';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { formatMoney } from '@/lib/money';
import {
  AccountState,
  Dash,
  PageHead,
  Section,
  Tile,
  TileRow,
  TileUnit,
  accountStyles as shell,
} from '@/components/portfolio/AccountPage';
import { marketLabel } from '@/components/portfolio/TradeHistoryTable';
import { formatUtcDate } from '@/components/portfolio/formatTime';
import styles from './points.module.css';

/**
 * /points.
 *
 * The mockup for this screen shows a 128,904 total, "Rank 214", an epoch countdown and a
 * "referral 25% of taker fees" line. None of those exist: there is no points service, no
 * epoch schedule, no leaderboard, and the referral programme was cut from scope (see the
 * comment on the landing page). Inventing any of the four would be the single most
 * damaging thing this page could do, because a points balance reads as a claim on a future
 * token and a trader would act on it.
 *
 * So the page is built around the part that IS real and independently checkable: what this
 * address has actually traded, derived from its own closed-position history, plus the live
 * on-chain fee schedule. The absence of points is stated once, prominently, in the shape
 * the mockup reserved for the total — not buried in a footnote and not dressed up as
 * "coming soon".
 */
export function PointsPanel() {
  const { address, isConnected } = useAccount();
  const { markets } = useMarkets();
  const { stats, loading, error } = useTradeStats(address);
  const { positions } = usePositions(address);
  // Fees are a property of the market, not of the wallet, so this reads with or without a
  // connection — the schedule below is populated even in the disconnected state.
  const firstMarket = markets[0];
  const fees = useMarketFees(firstMarket?.pairIndex ?? null);

  const byMarket = groupByMarket(stats.trades);
  const openNotional = openNotionalRaw(positions);

  return (
    <div className={shell.page} data-testid="points-page">
      <PageHead
        eyebrow="Season one"
        title="Points"
        lede={
          <>
            No points have been issued. This page shows the activity a points programme would be computed from — your
            own traded volume, drawn from your closed-position history — so that when issuance does start, you can
            already see the inputs and check them yourself.
          </>
        }
        meta={
          <>
            <div>
              <strong>PROGRAMME</strong> NOT LIVE
            </div>
            <div>
              <strong>EPOCH</strong> —
            </div>
            <div>
              <strong>SOURCE</strong> /positions/:you/history
            </div>
          </>
        }
      />

      {/* The mockup's three POINTS figures, kept in place and answered honestly. */}
      <TileRow>
        <Tile
          testId="points-balance"
          label="Points balance"
          value={<span className={styles.voidValue}>Not issued</span>}
          note="No points service exists in this system. There is nothing to accrue into, so this is not a zero balance — it is the absence of a balance."
        />
        <Tile
          testId="points-rank"
          label="Rank"
          value={<Dash reason="ranking requires a points total for every address; no such total exists" />}
          note="A leaderboard needs a scored population. Without issuance there is no score and no population."
        />
        <Tile
          testId="points-epoch"
          label="Epoch"
          value={<Dash reason="no epoch schedule has been published or committed to" />}
          note="No epoch length, start date or emission figure has been decided, so no countdown can be honest."
        />
        <Tile
          testId="points-referral"
          label="Referral share"
          value={<Dash reason="the referral programme was cut from scope; there is no policy and no data behind it" />}
          note="Cut from scope. The landing mockup's 25% figure describes a programme that was never built."
        />
      </TileRow>

      <Section title="Why this page has no numbers in it">
        <div className={styles.notice} data-testid="points-notice">
          <div className={`${styles.noticeEyebrow} mono-upper`}>Read this before assuming anything</div>
          <h3 className={styles.noticeHead}>Points issuance is not live, and nothing on this page is an allocation.</h3>
          <p className={styles.noticeBody}>
            Whitespace runs on Whitechain testnet 1874 with a faucet collateral token. There is no points contract, no
            emission schedule, no snapshot, and no commitment — explicit or implied — that trading today will be
            rewarded later.
          </p>
          <ul className={styles.noticeList}>
            <li>
              <strong>No total, no rank, no epoch.</strong> The four tiles above would each need a service that does
              not exist. They show what they show rather than a plausible-looking number.
            </li>
            <li>
              <strong>The volume figures below are yours, not a score.</strong> They are a straight sum over your own
              closed positions from the read API. They are not weighted, not multiplied, and not points.
            </li>
            <li>
              <strong>Nothing here is a promised allocation.</strong> If a programme is ever announced, its rules will
              be published before it starts — and they may not use any of these figures.
            </li>
            <li>
              <strong>Testnet collateral has no value.</strong> USDW is minted from an uncapped faucet, so volume
              denominated in it is a measure of activity, never of capital at risk.
            </li>
          </ul>
        </div>
      </Section>

      <Section
        title="Your activity"
        aside="Every figure here is derived from GET /positions/:address/history and GET /positions/:address — the same data the portfolio reports."
      >
        {!isConnected || !address ? (
          <AccountState kind="disconnected" title="No wallet connected">
            Activity is address-scoped. Connect a wallet to see your own traded volume and realised PnL — the notice
            above applies either way, and the fee schedule below is live regardless.
          </AccountState>
        ) : loading && stats.closedCount === 0 ? (
          <AccountState kind="loading" title="Reading your history">
            Fetching <code>GET /positions/{address.slice(0, 6)}…/history</code>.
          </AccountState>
        ) : error ? (
          <AccountState kind="error" title="Could not load your history" detail={error.message}>
            The read API did not answer, so no activity figures can be shown. They are not zero — they are unknown.
          </AccountState>
        ) : stats.closedCount === 0 ? (
          <AccountState kind="empty" title="No closed trades on this address">
            Traded volume is computed from fully-closed positions, and this address has none yet.{' '}
            <Link href="/trade">Open a position</Link>; once it closes it will appear here and in your portfolio.
            {openNotional > 0n ? (
              <>
                {' '}
                You currently have {formatMoney(openNotional, COLLATERAL_DECIMALS)} USDW of notional open — it counts
                once it is closed, not before.
              </>
            ) : null}
          </AccountState>
        ) : (
          <>
            <TileRow>
              <Tile
                testId="activity-volume"
                label="Traded volume"
                value={
                  <>
                    {formatMoney(stats.closedNotionalRaw, COLLATERAL_DECIMALS, { fractionDigits: 2 })}
                    <TileUnit>USDW</TileUnit>
                  </>
                }
                note="Sum of collateral × leverage at open, across closed trades. Opening notional, not entry-plus-exit turnover."
              />
              <Tile
                testId="activity-open-notional"
                label="Notional at risk"
                value={
                  <>
                    {formatMoney(openNotional, COLLATERAL_DECIMALS)}
                    <TileUnit>USDW</TileUnit>
                  </>
                }
                note={`${positions.length} position${positions.length === 1 ? '' : 's'} still open. Not counted in traded volume until closed.`}
              />
              <Tile
                testId="activity-trades"
                label="Closed trades"
                value={String(stats.closedCount)}
                note={`${stats.wins}W / ${stats.losses}L across ${stats.marketsTraded} market${stats.marketsTraded === 1 ? '' : 's'}.`}
              />
              <Tile
                testId="activity-realised"
                label="Realised PnL"
                value={
                  stats.realisedPnlRaw === null ? (
                    <Dash reason="a closed-trade record was missing its payout figure" />
                  ) : (
                    <span className={stats.realisedPnlRaw >= 0n ? 'pos' : 'neg'}>
                      {formatMoney(stats.realisedPnlRaw, COLLATERAL_DECIMALS, { signDisplay: true })}
                      <TileUnit>USDW</TileUnit>
                    </span>
                  )
                }
                note="Payout minus collateral, summed. Net of every fee the contract actually charged."
              />
              <Tile
                testId="activity-fees-paid"
                label="Fees you have paid"
                value={<Dash reason="no per-trade fee field exists on any read endpoint, and partial closes are not recorded at all" />}
                note="Deliberately not estimated. The history endpoint carries no fee breakdown, and reconstructing one from the current schedule would be a guess about the past."
              />
              <Tile
                testId="activity-window"
                label="Active since"
                value={stats.firstClosedAt === null ? <Dash reason="no closed trade carried a timestamp" /> : formatUtcDate(stats.firstClosedAt)}
                note={stats.lastClosedAt === null ? undefined : `Last close ${formatUtcDate(stats.lastClosedAt)}.`}
              />
            </TileRow>

            <div className={shell.tableWrap} style={{ marginTop: '1.5rem' }}>
              <table className="data-table" data-testid="points-market-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className={shell.num}>Closed trades</th>
                    <th className={shell.num}>Traded volume</th>
                    <th className={shell.num}>Realised PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {byMarket.map((row) => (
                    <tr key={row.pairIndex} data-testid={`points-market-${row.pairIndex}`}>
                      <td>{marketLabel(row.pairIndex, markets)}</td>
                      <td className={shell.num}>{row.closedCount}</td>
                      <td className={shell.num}>{formatMoney(row.notionalRaw, COLLATERAL_DECIMALS)}</td>
                      <td className={`${shell.num} ${row.realisedPnlRaw === null ? '' : row.realisedPnlRaw >= 0n ? 'pos' : 'neg'}`}>
                        {row.realisedPnlRaw === null ? (
                          <Dash reason="a trade in this market was missing its payout figure" />
                        ) : (
                          formatMoney(row.realisedPnlRaw, COLLATERAL_DECIMALS, { signDisplay: true })
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      <Section
        title="Live fee schedule"
        aside="Read from the contracts on every load, not from a document. These are rates charged today, not a per-user total."
        foot="Whether fees are ever the basis of a points programme has not been decided. They are shown because they are the one fee fact that is verifiable right now."
      >
        <div className={styles.feeGrid}>
          <div className={styles.feeCell}>
            <div className={`${styles.feeLabel} mono-upper`}>Oracle fee · per order</div>
            <div className={styles.feeValue} data-testid="fee-oracle">
              {fees.oracleFeeRaw === null ? (
                <Dash reason="pairOracleFee has not been read yet" />
              ) : (
                `${formatMoney(fees.oracleFeeRaw, COLLATERAL_DECIMALS)} USDW`
              )}
            </div>
            <div className={styles.feeNote}>
              Flat, charged per price request. Kept when an order is cancelled — that is the &ldquo;minus the oracle
              fee&rdquo; in every refund message. Source: <code>IOstiumPairsStorage.pairOracleFee</code>.
            </div>
          </div>
          <div className={styles.feeCell}>
            <div className={`${styles.feeLabel} mono-upper`}>Opening fee · maker</div>
            <div className={styles.feeValue} data-testid="fee-maker">
              {fees.makerFeeRaw === null ? (
                <Dash reason="pairOpeningFees has not been read yet" />
              ) : (
                `${formatMoney(fees.makerFeeRaw, 6, { grouping: false })}%`
              )}
            </div>
            <div className={styles.feeNote}>
              Source: <code>IOstiumPairInfos.pairOpeningFees</code>, PRECISION_6.
            </div>
          </div>
          <div className={styles.feeCell}>
            <div className={`${styles.feeLabel} mono-upper`}>Opening fee · taker</div>
            <div className={styles.feeValue} data-testid="fee-taker">
              {fees.takerFeeRaw === null ? (
                <Dash reason="pairOpeningFees has not been read yet" />
              ) : (
                `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%`
              )}
            </div>
            <div className={styles.feeNote}>
              The landing mockup&rsquo;s 0.035% is not this number. This one is whatever the market is configured with
              right now.
            </div>
          </div>
          <div className={styles.feeCell}>
            <div className={`${styles.feeLabel} mono-upper`}>Funding rate</div>
            <div className={styles.feeValue} data-testid="fee-funding">
              <Dash reason="no read endpoint exposes a funding rate; the accrual exists on-chain but is not surfaced" />
            </div>
            <div className={styles.feeNote}>
              Funding and rollover do accrue on an open position (<code>OstiumPairInfos</code>) and are deducted at
              settlement, but no endpoint publishes the rate, so none is shown.
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
