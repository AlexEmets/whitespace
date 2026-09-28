'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { MISSIONS, streakMultiplierBps } from '@whitespace/shared/points';
import { usePoints } from '@/hooks/usePoints';
import { usePositions } from '@/hooks/usePositions';
import { useMarkets } from '@/hooks/useMarkets';
import { formatMoney, toRawUnits } from '@/lib/money';
import { pendingTimePointsRaw, pendingLpPointsRaw } from '@/lib/livePoints';
import { marketLabel } from '@/components/portfolio/TradeHistoryTable';
import { AccountState, Dash, PageHead, accountStyles as shell } from '@/components/portfolio/AccountPage';
import styles from './points.module.css';

/**
 * /points — the season-one points dashboard.
 *
 * Confirmed totals (missions, realised time-in-market, streak, LP) come from the indexer via
 * GET /points/:address; the two live counters — time on positions still open, LP on liquidity
 * still pooled — are computed client-side from the same shared scoring rules and ticked once a
 * second, so the number climbs toward what the ledger will confirm without ever running ahead
 * of it. Every mission, cap and multiplier shown is the real rule from @whitespace/shared.
 */

const PD = 6; // points decimals
const TIME_DAILY_CAP = 100;
const LP_DAILY_CAP = 50;

const fmt = (raw: bigint, dp = 2) => formatMoney(raw, PD, { fractionDigits: dp });

function LiveNumber({ raw, dp }: { raw: bigint; dp: number }) {
  const s = fmt(raw, dp);
  const dot = s.indexOf('.');
  if (dot === -1) return <span>{s}</span>;
  return (
    <span>
      {s.slice(0, dot)}
      <span className={styles.frac}>{s.slice(dot)}</span>
    </span>
  );
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const Shield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
  </svg>
);
const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function tierFor(total: number): { name: string; next: string | null; floor: number; ceil: number } {
  if (total < 500) return { name: 'Explorer', next: 'Trader', floor: 0, ceil: 500 };
  if (total < 2000) return { name: 'Trader', next: 'Pro', floor: 500, ceil: 2000 };
  if (total < 10000) return { name: 'Pro', next: 'Elite', floor: 2000, ceil: 10000 };
  return { name: 'Elite', next: null, floor: 10000, ceil: 10000 };
}

const RING_CIRC = 2 * Math.PI * 34;

export function PointsPanel() {
  const { address, isConnected } = useAccount();
  const { points, loading, error } = usePoints(address);
  const { positions } = usePositions(address);
  const { markets } = useMarkets();

  // The live clock: one tick a second drives both accrual counters.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const head = (
    <PageHead
      eyebrow="Season one"
      title="Points"
      lede={
        <>
          Points accrue from four things: trying each part of the exchange, holding real positions, coming back day
          after day, and providing liquidity. Confirmed totals are read from your on-chain activity; the two live
          counters show what is still accruing right now.
        </>
      }
      meta={
        <>
          <div>
            <strong>RANK</strong> {points?.rank != null ? `#${points.rank}` : '—'}
          </div>
          <div>
            <strong>STREAK</strong> {points ? `${points.streakDays}d` : '—'}
          </div>
          <div>
            <strong>SOURCE</strong> /points/:you
          </div>
        </>
      }
    />
  );

  if (!isConnected || !address) {
    return (
      <div className={shell.page} data-testid="points-page">
        {head}
        <AccountState kind="disconnected" title="No wallet connected">
          Points are address-scoped. Connect a wallet to see what you have earned and what is still accruing.
          <Link href="/trade"> Start trading</Link> to open your first mission.
        </AccountState>
        <MissionCatalog completed={new Set()} />
      </div>
    );
  }

  if (loading && !points) {
    return (
      <div className={shell.page} data-testid="points-page">
        {head}
        <AccountState kind="loading" title="Reading your points">
          Fetching <code>GET /points/{address.slice(0, 6)}…</code>.
        </AccountState>
      </div>
    );
  }

  if (error && !points) {
    return (
      <div className={shell.page} data-testid="points-page">
        {head}
        <AccountState kind="error" title="Could not load your points" detail={error.message}>
          The read API did not answer, so your totals are unknown — not zero.
        </AccountState>
      </div>
    );
  }

  // Confirmed (from the indexer) + live (accruing now), all as raw 6-decimal bigints.
  const confirmed = {
    missions: toRawUnits(points?.missions ?? '0', PD),
    time: toRawUnits(points?.time ?? '0', PD),
    streak: toRawUnits(points?.streak ?? '0', PD),
    lp: toRawUnits(points?.lp ?? '0', PD),
    total: toRawUnits(points?.total ?? '0', PD),
  };
  const lpBalanceRaw = toRawUnits(points?.lpBalance ?? '0', PD);
  const pendingTime = pendingTimePointsRaw(positions, now);
  const pendingLp = pendingLpPointsRaw(lpBalanceRaw, points?.lpSince ?? null, now);

  const liveTime = confirmed.time + pendingTime;
  const liveLp = confirmed.lp + pendingLp;
  const liveTotal = confirmed.total + pendingTime + pendingLp;

  const completed = new Set(points?.completedMissions ?? []);
  const doneCount = MISSIONS.filter((m) => completed.has(m.id)).length;

  const streakDays = points?.streakDays ?? 0;
  const multBps = Number(streakMultiplierBps(Math.max(1, streakDays)));
  const mult = (multBps / 10000).toFixed(2);

  const totalHuman = Number(formatMoney(liveTotal, PD, { fractionDigits: 0, grouping: false }));
  const tier = tierFor(totalHuman);
  const tierPct =
    tier.ceil > tier.floor ? Math.min(100, ((totalHuman - tier.floor) / (tier.ceil - tier.floor)) * 100) : 100;

  const timeRatePerHour = pendingTimePointsRaw(positions, now + 3600) - pendingTime; // points/hr at current size
  const lpRatePerDay = pendingLpPointsRaw(lpBalanceRaw, 0, 86_400);

  const openPos = positions[0];

  return (
    <div className={shell.page} data-testid="points-page">
      {head}

      {/* Summary band */}
      <section className={styles.summary}>
        <div className={`${styles.sumTile} ${styles.total}`} data-testid="points-total">
          <span className={styles.sumLabel}>Total points</span>
          <div className={styles.sumValue}>
            <LiveNumber raw={liveTotal} dp={2} />
            <span className={styles.unit}>pts</span>
          </div>
          <span className={styles.sumSub}>
            confirmed {fmt(confirmed.total, 2)} · accruing{' '}
            <span className={styles.gain}>+{fmt(pendingTime + pendingLp, 4)}</span>
          </span>
        </div>

        <div className={styles.sumTile} data-testid="points-rank">
          <span className={styles.sumLabel}>Rank</span>
          <span className={`${styles.sumValue} ${styles.accentValue}`}>
            {points?.rank != null ? `#${points.rank}` : <Dash reason="you have not earned any points yet, so there is no leaderboard position" />}
          </span>
          <span className={styles.sumSub}>season one leaderboard</span>
        </div>

        <div className={styles.sumTile} data-testid="points-multiplier">
          <span className={styles.sumLabel}>Streak multiplier</span>
          <span className={`${styles.sumValue} ${styles.accentValue}`}>×{mult}</span>
          <span className={styles.sumSub}>grows to ×1.50 over 7 days</span>
        </div>

        <div className={styles.sumTile} data-testid="points-tier">
          <span className={styles.sumLabel}>Tier</span>
          <span className={styles.sumValue} style={{ fontSize: '1.35rem' }}>
            {tier.name}
          </span>
          <div className={styles.tierTrack}>
            <div className={styles.tierFill} style={{ width: `${tierPct}%` }} />
          </div>
          <div className={styles.tierRow}>
            <span>{tier.name}</span>
            <span>{tier.next ? `${tier.next} · ${tier.ceil} pts` : 'max tier'}</span>
          </div>
        </div>
      </section>

      {/* Cards */}
      <section className={styles.grid}>
        {/* 1. Missions */}
        <article className={styles.card} data-testid="card-missions">
          <div className={styles.cardHead}>
            <span className={styles.idx}>01</span>
            <div className={styles.titles}>
              <h2 className={styles.cardTitle}>Missions</h2>
              <div className={styles.what}>Try each part of the exchange — one-time</div>
            </div>
            <span className={styles.chip}>One-off</span>
          </div>

          <div className={styles.missionsTop}>
            <div className={styles.ring}>
              <svg width="84" height="84" viewBox="0 0 84 84">
                <circle className={styles.ringTrack} cx="42" cy="42" r="34" fill="none" strokeWidth="6" />
                <circle
                  className={styles.ringFill}
                  cx="42"
                  cy="42"
                  r="34"
                  fill="none"
                  strokeWidth="6"
                  strokeDasharray={RING_CIRC}
                  strokeDashoffset={RING_CIRC * (1 - doneCount / MISSIONS.length)}
                />
              </svg>
              <div className={styles.ringCenter}>
                <b data-testid="missions-progress">
                  {doneCount}/{MISSIONS.length}
                </b>
                <small>missions</small>
              </div>
            </div>
            <div className={styles.mLead}>
              <div className={styles.mPtsBig}>{fmt(confirmed.missions, 0)}</div>
              <div className={styles.mLbl}>points from missions</div>
            </div>
          </div>

          <ul className={styles.mlist}>
            {MISSIONS.map((m) => {
              const done = completed.has(m.id);
              return (
                <li key={m.id} className={`${styles.mItem}${done ? ` ${styles.mItemDone}` : ''}`}>
                  <span className={styles.mBox}>{done ? <Check /> : null}</span>
                  <span className={styles.mName}>{m.label}</span>
                  <span className={styles.mPts}>
                    {done ? '+' : ''}
                    {m.points}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className={styles.guard}>
            <Shield />
            <span>
              <b>Anti-farm:</b> each mission counts once per wallet.
            </span>
          </div>
        </article>

        {/* 2. Time in market */}
        <article className={styles.card} data-testid="card-time">
          <div className={styles.cardHead}>
            <span className={styles.idx}>02</span>
            <div className={styles.titles}>
              <h2 className={styles.cardTitle}>Time in market</h2>
              <div className={styles.what}>Hold real positions, not churned volume</div>
            </div>
            <span className={`${styles.chip} ${styles.chipLive}`}>
              <span className={styles.liveDot} />
              Live
            </span>
          </div>

          <div className={styles.seasonRow}>
            <span className={`${styles.seasonNum} ${styles.numLive}`} data-testid="time-live">
              <LiveNumber raw={liveTime} dp={5} />
            </span>
            <span className={styles.cap}>
              season · accruing <span className={styles.frac}>+{fmt(pendingTime, 5)}</span>
            </span>
          </div>

          {openPos ? (
            <div className={styles.posline}>
              <span className={`${styles.side} ${openPos.buy ? styles.sideLong : styles.sideShort}`} />
              <span className={styles.posSym}>{marketLabel(openPos.pairIndex, markets)}</span>
              <span className={styles.posMuted}>·</span>
              <span className={styles.posFig}>
                {formatMoney((toRawUnits(openPos.collateral, PD) * toRawUnits(openPos.leverage, 2)) / 100n, PD, {
                  fractionDigits: 0,
                })}
              </span>
              <span className={styles.posMuted}>notional</span>
              {positions.length > 1 ? <span className={styles.posMuted}>+{positions.length - 1} more</span> : null}
              <span className={styles.posClock}>{clock(now - openPos.openedAt)}</span>
            </div>
          ) : (
            <div className={styles.posline}>
              <span className={styles.posMuted}>
                No open position. <Link href="/trade">Open one</Link> and it starts accruing after 5 minutes.
              </span>
            </div>
          )}

          <div className={styles.formula}>
            earn = <b>notional × hours ÷ 10,000</b>
            {timeRatePerHour > 0n ? <> → +{fmt(timeRatePerHour, 3)} pts / hr</> : null}
          </div>

          <div className={`${styles.meter}${pendingTime >= toRawUnits(String(TIME_DAILY_CAP), PD) ? ` ${styles.meterFull}` : ''}`}>
            <div className={styles.meterRow}>
              <span>Daily cap</span>
              <span>
                <span className={styles.figNow}>{fmt(pendingTime < toRawUnits(String(TIME_DAILY_CAP), PD) ? pendingTime : toRawUnits(String(TIME_DAILY_CAP), PD), 2)}</span> / {TIME_DAILY_CAP}
              </span>
            </div>
            <div className={styles.meterTrack}>
              <div
                className={styles.meterFill}
                style={{ width: `${Math.min(100, (Number(fmt(pendingTime, 2)) / TIME_DAILY_CAP) * 100)}%` }}
              />
            </div>
          </div>

          <div className={styles.guard}>
            <Shield />
            <span>
              <b>Anti-farm:</b> under 5 minutes does not count · notional capped at 50k · max 100 points a day.
            </span>
          </div>
        </article>

        {/* 3. Day streak */}
        <article className={styles.card} data-testid="card-streak">
          <div className={styles.cardHead}>
            <span className={styles.idx}>03</span>
            <div className={styles.titles}>
              <h2 className={styles.cardTitle}>Day streak</h2>
              <div className={styles.what}>Come back every day with a real position</div>
            </div>
            <span className={styles.chip}>Daily</span>
          </div>

          <div className={styles.streakTop}>
            <div className={styles.flame}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2c1 3-1 4-2 6s0 4 0 4-2-1-2-3c-2 2-3 4-3 6a7 7 0 0014 0c0-4-3-6-4-9-1 2-2 2-3 1 1-2 2-4 0-5z" />
              </svg>
            </div>
            <div className={styles.sLead}>
              <div className={styles.sNum} data-testid="streak-days">
                <b>{streakDays}</b> day{streakDays === 1 ? '' : 's'} running
              </div>
              <div className={styles.sLbl}>longest {points?.streakLongest ?? 0}</div>
            </div>
            <div className={styles.mult}>
              <div className={styles.multVal}>×{mult}</div>
              <div className={styles.multLbl}>multiplier</div>
            </div>
          </div>

          <div className={styles.dots} aria-label="Seven-day streak">
            {Array.from({ length: 7 }, (_, i) => {
              const day = i + 1;
              const on = day <= streakDays;
              const today = day === streakDays;
              return (
                <div key={day} className={`${styles.dot}${on ? ` ${styles.dotOn}` : ''}${today ? ` ${styles.dotToday}` : ''}`}>
                  D{day}
                </div>
              );
            })}
          </div>

          <div className={styles.seasonRow}>
            <span className={styles.seasonNum}>{fmt(confirmed.streak, 0)}</span>
            <span className={styles.cap}>
              points from streaks · <span className={styles.frac}>×1.5</span> on day 7
            </span>
          </div>

          <div className={styles.guard}>
            <Shield />
            <span>
              <b>Anti-farm:</b> once a day, and only when a position lived past 10 minutes.
            </span>
          </div>
        </article>

        {/* 4. Pool (LP) */}
        <article className={styles.card} data-testid="card-lp">
          <div className={styles.cardHead}>
            <span className={styles.idx}>04</span>
            <div className={styles.titles}>
              <h2 className={styles.cardTitle}>
                Pool <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>(LP)</span>
              </h2>
              <div className={styles.what}>Provide liquidity to the USDW pool</div>
            </div>
            <span className={`${styles.chip} ${styles.chipLive}`}>
              <span className={styles.liveDot} />
              Live
            </span>
          </div>

          <div className={styles.seasonRow}>
            <span className={`${styles.seasonNum} ${styles.numLive}`} data-testid="lp-live">
              <LiveNumber raw={liveLp} dp={5} />
            </span>
            <span className={styles.cap}>
              season · accruing <span className={styles.frac}>+{fmt(pendingLp, 5)}</span>
            </span>
          </div>

          <div className={styles.posline}>
            <span className={styles.posMuted}>In pool</span>
            <span className={styles.posFig}>{formatMoney(lpBalanceRaw, PD, { fractionDigits: 0 })} USDW</span>
            <span className={styles.posMuted}>·</span>
            <span className={styles.posFig}>+{fmt(lpRatePerDay, 2)}</span>
            <span className={styles.posMuted}>pts / day</span>
          </div>

          <div className={styles.formula}>
            earn = <b>1 point per 1,000 USDW-days</b> in the pool
          </div>

          <div className={styles.meter}>
            <div className={styles.meterRow}>
              <span>Daily cap</span>
              <span>
                <span className={styles.figNow}>{fmt(pendingLp < toRawUnits(String(LP_DAILY_CAP), PD) ? pendingLp : toRawUnits(String(LP_DAILY_CAP), PD), 2)}</span> / {LP_DAILY_CAP}
              </span>
            </div>
            <div className={styles.meterTrack}>
              <div
                className={styles.meterFill}
                style={{ width: `${Math.min(100, (Number(fmt(pendingLp, 2)) / LP_DAILY_CAP) * 100)}%` }}
              />
            </div>
          </div>

          <div className={styles.guard}>
            <Shield />
            <span>
              <b>Anti-farm:</b> no more than 50 points a day — USDW is a free faucet token.
            </span>
          </div>
        </article>
      </section>

      <div className={styles.note} data-testid="points-note">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5h.01" />
        </svg>
        <span>
          <b>Testnet season.</b> Whitespace runs on Whitechain testnet 1874 with a free USDW faucet, so points measure
          activity, not capital at risk. Confirmed totals are derived from your on-chain history; the live counters are
          an estimate of what will be confirmed when your open positions close and your pooled liquidity next settles.
        </span>
      </div>
    </div>
  );
}

function MissionCatalog({ completed }: { completed: Set<string> }) {
  return (
    <section className={styles.grid} style={{ marginTop: 8 }}>
      <article className={styles.card} data-testid="card-missions">
        <div className={styles.cardHead}>
          <span className={styles.idx}>01</span>
          <div className={styles.titles}>
            <h2 className={styles.cardTitle}>Missions</h2>
            <div className={styles.what}>What you can earn once you connect</div>
          </div>
          <span className={styles.chip}>One-off</span>
        </div>
        <ul className={styles.mlist}>
          {MISSIONS.map((m) => (
            <li key={m.id} className={`${styles.mItem}${completed.has(m.id) ? ` ${styles.mItemDone}` : ''}`}>
              <span className={styles.mBox}>{completed.has(m.id) ? <Check /> : null}</span>
              <span className={styles.mName}>{m.label}</span>
              <span className={styles.mPts}>{m.points}</span>
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}
