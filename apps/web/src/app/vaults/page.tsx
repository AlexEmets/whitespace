import { VaultPanel } from '@/components/VaultPanel';

export default function VaultsPage() {
  return (
    <div style={{ maxWidth: '480px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 className="mono-upper" style={{ fontSize: '1rem' }}>
        Vaults
      </h1>
      <p style={{ color: 'var(--fg-muted)' }}>Deposit or withdraw USDW from the LP vault (async request/settle/claim).</p>
      <VaultPanel />
    </div>
  );
}
