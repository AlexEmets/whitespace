'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { FaucetPanel } from '@/components/FaucetPanel';
import { WbtFaucetPanel } from '@/components/WbtFaucetPanel';
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

/** Same card, but leaving the site. The arrow differs from NextStep's on purpose: both
 * sit in the same visual vocabulary, and the only thing distinguishing "another page
 * here" from "someone else's site" is that glyph. */
function OutboundStep({ href, kicker, children }: { href: string; kicker: string; children: ReactNode }) {
  return (
    <a href={href} className={styles.card} target="_blank" rel="noreferrer noopener">
      <span>
        <span className={styles.cardKicker}>{kicker}</span>
        <span className={styles.cardText}>{children}</span>
      </span>
      <span className={styles.cardArrow} aria-hidden="true">
        ↗
      </span>
    </a>
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

      {/* Both faucets sit here, side by side: USDW to trade with and WBT to pay the gas
          that every action — including the USDW claim itself — costs. They used to be a
          band apart, which buried the gas one below the fold exactly where a stuck, gasless
          visitor could not see it. */}
      <section className={`${styles.band} ${styles.claimBand}`}>
        <div className={styles.claimMain}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Claim</h2>
            <p className={styles.sectionAside}>
              Two testnet tokens — USDW to trade with, WBT for gas. Both are free, and each claim is immediate: nothing
              is queued or settled.
            </p>
          </div>

          <div className={styles.claimCol}>
            {!isConnected ? (
              <AccountState kind="disconnected" title="No wallet connected">
                Both faucets send to the address you connect, so there is nothing to claim until you do. Use{' '}
                <strong>Connect</strong> in the header — the panels then read straight from your wallet.
              </AccountState>
            ) : null}
            <div className={styles.claimPanels}>
              <FaucetPanel />
              <WbtFaucetPanel />
            </div>
          </div>
        </div>
      </section>

      <section className={styles.pair} data-testid="faucet-gas">
        <div className={styles.pairCol}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>No value, by design</h2>
          </div>
          {/* The one thing a testnet token's page owes a visitor that a mainnet one does
              not: why the numbers it just handed them are not worth anything. */}
          <p className={styles.pairNote}>
            USDW is uncapped and permissionless to mint, so it cannot hold a market price — treat balances as a unit of
            practice. WBT here is native gas: it pays transaction fees on Whitechain {CHAIN_ID} and nothing else.
            Neither is redeemable.
          </p>
          <div className={styles.defs}>
            <DefRow label="USDW" value="Collateral · uncapped mint · no price" />
            <DefRow label="WBT" value="Native gas · pays fees only" />
          </div>
        </div>

        <div className={styles.pairCol}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>More WBT, elsewhere</h2>
          </div>
          <p className={styles.pairNote}>
            If the gas faucet is dry or you need more than it gives, the official faucet hands out 0.5 WBT per day
            (behind a 30-day-old GitHub account and a captcha). The bridge answers &ldquo;that is not enough&rdquo; — it
            needs WBT on Ethereum Sepolia first, and its size is capped by how much the destination side is holding.
          </p>
          <div className={styles.cards}>
            <OutboundStep href="https://faucet.testnet.whitechain.io" kicker="Official faucet">
              Claim 0.5 WBT for this network
            </OutboundStep>
            <OutboundStep href="https://bridge.testnet.whitechain.io" kicker="Portal bridge">
              Move WBT from Ethereum Sepolia — it arrives as native gas
            </OutboundStep>
          </div>
        </div>
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
