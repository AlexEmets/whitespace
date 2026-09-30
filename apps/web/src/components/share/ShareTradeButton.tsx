'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  shareId,
  shareImagePath,
  sharePath,
  shareText,
  xIntentUrl,
  type ShareCard,
  type ShareRef,
} from '@/lib/shareCard';
import { DEFAULT_THEME, isTheme, type Theme } from '@/lib/theme';
import styles from './share.module.css';

function currentTheme(): Theme {
  const t = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme');
  return isTheme(t) ? t : DEFAULT_THEME;
}

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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 8l5-5 5 5" />
          <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
        </svg>
      </button>
      {open ? <ShareDialog address={address} shareRef={shareRef} card={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The share dialog: the card as X and Telegram will show it, and the ways out — post to X
 * (the link carries the card as its preview; X cannot attach an image from a link),
 * download the PNG, copy the link, or hand the image to the phone's share sheet.
 */
function ShareDialog({
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
  const [theme] = useState(currentTheme);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canShareFiles, setCanShareFiles] = useState(false);

  const imagePath = shareImagePath(address, shareRef, theme);
  const pageUrl = `${window.location.origin}${sharePath(address, shareRef, theme)}`;
  const text = shareText(card);
  const fileName = `whitespace-${card.market.toLowerCase()}-${shareId(shareRef)}.png`;

  useEffect(() => {
    setCanShareFiles(typeof navigator.share === 'function' && typeof navigator.canShare === 'function');
  }, []);

  async function loadImage(): Promise<Blob> {
    const res = await fetch(imagePath);
    if (!res.ok) throw new Error(`card image ${res.status}`);
    return res.blob();
  }

  async function download() {
    setError(null);
    try {
      const url = URL.createObjectURL(await loadImage());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setError('Could not load the card image. Try again in a moment.');
    }
  }

  async function copyLink() {
    setError(null);
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('Copying is blocked here — select the link and copy it by hand.');
    }
  }

  async function shareNative() {
    setError(null);
    try {
      const file = new File([await loadImage()], fileName, { type: 'image/png' });
      const withFile = { files: [file], text, url: pageUrl };
      await navigator.share(navigator.canShare(withFile) ? withFile : { text, url: pageUrl });
    } catch (err) {
      // Dismissing the share sheet is not an error.
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError('Sharing did not go through.');
    }
  }

  return (
    <Modal open onClose={onClose} title="Share trade" testId="share-dialog" size="large">
      <div className={styles.body}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.preview} src={imagePath} alt={text} width={1200} height={630} data-testid="share-preview" />
        <div className={styles.actions}>
          <a
            className={styles.primary}
            href={xIntentUrl(text, pageUrl)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="share-x"
          >
            Post on X
          </a>
          <button type="button" className={styles.secondary} onClick={download} data-testid="share-download">
            Download PNG
          </button>
          <button type="button" className={styles.secondary} onClick={copyLink} data-testid="share-copy-link">
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {canShareFiles ? (
            <button type="button" className={styles.secondary} onClick={shareNative} data-testid="share-native">
              Share…
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="error-text" data-testid="share-error">
            {error}
          </p>
        ) : null}
        <p className={styles.note}>
          The link shows this card as its preview on X and Telegram. Testnet — USDW has no value.
        </p>
      </div>
    </Modal>
  );
}
