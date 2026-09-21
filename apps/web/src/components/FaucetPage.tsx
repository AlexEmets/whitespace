'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { FaucetPanel } from '@/components/FaucetPanel';
import { AccountState, DefRow, Defs, PageHead, Section, accountStyles as styles } from '@/components/portfolio/AccountPage';
import { CHAIN_ID } from '@/lib/config';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';

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
 * Uses the /portfolio and /points shell so the three account-scoped pages are visibly the
 * same kind of screen.
 */
export function FaucetPage() {
  const { isConnected } = useAccount();

  return (
    <div className={styles.page} data-testid="faucet-page">
      <PageHead
        eyebrow="Testnet"
        title="Faucet"
        lede={
          <>
            Whitespace runs on Whitechain testnet {CHAIN_ID}, and its collateral token is a mock ERC-20 with an open
            mint. Claim USDW here, then trade with it or supply it to the LP vault. It is not purchasable, not
            redeemable, and not worth anything.
          </>
        }
        meta={
          <>
            <div>
              <strong>TOKEN</strong> USDW · 6 dp
            </div>
            <div>
              <strong>NETWORK</strong> WHITECHAIN {CHAIN_ID}
            </div>
            <div>
              <strong>SOURCE</strong> USDW.claim()
            </div>
          </>
        }
      />

      <Section
        title="Claim"
        aside="One transaction, signed by your wallet. Nothing is queued or settled — this one is immediate."
      >
        {!isConnected ? (
          <AccountState kind="disconnected" title="No wallet connected">
            The faucet mints to the address that calls it, so there is nothing to claim until you connect. Use{' '}
            <strong>Connect</strong> in the header — the panel below then reads your balance straight from the token.
          </AccountState>
        ) : null}
        <FaucetPanel />
      </Section>

      <Section
        title="What you are claiming"
        note="Stated because a token called USDW next to a leverage slider invites exactly one wrong assumption."
      >
        <Defs>
          <DefRow
            label="Contract"
            value={
              <span className={styles.subtle} title={COLLATERAL_ADDRESS}>
                {COLLATERAL_ADDRESS.slice(0, 10)}…{COLLATERAL_ADDRESS.slice(-8)}
              </span>
            }
          />
          <DefRow label="Mint function" value={<span className={styles.subtle}>claim() — uncapped, permissionless</span>} />
          <DefRow label="Backing" value={<span className={styles.subtle}>None. It is not a stablecoin and not redeemable.</span>} />
          <DefRow label="Used for" value={<span className={styles.subtle}>Order collateral, and LP deposits into the vault</span>} />
        </Defs>
      </Section>

      <Section title="Once you have some">
        <Defs>
          <DefRow
            label="Trade it"
            value={
              <Link href="/trade" className={styles.subtle}>
                Open a position on the terminal →
              </Link>
            }
          />
          <DefRow
            label="Supply it"
            value={
              <Link href="/portfolio" className={styles.subtle}>
                Deposit into the LP vault from your portfolio →
              </Link>
            }
          />
        </Defs>
      </Section>
    </div>
  );
}
