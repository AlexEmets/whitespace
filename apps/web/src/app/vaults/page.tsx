import type { Metadata } from 'next';
import { VaultPanel } from '@/components/VaultPanel';
import { PageHead, Section } from '@/components/portfolio/AccountPage';
import styles from '@/components/portfolio/accountPage.module.css';

export const metadata: Metadata = {
  title: 'Vaults — Whitespace',
  description: 'The LP vault that takes the other side of every Whitespace trade: its TVL and your share of it.',
};

/** /vaults — the LP vault as a product: what it holds, what share of it is yours, and how
 * money moves in and out. Deposit and withdraw open the same dialog /portfolio uses; the
 * lifecycle is explained here because it is not instant, and a trader who expects it to be
 * will think the first request failed. */
export default function VaultsPage() {
  return (
    <div className={styles.page}>
      <PageHead
        eyebrow="LP vault"
        title="Vaults"
        lede="One vault is the counterparty to every trade on Whitespace. Liquidity providers own it in shares; the share price moves with the traders' net PnL, fees and funding."
      />
      <div className="vault-grid">
        <VaultPanel />
        <Section title="How deposits and withdrawals move" testId="vault-lifecycle">
          <ol className="vault-steps">
            <li>
              <span className="vault-step-index">01</span>
              <span>
                <strong>Request.</strong> A deposit or withdrawal is queued on chain, not executed on the spot — the vault
                prices shares only at settlement, so nobody can enter or leave at a stale share price.
              </span>
            </li>
            <li>
              <span className="vault-step-index">02</span>
              <span>
                <strong>Settle.</strong> At the next settlement the queued requests are priced together at that
                moment&rsquo;s share value.
              </span>
            </li>
            <li>
              <span className="vault-step-index">03</span>
              <span>
                <strong>Claim.</strong> Once settled, claim the shares (after a deposit) or the USDW (after a withdrawal)
                into your wallet.
              </span>
            </li>
          </ol>
        </Section>
      </div>
    </div>
  );
}
