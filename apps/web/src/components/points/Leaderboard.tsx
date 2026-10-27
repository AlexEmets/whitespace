'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { formatMoney } from '@/lib/money';
import type { LeaderboardEntry } from '@/lib/types';
import styles from './points.module.css';

/**
 * The public season-one leaderboard: the top wallets as GET /points/leaderboard ranks them.
 * It loads with or without a wallet, so a visitor sees what they are playing for. The top ten
 * show by default and the rest unfold on demand; a connected wallet is marked where it stands,
 * and pinned under the ten when it ranks lower, so finding yourself never needs a scroll.
 */

const PD = 6; // points decimals
const TOP = 10;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const pts = (value: string, dp: number) => formatMoney(value, PD, { fractionDigits: dp });

function Row({ entry, me, testId }: { entry: LeaderboardEntry; me: boolean; testId: string }) {
  return (
    <tr className={me ? styles.lbMe : undefined} data-testid={testId} data-me={me ? 'true' : undefined}>
      <td className={styles.lbRank}>{entry.rank}</td>
      <td className={styles.lbWallet}>
        {short(entry.address)}
        {me ? <span className={styles.lbYou}>You</span> : null}
      </td>
      <td className={styles.lbPart} data-testid="lb-missions">
        {pts(entry.missions, 0)}
      </td>
      <td className={styles.lbPart} data-testid="lb-time">
        {pts(entry.time, 0)}
      </td>
      <td className={styles.lbPart} data-testid="lb-streak">
        {pts(entry.streak, 0)}
      </td>
      <td className={styles.lbPart} data-testid="lb-lp">
        {pts(entry.lp, 0)}
      </td>
      <td className={styles.lbTotal} data-testid="lb-total">
        {pts(entry.total, 2)}
      </td>
    </tr>
  );
}

export function Leaderboard({ me }: { me?: `0x${string}` }) {
  const { entries, loading, error } = useLeaderboard();
  const [expanded, setExpanded] = useState(false);
  const mine = me?.toLowerCase();
  const isMe = (entry: LeaderboardEntry) => mine !== undefined && entry.address.toLowerCase() === mine;

  let body;
  if (!entries) {
    // No board yet: a failed read is said as such, never shown as an empty season.
    body = (
      <p className={styles.empty}>
        {error && !loading
          ? 'Could not load the leaderboard. The read API did not answer; it retries on its own.'
          : 'Reading the leaderboard…'}
      </p>
    );
  } else if (entries.length === 0) {
    body = (
      <p className={styles.empty}>
        No points earned yet this season. <Link href="/trade">Make the first trade</Link> and take the top spot.
      </p>
    );
  } else {
    const shown = expanded ? entries : entries.slice(0, TOP);
    const pinned = expanded ? undefined : entries.slice(TOP).find(isMe);
    body = (
      <>
        <div className={styles.lbScroll}>
          <table className={styles.lb} aria-label="Season one leaderboard">
            <thead>
              <tr>
                <th className={styles.lbRank}>#</th>
                <th className={styles.lbWallet}>Wallet</th>
                <th className={styles.lbPart}>Missions</th>
                <th className={styles.lbPart}>Time</th>
                <th className={styles.lbPart}>Streak</th>
                <th className={styles.lbPart}>LP</th>
                <th className={styles.lbTotal}>Total</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <Row key={entry.address} entry={entry} me={isMe(entry)} testId="leaderboard-row" />
              ))}
            </tbody>
            {pinned ? (
              <tbody className={styles.lbPinned}>
                <Row entry={pinned} me testId="leaderboard-me" />
              </tbody>
            ) : null}
          </table>
        </div>
        {entries.length > TOP ? (
          <button type="button" className={styles.lbMore} onClick={() => setExpanded((open) => !open)}>
            {expanded ? `Show top ${TOP}` : `Show all ${entries.length}`}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <section className={styles.panel} data-testid="leaderboard">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Leaderboard</h2>
        <span className={styles.panelAside}>top 100 · season one</span>
      </div>
      {body}
    </section>
  );
}
