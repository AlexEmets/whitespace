import { VaultPanel } from '@/components/VaultPanel';

/** /vaults — the LP vault as a product: what it holds, and what share of it is yours.
 * The faucet moved to /faucet; deposit and withdraw are also reachable from /portfolio,
 * which is where the balances they move already live. Both open the same dialog. */
export default function VaultsPage() {
  return (
    <div style={{ maxWidth: '480px', margin: '2rem auto', padding: '0 1rem', display: 'grid', gap: '1.25rem' }}>
      <div>
        <h1 className="mono-upper" style={{ fontSize: '1rem' }}>
          Vaults
        </h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          Your LP position. Deposit and withdraw are async — request, settle, claim.
        </p>
      </div>
      <VaultPanel />
    </div>
  );
}
