'use client';

import { useState } from 'react';
import { statsImagePath, statsSharePath, statsShareText, type StatsCard } from '@/lib/statsCard';
import { ShareDialog, ShareIcon, currentTheme } from './ShareDialog';
import styles from './share.module.css';

/**
 * "Share" on the portfolio's performance card: the wallet's whole record as one card —
 * realised PnL, win rate, trades, volume, best trade — through the same dialog a trade
 * card uses, with a link whose preview on X and Telegram is the card itself.
 */
export function ShareStatsButton({ address, card }: { address: string; card: StatsCard }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={styles.labelled}
        aria-label="Share your trading stats"
        data-testid="share-stats"
        onClick={() => setOpen(true)}
      >
        <ShareIcon />
        Share
      </button>
      {open ? <StatsShareDialog address={address} card={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function StatsShareDialog({ address, card, onClose }: { address: string; card: StatsCard; onClose: () => void }) {
  // Read once, when the dialog opens: the card shared is the one the trader was shown.
  const [theme] = useState(currentTheme);
  return (
    <ShareDialog
      title="Share your stats"
      imagePath={statsImagePath(address, theme)}
      pagePath={statsSharePath(address, theme)}
      text={statsShareText(card)}
      fileName={`whitespace-stats-${address.slice(2, 8).toLowerCase()}.png`}
      onClose={onClose}
    />
  );
}
