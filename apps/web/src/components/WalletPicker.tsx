'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { useWalletOptions, type WalletOption } from '@/hooks/useWalletOptions';
import { CHAIN_ID } from '@/lib/config';
import { Modal } from './Modal';
import styles from './WalletPicker.module.css';

/**
 * wagmi surfaces the raw provider error, which for a rejection is a multi-paragraph
 * block with a docs link. The first line plus a couple of known cases is all a trader
 * needs, and the untouched message is still there for anything unrecognised.
 */
function readableError(error: Error): string {
  const message = error.message || 'Connection failed.';
  if (/user rejected|user denied/i.test(message)) return 'Request rejected in the wallet.';
  if (/already pending|already processing/i.test(message)) {
    return 'The wallet is already asking — open it and approve the pending request.';
  }
  if (/provider not found|no provider/i.test(message)) return 'That wallet is no longer responding. Reload the page.';
  return message.split('\n')[0] ?? 'Connection failed.';
}

/** A detected wallet supplies its own logo over EIP-6963; a missing one gets a monogram
 *  tile in its brand colour, so the icon itself says whether the wallet is installed. */
function WalletIcon({ option }: { option: WalletOption }) {
  const icon = option.kind === 'detected' ? option.icon : undefined;
  if (icon) {
    // A plain <img>, not next/image: these are data URIs the wallet handed us at runtime,
    // so there is no remote asset to optimise and no known intrinsic size to declare.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt="" className={styles.icon} width={28} height={28} />;
  }
  return (
    <span className={styles.icon} style={{ background: option.brandColor ?? 'var(--bg-raised)' }} aria-hidden="true">
      {option.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { options } = useWalletOptions();
  const { connect, isPending, error, reset } = useConnect();
  const { isConnected } = useAccount();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const firstRowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && isConnected) onClose();
  }, [open, isConnected, onClose]);

  // A rejection from a previous visit is stale the moment the dialog reopens.
  useEffect(() => {
    if (open) {
      setPendingKey(null);
      reset();
    }
  }, [open, reset]);

  const handleSelect = useCallback(
    (option: WalletOption) => {
      if (option.kind !== 'detected') return;
      setPendingKey(option.key);
      reset();
      connect({ connector: option.connector });
    },
    [connect, reset],
  );

  const firstInstallIndex = options.findIndex((option) => option.kind === 'install');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect wallet"
      testId="wallet-picker"
      // The first wallet row, not the close button that precedes it in DOM order — the
      // dialog exists to pick a wallet, so the keyboard should land on one.
      initialFocusRef={firstRowRef}
      footer={<>Whitechain Testnet · chain {CHAIN_ID}</>}
    >
      <ul className={styles.list}>
          {options.map((option, index) => {
            const isRowPending = pendingKey === option.key && isPending;
            const showError = pendingKey === option.key && error !== null && !isPending;

            return (
              <li key={option.key}>
                {index === firstInstallIndex ? <p className={styles.groupLabel}>Not installed</p> : null}

                {option.kind === 'detected' ? (
                  <button
                    ref={index === 0 ? firstRowRef : undefined}
                    type="button"
                    className={styles.row}
                    disabled={isPending}
                    onClick={() => handleSelect(option)}
                    data-testid={`wallet-option-${option.key}`}
                  >
                    <WalletIcon option={option} />
                    <span className={styles.text}>
                      <span className={styles.rowName}>{option.name}</span>
                      {option.detail ? <span className={styles.rowDetail}>{option.detail}</span> : null}
                    </span>
                    <span className={`${styles.state} ${isRowPending ? styles.statePending : styles.stateDetected}`}>
                      {isRowPending ? 'Connecting…' : 'Detected'}
                    </span>
                  </button>
                ) : (
                  <a
                    className={`${styles.row} ${styles.rowInstall}`}
                    href={option.installUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-testid={`wallet-install-${option.key}`}
                  >
                    <WalletIcon option={option} />
                    <span className={styles.text}>
                      <span className={styles.rowName}>{option.name}</span>
                    </span>
                    <span className={styles.state}>Install ↗</span>
                  </a>
                )}

                {showError ? (
                  <p className={styles.error} role="alert" data-testid="wallet-picker-error">
                    {readableError(error)}
                  </p>
                ) : null}
              </li>
            );
          })}
      </ul>
    </Modal>
  );
}
