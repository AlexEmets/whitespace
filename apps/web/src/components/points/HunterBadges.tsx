'use client';

import { useHunterNfts } from '@/hooks/useHunterNfts';
import styles from './points.module.css';

/**
 * The wallet's Hunter bug-bounty badges on /points — read live from the chain and rendered
 * from their own on-chain SVG. Hidden entirely until the collection is deployed; once it is,
 * it shows the grid of earned badges, or a short "none yet" line for a wallet that has none.
 */
export function HunterBadges({ address }: { address?: `0x${string}` }) {
  const { badges, deployed, loading } = useHunterNfts(address);

  if (!deployed) return null;

  return (
    <section className={styles.panel} data-testid="hunter-badges">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          Badges
          <span className={styles.panelCount} data-testid="hunter-count">
            {badges.length}
          </span>
        </h2>
      </div>

      {badges.length > 0 ? (
        <ul className={styles.badges}>
          {badges.map((b) => (
            <li key={b.tokenId.toString()} className={styles.badge} title={b.description ?? b.name}>
              {/* on-chain SVG data URI — a plain <img> renders it directly */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.badgeImg} src={b.image} alt={b.name} width={128} height={128} />
              <span className={styles.badgeName}>{b.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty} data-testid="hunter-empty">
          {loading ? 'Reading your badges…' : 'No badges yet — report a valid bug to earn one.'}
        </p>
      )}
    </section>
  );
}
