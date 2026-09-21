import { FaucetPanel } from '@/components/FaucetPanel';
import { VaultPanel } from '@/components/VaultPanel';

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
      <FaucetPanel />
    </div>
  );
}
