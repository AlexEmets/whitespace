'use client';

import { useEffect, useRef, useState } from 'react';
import { useReadContract } from 'wagmi';
import { PAIRS_STORAGE_ABI } from '@/lib/abi';
import {
  FULL_SHARE,
  closeSizeForShare,
  leavesTooLittle,
  maxPartialShare,
  pnlForShare,
  shareForCloseSize,
} from '@/lib/closeTicket';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { PAIRS_STORAGE_ADDRESS } from '@/lib/deployment';
import { collateralToRaw, formatLeverage, formatMoney, leverageToRaw, parseHumanDecimal } from '@/lib/money';
import type { PositionSummary } from '@/lib/types';
import { Modal } from './Modal';
import styles from './ClosePositionDialog.module.css';

const QUICK_SHARES = [2500, 5000, 7500, FULL_SHARE] as const;

/** What the confirm handler reports back: closed, or not — with the reason to show, or
 * `null` when the wallet declined and there is nothing to say. */
export type CloseOutcome = { done: true } | { done: false; error: string | null };

/** `0.0295`, not `0.029500000000000000`: the amount as a trader would type it. */
function formatSize(raw: bigint): string {
  const text = formatMoney(raw, PRICE_DECIMALS_NUM, { fractionDigits: 6, grouping: false });
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** `25%`, `33.9%`: whole shares without decimals, the contract's 0.01% grain otherwise. */
export function formatShare(share: number): string {
  const pct = share / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2).replace(/0+$/, '')}%`;
}

function parseAmount(text: string): bigint | null {
  if (!text.trim()) return null;
  try {
    return parseHumanDecimal(text, PRICE_DECIMALS_NUM);
  } catch {
    return null;
  }
}

/**
 * Confirmation for closing a position, whole or in part.
 *
 * The Close button used to close everything in one click, with fixed 25/50/75% sizes behind
 * a chevron. Leaving a leveraged position deserves one look before the wallet opens, and
 * the contract takes any share, so this asks how much — typed as an amount, dragged on a
 * slider or picked from the quick sizes — and shows what that closes, what is left, and
 * roughly what it realises before anything is signed.
 *
 * Market only: `closeTradeMarket` is the contract's one way out at a chosen moment; exiting
 * at a set price is what TP / SL are for.
 */
export function ClosePositionDialog({
  open,
  onClose,
  position,
  marketName,
  baseAsset,
  sizeBaseRaw,
  pnlRaw,
  canClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  position: PositionSummary;
  /** "BTC-PERP" */
  marketName: string;
  /** "BTC" */
  baseAsset: string;
  sizeBaseRaw: bigint;
  /** Unrealised PnL at the live mark, or null while there is no price. */
  pnlRaw: bigint | null;
  /** False while there is no live price to close against. */
  canClose: boolean;
  onConfirm: (share: number) => Promise<CloseOutcome>;
}) {
  const [share, setShare] = useState<number | null>(FULL_SHARE);
  const [amountText, setAmountText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Every opening starts from a full close — the common case, one confirmation away.
  useEffect(() => {
    if (!open) return;
    setShare(FULL_SHARE);
    setAmountText(formatSize(sizeBaseRaw));
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const minLevPos = useReadContract({
    address: PAIRS_STORAGE_ADDRESS,
    abi: PAIRS_STORAGE_ABI,
    functionName: 'pairMinLevPos',
    args: [position.pairIndex],
    query: { enabled: open },
  });

  const minInputs =
    minLevPos.data !== undefined
      ? {
          collateralRaw: collateralToRaw(position.collateral),
          leverageRaw: leverageToRaw(position.leverage),
          minLevPosRaw: minLevPos.data,
        }
      : null;
  const tooLittle = share !== null && minInputs !== null && leavesTooLittle({ ...minInputs, share });
  const maxPartial = minInputs !== null ? maxPartialShare(minInputs) : null;

  function pickShare(next: number) {
    setShare(next);
    setAmountText(formatSize(closeSizeForShare(sizeBaseRaw, next)));
    setError(null);
  }

  function typeAmount(text: string) {
    setAmountText(text);
    const amount = parseAmount(text);
    setShare(amount === null ? null : shareForCloseSize(amount, sizeBaseRaw));
    setError(null);
  }

  async function confirm() {
    if (share === null) return;
    setSubmitting(true);
    setError(null);
    const outcome = await onConfirm(share);
    setSubmitting(false);
    if (outcome.done) onClose();
    else setError(outcome.error);
  }

  const closeSize = share !== null ? closeSizeForShare(sizeBaseRaw, share) : null;
  const remaining = closeSize !== null ? sizeBaseRaw - closeSize : null;
  const partPnl = share !== null && pnlRaw !== null ? pnlForShare(pnlRaw, share) : null;
  const canConfirm = canClose && share !== null && !tooLittle && !submitting;

  return (
    <Modal open={open} onClose={onClose} title="Close position" testId="close-dialog" initialFocusRef={amountRef} size="wide">
      <div className={styles.body}>
        <div className={styles.position}>
          <span className={`side-bar ${position.buy ? 'long' : 'short'}`} aria-hidden="true" />
          <span className={styles.market}>{marketName}</span>
          <span className={position.buy ? 'pos' : 'neg'}>
            {position.buy ? 'Long' : 'Short'} {formatLeverage(position.leverage)}
          </span>
          <span className={styles.size}>
            {formatSize(sizeBaseRaw)} {baseAsset}
          </span>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldHead}>
            <span>Amount to close</span>
            <span className={styles.share} data-testid="close-share">
              {share !== null ? formatShare(share) : '—'}
            </span>
          </span>
          <span className={styles.inputWrap}>
            <input
              ref={amountRef}
              className={styles.input}
              inputMode="decimal"
              value={amountText}
              onChange={(e) => typeAmount(e.target.value)}
              aria-label={`Amount to close in ${baseAsset}`}
              data-testid="close-amount-input"
            />
            <span className={styles.suffix}>{baseAsset}</span>
          </span>
        </label>

        <input
          type="range"
          className="slim-range"
          min={1}
          max={100}
          step={1}
          value={share !== null ? Math.max(1, Math.round(share / 100)) : 1}
          onChange={(e) => pickShare(Number(e.target.value) * 100)}
          style={{ ['--fill' as string]: `${share !== null ? share / 100 : 0}%` }}
          aria-label="Share of the position to close"
          data-testid="close-share-slider"
        />

        <div className={styles.quick}>
          {QUICK_SHARES.map((q) => (
            <button
              key={q}
              type="button"
              className={share === q ? styles.quickActive : styles.quickButton}
              onClick={() => pickShare(q)}
              data-testid={`close-quick-${q / 100}`}
            >
              {q === FULL_SHARE ? 'All' : formatShare(q)}
            </button>
          ))}
        </div>

        <dl className={styles.preview}>
          <div>
            <dt>Closing</dt>
            <dd data-testid="close-preview-size">{closeSize !== null ? `${formatSize(closeSize)} ${baseAsset}` : '—'}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd data-testid="close-preview-remaining">
              {remaining === null ? '—' : remaining === 0n ? 'None' : `${formatSize(remaining)} ${baseAsset}`}
            </dd>
          </div>
          <div>
            <dt>Est. PnL on this part</dt>
            <dd data-testid="close-preview-pnl" className={partPnl === null ? undefined : partPnl >= 0n ? 'pos' : 'neg'}>
              {partPnl === null ? '—' : `${formatMoney(partPnl, COLLATERAL_DECIMALS, { signDisplay: true })} USDW`}
            </dd>
          </div>
          <div>
            <dt>Order type</dt>
            <dd>Market · ≤ {formatMoney(DEFAULT_SLIPPAGE_BPS, 2)}% slippage</dd>
          </div>
        </dl>
        <p className={styles.note}>
          Fills at the next oracle price; the PnL is an estimate at the live mark, before fees and funding. To exit at a
          set price instead, use TP / SL.
        </p>

        {tooLittle ? (
          <p className="error-text" role="alert" data-testid="close-too-little">
            {maxPartial && maxPartial > 0
              ? `That would leave less than this market's minimum position of ${formatMoney(minLevPos.data!, COLLATERAL_DECIMALS)} USDW. Close up to ${formatShare(maxPartial)}, or all of it.`
              : "This position is at the market's minimum size, so it can only be closed in full."}
          </p>
        ) : null}
        {error ? (
          <p className="error-text" role="alert" data-testid="close-error">
            {error}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose} data-testid="close-cancel">
            Cancel
          </button>
          <button type="button" className={styles.primary} disabled={!canConfirm} onClick={confirm} data-testid="close-confirm">
            {submitting
              ? 'Confirm in your wallet…'
              : share === null || share === FULL_SHARE
                ? 'Close position'
                : `Close ${formatShare(share)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
