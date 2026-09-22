'use client';

import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { FAUCET_COOLDOWN_HOURS, FAUCET_MINT_USDW, useFaucet } from '@/hooks/useFaucet';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { formatMoney } from '@/lib/money';
import styles from './FaucetPanel.module.css';

/**
 * The testnet faucet, as its own surface.
 *
 * It used to exist only as a button bolted onto two unrelated panels — the LP vault form
 * and the order-entry form — so "where do I get USDW" had no answer you could navigate
 * to, only one you could stumble into. The cadence and the amount were never stated
 * anywhere, which made the token's own 24h refusal look like a broken button.
 *
 * The spender is TradingStorage even though this panel never spends and renders no
 * allowance. Naming it is what lets `useFaucet` arm the trading allowance alongside the
 * mint, which is the whole reason the order form needs only one confirmation — see
 * useFaucet.armAllowance. TradingStorage specifically, because it is the contract that
 * runs `safeTransferFrom` on the collateral; an allowance granted to `Trading` mines
 * perfectly and authorises nothing (the bug OpenPositionForm.tsx:74-86 documents).
 */
export function FaucetPanel() {
  const { isConnected } = useAccount();
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const faucet = useFaucet(erc20);

  return (
    <section className={styles.panel} data-testid="faucet-panel">
      <div className={styles.head}>
        <span className="mono-upper">Testnet faucet</span>
        <span className={styles.badge}>USDW</span>
      </div>

      <div className={styles.balanceRow}>
        <span className={`${styles.balanceLabel} mono-upper`}>Wallet balance</span>
        <span className={styles.balance} data-testid="faucet-balance">
          {isConnected ? formatMoney(erc20.balance, COLLATERAL_DECIMALS) : '—'}
          <span className={styles.unit}>USDW</span>
        </span>
      </div>

      <dl className={styles.facts}>
        <div>
          <dt className="mono-upper">Mints</dt>
          <dd data-testid="faucet-mint-amount">{formatMoney(FAUCET_MINT_USDW, COLLATERAL_DECIMALS)} USDW</dd>
        </div>
        <div>
          <dt className="mono-upper">Cadence</dt>
          <dd>Once per {FAUCET_COOLDOWN_HOURS}h, per address</dd>
        </div>
      </dl>

      {isConnected ? (
        <button
          type="button"
          className={styles.action}
          data-testid="faucet-panel-button"
          onClick={faucet.claim}
          disabled={faucet.pending}
        >
          {/* The pending state is not decoration: `claimFaucet` waits for its receipt, which
              on this chain is several seconds of a button that would otherwise look inert —
              indistinguishable from a click that never registered. */}
          {faucet.pending ? 'Claiming… confirm in your wallet' : 'Request test tokens'}
        </button>
      ) : (
        <p className={styles.muted} data-testid="faucet-disconnected">
          Connect a wallet to mint.
        </p>
      )}

      {faucet.claimed ? (
        <p className={styles.ok} role="status" data-testid="faucet-panel-success">
          Minted. Your balance above is the post-mint figure, read back from the token.
        </p>
      ) : null}
      {faucet.error ? (
        <p className="error-text" role="alert" data-testid="faucet-panel-error">
          {faucet.error}
        </p>
      ) : null}

      <p className={styles.muted}>Testnet collateral on Whitechain 1874. It has no value and cannot be redeemed.</p>
    </section>
  );
}
