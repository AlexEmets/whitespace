'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { FaucetPanel } from '@/components/FaucetPanel';
import { AccountState } from '@/components/portfolio/AccountPage';
import { CHAIN_ID } from '@/lib/config';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';
import styles from './FaucetPage.module.css';

/**
 * /faucet — the one place to get collateral.
 *
 * It used to be a button on the vault panel and another inside the order form, which
 * meant "where do I get USDW" had no answer you could navigate to, only one you could
 * stumble into. The order form keeps its inline button (a wallet holding 0 in front of a
 * live terminal is a dead end, and sending that trader away mid-order is worse than
 * minting in place) — but this is the page that the nav points at and that explains what
 * the token is.
 *
 * Laid out against docs/design/Whitespace Faucet-print-selection.png rather than on the
 * /portfolio + /points shell it used to share. That shell stacks full-width bands; this
 * mockup runs a rule down the page and puts an editorial rail beside the claim panel,
 * which the shell has no way to express. `AccountState` is still imported from it: the
 * disconnected state has to be the same object on all three account-scoped pages.
 */

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaKey}>{label}</span>
      <span className={styles.metaValue}>{value}</span>
    </div>
  );
}

function DefRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className={styles.defRow}>
      <span className={styles.defKey}>{label}</span>
      <span className={`${styles.defValue}${mono ? ` ${styles.mono}` : ''}`}>{value}</span>
    </div>
  );
}

function NextStep({ href, kicker, children }: { href: string; kicker: string; children: ReactNode }) {
  return (
    <Link href={href} className={styles.card}>
      <span>
        <span className={styles.cardKicker}>{kicker}</span>
        <span className={styles.cardText}>{children}</span>
      </span>
      <span className={styles.cardArrow} aria-hidden="true">
        →
      </span>
    </Link>
  );
}

export function FaucetPage() {
  const { isConnected } = useAccount();

  return (
    <div className={styles.page} data-testid="faucet-page">
      <header className={`${styles.band} ${styles.hero}`}>
        <div className={styles.heroMain}>
          <div className={styles.eyebrow}>Testnet</div>
          <h1 className={styles.title}>Faucet</h1>
          <p className={styles.lede}>
            Whitespace runs on Whitechain testnet {CHAIN_ID}, and its collateral token is a mock ERC-20 with an open
            mint. Claim USDW here, then trade with it or supply it to the LP vault. It is not purchasable, not
            redeemable, and not worth anything.
          </p>
        </div>
        <div className={`${styles.rail} ${styles.heroRail}`}>
          <MetaRow label="Token" value="USDW · 6 DP" />
          <MetaRow label="Network" value={`WHITECHAIN ${CHAIN_ID}`} />
          {/* Not uppercased with the two above: it is a Solidity symbol, and `USDW.CLAIM()`
              is a function that does not exist. */}
          <MetaRow label="Source" value="USDW.claim()" />
        </div>
      </header>

      <section className={styles.band}>
        <div className={styles.claimMain}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Claim</h2>
            <p className={styles.sectionAside}>
              One transaction, signed by your wallet. Nothing is queued or settled — this one is immediate.
            </p>
          </div>

          <div className={styles.claimCol}>
            {!isConnected ? (
              <AccountState kind="disconnected" title="No wallet connected">
                The faucet mints to the address that calls it, so there is nothing to claim until you connect. Use{' '}
                <strong>Connect</strong> in the header — the panel below then reads your balance straight from the
                token.
              </AccountState>
            ) : null}
            <FaucetPanel />
          </div>
        </div>

        {/* The one thing a testnet token's page owes a visitor that a mainnet one does
            not: why the number it just handed them is not worth anything. */}
        <aside className={`${styles.rail} ${styles.claimRail}`}>
          <div className={styles.eyebrow}>Uncapped mint</div>
          <h2 className={styles.railHeading}>Free supply, and therefore no price.</h2>
          <p className={styles.railBody}>
            Anyone can mint as much as they want, so USDW cannot hold a market price. Treat balances here as a unit of
            practice.
          </p>
        </aside>
      </section>

      <section className={styles.pair}>
        <div className={styles.pairCol}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>What you are claiming</h2>
          </div>
          <p className={styles.pairNote}>
            Stated because a token called USDW next to a leverage slider invites exactly one wrong assumption.
          </p>
          <div className={styles.defs}>
            <DefRow
              label="Contract"
              mono
              value={
                <span title={COLLATERAL_ADDRESS}>
                  {COLLATERAL_ADDRESS.slice(0, 10)}…{COLLATERAL_ADDRESS.slice(-8)}
                </span>
              }
            />
            <DefRow label="Mint function" mono value="claim() — uncapped, permissionless" />
            <DefRow label="Backing" value="None. It is not a stablecoin and not redeemable." />
            <DefRow label="Used for" value="Order collateral, and LP deposits into the vault" />
          </div>
        </div>

        <div className={styles.pairCol}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Once you have some</h2>
          </div>
          <p className={styles.pairNote}>
            Two places accept USDW, and both let you take it back out — close the position, or withdraw from the vault.
          </p>
          <div className={styles.cards}>
            <NextStep href="/trade" kicker="Trade it">
              Open a position on the terminal
            </NextStep>
            <NextStep href="/portfolio" kicker="Supply it">
              Deposit into the LP vault from your portfolio
            </NextStep>
          </div>
        </div>
      </section>
    </div>
  );
}
