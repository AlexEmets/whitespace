'use client';

import { useAccount } from 'wagmi';
import { FAUCET_WBT_AMOUNT, FAUCET_WBT_COOLDOWN_HOURS, useWbtFaucet } from '@/hooks/useWbtFaucet';
import styles from './FaucetPanel.module.css';
import wbt from './WbtFaucetPanel.module.css';

/**
 * The native-WBT (gas) faucet, as a sibling to the USDW <FaucetPanel>.
 *
 * WHY IT EXISTS. A wallet holding no WBT cannot pay gas — not for a trade, and not even
 * for the USDW `claim()` on this same page. The external Whitechain faucet solves this but
 * gates it behind a 30-day-old GitHub account and a captcha, which is a wall in front of
 * the one thing a brand-new tester needs first. This panel hands out a small amount of WBT
 * straight from the project's own funded wallet, no account required.
 *
 * WHY THERE IS NO WALLET CONFIRMATION. Unlike the USDW mint, this is not a transaction the
 * visitor signs (they have no gas to sign it with). It is a request to services/api, which
 * sends the WBT from a server-side wallet — so the only thing this needs from the visitor
 * is a connected address to send to.
 */

/** The block explorer for chain 1874 (same one docs/DocsArticle names) — the funding tx
 * is linked here so the visitor can watch it confirm rather than take "sent" on faith. */
const EXPLORER_BASE = 'https://explorer.testnet.whitechain.io';

function formatRetry(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 1) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return 'under a minute';
}

export function WbtFaucetPanel() {
  const { address, isConnected } = useAccount();
  const faucet = useWbtFaucet(address);

  return (
    <section className={styles.panel} data-testid="wbt-faucet-panel">
      <div className={styles.head}>
        <span className="mono-upper">Testnet gas</span>
        <span className={styles.badge}>WBT</span>
      </div>

      <div className={styles.balanceRow}>
        <span className={`${styles.balanceLabel} mono-upper`}>Sends to</span>
        <span className={wbt.target} data-testid="wbt-faucet-target">
          {isConnected && address ? (
            <span title={address}>
              {address.slice(0, 10)}…{address.slice(-8)}
            </span>
          ) : (
            '—'
          )}
        </span>
      </div>

      <dl className={styles.facts}>
        <div>
          <dt className="mono-upper">Sends</dt>
          <dd data-testid="wbt-faucet-amount">{FAUCET_WBT_AMOUNT} WBT</dd>
        </div>
        <div>
          <dt className="mono-upper">Cadence</dt>
          <dd className={styles.factText}>Once per {FAUCET_WBT_COOLDOWN_HOURS}h, per wallet and IP</dd>
        </div>
      </dl>

      <div className={styles.foot}>
        {isConnected ? (
          <button
            type="button"
            className={styles.action}
            data-testid="wbt-faucet-button"
            onClick={faucet.request}
            disabled={faucet.pending}
          >
            {faucet.pending ? (
              `Sending ${FAUCET_WBT_AMOUNT} WBT…`
            ) : (
              <>
                Request {FAUCET_WBT_AMOUNT} WBT
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              </>
            )}
          </button>
        ) : (
          <p className={styles.muted} data-testid="wbt-faucet-disconnected">
            Connect a wallet to receive gas.
          </p>
        )}

        {faucet.txHash ? (
          <p className={styles.ok} role="status" data-testid="wbt-faucet-success">
            Sent {FAUCET_WBT_AMOUNT} WBT.{' '}
            <a
              className={wbt.link}
              data-testid="wbt-faucet-tx"
              href={`${EXPLORER_BASE}/tx/${faucet.txHash}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              View the transaction ↗
            </a>
          </p>
        ) : null}
        {faucet.error ? (
          <p className="error-text" role="alert" data-testid="wbt-faucet-error">
            {faucet.error}
            {faucet.retryAfterSeconds != null ? ` Try again in ${formatRetry(faucet.retryAfterSeconds)}.` : ''}
          </p>
        ) : null}

        <p className={styles.muted}>
          Native gas on Whitechain testnet. It has no value; it only pays transaction fees.
        </p>
      </div>
    </section>
  );
}
