'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useTermsAccepted } from '@/hooks/useTermsAccepted';
import { acceptTerms } from '@/lib/legal';
import { Modal } from './Modal';
import styles from './TermsGate.module.css';

/**
 * Agreement to the Terms, asked for once per browser per version of the Terms, the first
 * time a wallet connects.
 *
 * A link in a footer binds nobody; a box the trader ticks before going on does. So a
 * connected wallet meets this before anything else — the setup guide waits for it — and
 * the only ways out are to agree or to disconnect. Closing it any other way (Esc, the
 * backdrop, ×) is declining, so it disconnects too.
 */
export function TermsGate() {
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const accepted = useTermsAccepted();
  const [checked, setChecked] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);

  const decline = useCallback(() => {
    setChecked(false);
    disconnect();
  }, [disconnect]);

  const agree = () => {
    if (!checked) return;
    acceptTerms();
  };

  return (
    <Modal
      open={isConnected && !accepted}
      onClose={decline}
      title="Before you start"
      testId="terms-gate"
      size="wide"
      initialFocusRef={checkboxRef}
    >
      <div className={styles.body}>
        <p className={styles.lede}>
          Whitespace is testnet software. Please read the <Link href="/terms">Terms of Use</Link> and the{' '}
          <Link href="/privacy">Privacy Policy</Link>. In short:
        </p>
        <ul className={styles.points}>
          <li>Test tokens and points have no value, and points are not a promise of any token or airdrop.</li>
          <li>Leveraged trading can lose your whole margin, and the contracts have not been audited.</li>
          <li>You are responsible for your wallet, the transactions you sign and following the laws where you live.</li>
          <li>
            Whitespace is not for people in, or residents of, the United States, sanctioned countries or the other
            restricted jurisdictions in the Terms.
          </li>
        </ul>

        <label className={styles.consent}>
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            data-testid="terms-gate-checkbox"
          />
          <span>
            I have read and agree to the Terms of Use and the Privacy Policy, and I am not a resident of, or located in, a
            restricted jurisdiction.
          </span>
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={decline} data-testid="terms-gate-decline">
            Disconnect
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={agree}
            disabled={!checked}
            data-testid="terms-gate-agree"
          >
            Agree and continue
          </button>
        </div>
      </div>
    </Modal>
  );
}
