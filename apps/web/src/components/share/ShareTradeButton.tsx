'use client';

import { useState } from 'react';
import { shareId, shareImagePath, sharePath, shareText, type ShareCard, type ShareRef } from '@/lib/shareCard';
import { ShareDialog, ShareIcon, currentTheme } from './ShareDialog';
import styles from './share.module.css';

/** The share icon on a position or trade row. Opens the share dialog for that trade. */
export function ShareTradeButton({
  address,
  shareRef,
  card,
  testId,
}: {
  address: string;
  shareRef: ShareRef;
  card: ShareCard;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label={`Share this ${card.market} trade`}
        title="Share"
        data-testid={testId}
        onClick={() => setOpen(true)}
      >
        <ShareIcon />
      </button>
      {open ? <TradeShareDialog address={address} shareRef={shareRef} card={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TradeShareDialog({
  address,
  shareRef,
  card,
  onClose,
}: {
  address: string;
  shareRef: ShareRef;
  card: ShareCard;
  onClose: () => void;
}) {
  // Read once, when the dialog opens: the card shared is the one the trader was shown.
  const [theme] = useState(currentTheme);
  return (
    <ShareDialog
      title="Share trade"
      imagePath={shareImagePath(address, shareRef, theme)}
      pagePath={sharePath(address, shareRef, theme)}
      text={shareText(card)}
      fileName={`whitespace-${card.market.toLowerCase()}-${shareId(shareRef)}.png`}
      onClose={onClose}
    />
  );
}
