'use client';

import { useAccount } from 'wagmi';
import { useSessionKey } from '@/hooks/useSessionKey';
import { SESSION_KEY_GAS_TOPUP_WBT } from '@/lib/sessionKey';
import { formatMoney } from '@/lib/money';
import styles from './OneClickTrading.module.css';

/** 0x1234…abcd — enough to recognise the session key without spelling it out. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The one-click trading offer, sitting at the top of the order ticket where a trader acts.
 *
 * Off: a compact callout — approve once and every later trade skips the wallet popup. Enabling
 * asks for a single signature (registering the session key as the on-chain delegate) and tops
 * the key up with a little WBT for gas.
 *
 * On: a live badge with the session key's remaining gas, a one-tap top-up, and a way to turn
 * it back off (which revokes the on-chain delegate and wipes the local key). A leaked session
 * key can only trade — never withdraw — so this stays comfortable to leave on. Testnet only.
 */
export function OneClickTrading() {
  const { isConnected } = useAccount();
  const { active, enabling, disabling, funding, error, gasWei, lowGas, sessionAddress, enable, disable, fundGas } =
    useSessionKey();

  // Nothing to offer until there is a wallet to delegate from.
  if (!isConnected) return null;

  if (!active) {
    return (
      <section className={styles.card} data-testid="one-click-trading" aria-label="One-click trading">
        <div className={styles.head}>
          <span className={styles.bolt} aria-hidden="true">
            ⚡
          </span>
          <span className={styles.title}>One-click trading</span>
          <span className={styles.badge} data-testid="one-click-status">
            Off
          </span>
        </div>
        <p className={styles.subtitle}>
          Approve once, then open, close and edit trades without a wallet pop-up each time. Revocable anytime.
        </p>
        <div className={styles.row}>
          <button
            type="button"
            className={styles.primary}
            data-testid="one-click-enable"
            onClick={() => void enable()}
            disabled={enabling}
          >
            {enabling ? 'Enabling…' : 'Enable one-click trading'}
          </button>
        </div>
        {error ? (
          <p className={styles.error} data-testid="one-click-error">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  const gasLabel = gasWei !== null ? `${formatMoney(gasWei, 18, { fractionDigits: 4 })} WBT` : '—';
  return (
    <section className={`${styles.card} ${styles.on}`} data-testid="one-click-trading" aria-label="One-click trading">
      <div className={styles.head}>
        <span className={styles.bolt} aria-hidden="true">
          ⚡
        </span>
        <span className={styles.title}>One-click trading</span>
        <span className={`${styles.badge} ${styles.live}`} data-testid="one-click-status">
          On
        </span>
      </div>
      <div className={styles.row}>
        <span className={`${styles.gas} ${lowGas ? styles.low : ''}`} data-testid="one-click-gas">
          Gas {gasLabel}
          {lowGas ? ' · low' : ''}
        </span>
        {sessionAddress ? <span className={styles.addr}>{shortAddress(sessionAddress)}</span> : null}
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.ghost}
            data-testid="one-click-fund"
            onClick={() => void fundGas()}
            disabled={funding}
          >
            {funding ? 'Funding…' : `Fund gas (+${SESSION_KEY_GAS_TOPUP_WBT})`}
          </button>
          <button
            type="button"
            className={styles.ghost}
            data-testid="one-click-disable"
            onClick={() => void disable()}
            disabled={disabling}
          >
            {disabling ? 'Turning off…' : 'Turn off'}
          </button>
        </span>
      </div>
      {lowGas ? (
        <p className={styles.subtitle}>Running low on gas — top up so your next trade doesn’t stall.</p>
      ) : null}
      {error ? (
        <p className={styles.error} data-testid="one-click-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
