'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { MISSIONS, streakMultiplierBps } from '@whitespace/shared/points';
import { usePoints } from '@/hooks/usePoints';
import { usePositions } from '@/hooks/usePositions';
import { useMarkets } from '@/hooks/useMarkets';
import { formatMoney, toRawUnits } from '@/lib/money';
import { MIN_HELD_SECONDS } from '@whitespace/shared/points';
import {
  liveDecimals,
  pendingLpPointsRaw,
  pendingTimePointsRaw,
  ratePerSecond,
  timePointsPerDayRaw,
  timeWarmup,
} from '@/lib/livePoints';
import { marketLabel } from '@/components/portfolio/TradeHistoryTable';
import { AccountState, Dash, accountStyles as shell } from '@/components/portfolio/AccountPage';
import { LiveNumber } from './LiveNumber';
import { HunterBadges } from './HunterBadges';
import styles from './points.module.css';

/**
 * /points — the season-one points dashboard.
 *
 * Confirmed totals (missions, realised time-in-market, streak, LP) come from the indexer via
 * GET /points/:address; the two live counters — time on positions still open, LP on liquidity
 * still pooled — are computed client-side from the same shared scoring rules and ticked once a
 * second, so the number climbs toward what the ledger will confirm without ever running ahead
 * of it. Every mission, cap and multiplier shown is the real rule from @whitespace/shared.
 *
 * Laid out as a scoreboard: the total and what it unlocks first, then the four ways to earn
 * as one row each — the rule in a sentence, today's progress against its cap, the points —
 * then the missions as a grid, and every anti-farm rule once, in a single line at the foot.
 */

const PD = 6; // points decimals
const TIME_DAILY_CAP = 100;
const LP_DAILY_CAP = 50;
const STREAK_PEAK_DAY = 7;
const MAX_MISSION_POINTS = MISSIONS.reduce((sum, m) => sum + m.points, 0);

const fmt = (raw: bigint, dp = 2) => formatMoney(raw, PD, { fractionDigits: dp });
const capRaw = (cap: number) => toRawUnits(String(cap), PD);
/** A counter that is moving keeps a visible sliver: 6 pts an hour against a 100-a-day cap
 * filled 0.1% of the bar a minute and read as an empty bar. */
const LIVE_MIN_PCT = 2;
const livePct = (raw: bigint, cap: number, moving: boolean) => {
  const pct = Math.min(100, (Number(raw) / Number(capRaw(cap))) * 100);
  return moving ? Math.max(LIVE_MIN_PCT, pct) : pct;
};
const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function tierFor(total: number): { name: string; next: string | null; floor: number; ceil: number } {
  if (total < 500) return { name: 'Explorer', next: 'Trader', floor: 0, ceil: 500 };
  if (total < 2000) return { name: 'Trader', next: 'Pro', floor: 500, ceil: 2000 };
  if (total < 10000) return { name: 'Pro', next: 'Elite', floor: 2000, ceil: 10000 };
  return { name: 'Elite', next: null, floor: 10000, ceil: 10000 };
}

function Head() {
  return (
    <header className={styles.head}>
      <div className={`${styles.eyebrow} mono-upper`}>Season one</div>
      <h1 className={styles.title}>Points</h1>
      <p className={styles.sub}>
        Four ways to earn. Confirmed totals come from your on-chain activity; the live ones tick every second.
      </p>
    </header>
  );
}

function Rules() {
  return (
    <p className={styles.rules} data-testid="points-note">
      <span className={styles.rulesLabel}>Rules</span>
      Positions under 5 min don&rsquo;t count · notional capped at 50k · up to {TIME_DAILY_CAP} pts a day from time
      in market and {LP_DAILY_CAP} from the pool · a streak day needs a position held 10+ min · each mission counts
      once per wallet · testnet points measure activity, not capital at risk.
    </p>
  );
}

function MissionsGrid({ completed, points }: { completed: Set<string>; points: ReactNode }) {
  const done = MISSIONS.filter((m) => completed.has(m.id)).length;
  return (
    <section className={styles.panel} data-testid="card-missions">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          Missions
          <span className={styles.panelCount} data-testid="missions-progress">
            {done}/{MISSIONS.length}
          </span>
        </h2>
        <span className={styles.panelAside}>{points}</span>
      </div>
      <ul className={styles.missions}>
        {MISSIONS.map((m) => {
          const isDone = completed.has(m.id);
          return (
            <li key={m.id} className={isDone ? styles.missionDone : styles.mission}>
              <span className={styles.missionMark}>{isDone ? <Check /> : null}</span>
              <span className={styles.missionName}>{m.label}</span>
              <span className={styles.missionPts}>
                {isDone ? '+' : ''}
                {m.points}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EarnRow({
  idx,
  name,
  live,
  rule,
  status,
  pct,
  value,
  testId,
}: {
  idx: string;
  name: string;
  live?: boolean;
  rule: ReactNode;
  status: ReactNode;
  pct: number;
  value: ReactNode;
  testId: string;
}) {
  return (
    <div className={styles.earn} data-testid={testId}>
      <span className={styles.earnIdx}>{idx}</span>
      <div className={styles.earnMain}>
        <span className={styles.earnName}>
          {name}
          {live ? <span className={styles.live}>live</span> : null}
        </span>
        <span className={styles.earnRule}>{rule}</span>
      </div>
      <div className={styles.earnMeter}>
        <span className={styles.earnStatus}>{status}</span>
        <div className={styles.track}>
          <div className={live ? styles.fillLive : styles.fill} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className={styles.earnValue}>{value}</span>
    </div>
  );
}

export function PointsPanel() {
  const { address, isConnected } = useAccount();
  const { points, loading, error } = usePoints(address);
  const { positions } = usePositions(address);
  const { markets } = useMarkets();

  // The live clock: one tick on each whole second drives the accrual counters, and each
  // LiveNumber glides through the second in between. Aligned to the second, not an interval
  // from mount, so the glide spans the whole second rather than whatever part of it was left.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(Math.floor(Date.now() / 1000));
        schedule();
      }, 1000 - (Date.now() % 1000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  if (!isConnected || !address) {
    return (
      <div className={shell.page} data-testid="points-page">
        <Head />
        <AccountState kind="disconnected" title="No wallet connected">
          Points are address-scoped. Connect a wallet to see what you have earned and what is still accruing.
          <Link href="/trade"> Start trading</Link> to open your first mission.
        </AccountState>
        <MissionsGrid completed={new Set()} points={`up to ${MAX_MISSION_POINTS} pts`} />
        <Rules />
      </div>
    );
  }

  if (loading && !points) {
    return (
      <div className={shell.page} data-testid="points-page">
        <Head />
        <AccountState kind="loading" title="Reading your points">
          Fetching <code>GET /points/{address.slice(0, 6)}…</code>.
        </AccountState>
      </div>
    );
  }

  if (error && !points) {
    return (
      <div className={shell.page} data-testid="points-page">
        <Head />
        <AccountState kind="error" title="Could not load your points" detail={error.message}>
          The read API did not answer, so your totals are unknown — not zero.
        </AccountState>
        {/* Badges are read straight from chain, not from the points API, so they still show
            when the API is down. */}
        <HunterBadges address={address} />
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

  // A second ago, where each counter glides from; and how fast each moves, which sets how
  // many decimals it needs to be seen moving.
  const prevTime = pendingTimePointsRaw(positions, now - 1);
  const prevLp = pendingLpPointsRaw(lpBalanceRaw, points?.lpSince ?? null, now - 1);
  const timeRate = ratePerSecond(timePointsPerDayRaw(positions, now));
  const warmup = timeWarmup(positions, now);
  const lpRate = ratePerSecond(pendingLpPointsRaw(lpBalanceRaw, 0, 86_400));
  const startMs = now * 1000;

  const completed = new Set(points?.completedMissions ?? []);
  const doneCount = MISSIONS.filter((m) => completed.has(m.id)).length;

  const streakDays = points?.streakDays ?? 0;
  const multBps = Number(streakMultiplierBps(Math.max(1, streakDays)));
  const mult = (multBps / 10000).toFixed(2);

  const totalHuman = Number(formatMoney(liveTotal, PD, { fractionDigits: 0, grouping: false }));
  const tier = tierFor(totalHuman);
  const tierPct =
    tier.ceil > tier.floor ? Math.min(100, ((totalHuman - tier.floor) / (tier.ceil - tier.floor)) * 100) : 100;

  // Points an hour once every open position is past the floor.
  const timeRatePerHour = timePointsPerDayRaw(positions, now + MIN_HELD_SECONDS) / 24n;
  const lpRatePerDay = pendingLpPointsRaw(lpBalanceRaw, 0, 86_400);
  const timeCapped = pendingTime < capRaw(TIME_DAILY_CAP) ? pendingTime : capRaw(TIME_DAILY_CAP);
  const lpCapped = pendingLp < capRaw(LP_DAILY_CAP) ? pendingLp : capRaw(LP_DAILY_CAP);

  const openPos = positions[0];

  return (
    <div className={shell.page} data-testid="points-page">
      <Head />

      <section className={styles.hero}>
        <div className={styles.heroMain}>
          <span className={styles.label}>Your points</span>
          <div data-testid="points-total">
            <div className={styles.total}>
              <LiveNumber
                from={confirmed.total + prevTime + prevLp}
                to={liveTotal}
                startMs={startMs}
                dp={liveDecimals(timeRate + lpRate, 2)}
                fracClassName={styles.frac}
              />
            </div>
            <span className={styles.totalSub}>
              <span className={styles.fig}>{fmt(confirmed.total, 2)}</span> confirmed ·{' '}
              <span className={styles.gain}>+{fmt(pendingTime + pendingLp, 2)}</span> accruing now
            </span>
          </div>
          <div className={styles.tier} data-testid="points-tier">
            <div className={styles.tierRow}>
              <span>{tier.name}</span>
              <span className={styles.muted}>
                {tier.next ? (
                  <>
                    {Math.max(0, tier.ceil - totalHuman).toLocaleString('en-US')} pts to <b>{tier.next}</b>
                  </>
                ) : (
                  'top tier'
                )}
              </span>
            </div>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${tierPct}%` }} />
            </div>
          </div>
        </div>

        <div className={styles.heroStats}>
          <div className={styles.stat} data-testid="points-rank">
            <span className={styles.label}>Rank</span>
            <span className={styles.statValue}>
              {points?.rank != null ? (
                `#${points.rank}`
              ) : (
                <Dash reason="you have not earned any points yet, so there is no leaderboard position" />
              )}
            </span>
            <span className={styles.statSub}>season one</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.label}>Streak</span>
            <span className={styles.statValue} data-testid="streak-days">
              {streakDays} {streakDays === 1 ? 'day' : 'days'}
            </span>
            <span className={styles.statSub} data-testid="points-multiplier">
              ×{mult} · ×1.50 on day {STREAK_PEAK_DAY}
            </span>
          </div>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Ways to earn</h2>
          <span className={styles.panelAside}>season total</span>
        </div>

        <EarnRow
          idx="01"
          name="Missions"
          testId="earn-missions"
          rule="Try each part of the exchange, once"
          status={`${doneCount} of ${MISSIONS.length} done · up to ${MAX_MISSION_POINTS}`}
          pct={(doneCount / MISSIONS.length) * 100}
          value={fmt(confirmed.missions, 0)}
        />
        <EarnRow
          idx="02"
          name="Time in market"
          live
          testId="card-time"
          rule={
            openPos ? (
              <>
                Hold real positions — +{fmt(timeRatePerHour, 3)} pts / hr on {marketLabel(openPos.pairIndex, markets)}
                {positions.length > 1 ? ` and ${positions.length - 1} more` : ''} now
              </>
            ) : (
              <>
                Hold real positions. <Link href="/trade">Open one</Link> — it counts after 5 minutes.
              </>
            )
          }
          status={
            warmup && pendingTime === 0n
              ? `Starts counting in ${mmss(warmup.secondsLeft)} · then +${fmt(timeRatePerHour, 2)} / hr`
              : warmup
                ? `Accruing ${fmt(pendingTime, 2)} · ${warmup.waiting} more counts in ${mmss(warmup.secondsLeft)} · max ${TIME_DAILY_CAP} / day`
                : `Accruing ${fmt(pendingTime, 2)} · max ${TIME_DAILY_CAP} / day`
          }
          // Under the floor the bar is the wait itself, so a new position shows progress at once.
          pct={warmup && pendingTime === 0n ? warmup.progress * 100 : livePct(timeCapped, TIME_DAILY_CAP, timeRate > 0)}
          value={
            <span data-testid="time-live">
              <LiveNumber
                from={confirmed.time + prevTime}
                to={liveTime}
                startMs={startMs}
                dp={liveDecimals(timeRate, 3)}
                fracClassName={styles.frac}
              />
            </span>
          }
        />
        <EarnRow
          idx="03"
          name="Day streak"
          testId="card-streak"
          rule="Come back daily with a position held 10+ min"
          status={`Day ${Math.min(streakDays, STREAK_PEAK_DAY)} of ${STREAK_PEAK_DAY} · ×${mult}`}
          pct={(Math.min(streakDays, STREAK_PEAK_DAY) / STREAK_PEAK_DAY) * 100}
          value={fmt(confirmed.streak, 0)}
        />
        <EarnRow
          idx="04"
          name="Liquidity"
          live
          testId="card-lp"
          rule={
            lpBalanceRaw > 0n ? (
              <>
                1 pt per 1,000 USDW-days · {formatMoney(lpBalanceRaw, PD, { fractionDigits: 0 })} USDW in the pool, +
                {fmt(lpRatePerDay, 2)} / day
              </>
            ) : (
              <>
                1 pt per 1,000 USDW-days in the pool. <Link href="/vaults">Deposit</Link> to start.
              </>
            )
          }
          status={`Accruing ${fmt(pendingLp, 2)} · max ${LP_DAILY_CAP} / day`}
          pct={livePct(lpCapped, LP_DAILY_CAP, lpRate > 0)}
          value={
            <span data-testid="lp-live">
              <LiveNumber
                from={confirmed.lp + prevLp}
                to={liveLp}
                startMs={startMs}
                dp={liveDecimals(lpRate, 3)}
                fracClassName={styles.frac}
              />
            </span>
          }
        />
      </section>

      <MissionsGrid completed={completed} points={`${fmt(confirmed.missions, 0)} of ${MAX_MISSION_POINTS} pts`} />

      <HunterBadges address={address} />

      <Rules />
    </div>
  );
}
