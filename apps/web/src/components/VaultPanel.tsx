'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useVaultShares, useVaultTvl } from '@/hooks/useVault';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { VAULT_ADDRESS } from '@/lib/deployment';
import { formatMoney } from '@/lib/money';
import { FundingModal, type FundingMode } from './FundingModal';

/**
 * The LP position view: what this wallet holds in the vault, and what the vault holds.
 *
 * The deposit and withdraw *controls* used to live here and now live in FundingModal,
 * reachable from the header on every page. They were moved, not copied — a second
 * deposit form would be a second place for the request/settle/claim lifecycle to drift
 * out of step with the contract. This page opens the same dialog the header does.
 */
export function VaultPanel() {
  const { address, isConnected } = useAccount();
  const erc20 = useErc20(VAULT_ADDRESS);
  const { shares } = useVaultShares();
  const { tvl } = useVaultTvl();
  const [mode, setMode] = useState<FundingMode | null>(null);

  return (
    <div className="vault-panel" data-testid="vault-panel">
      <div className="vault-stat">
        <span className="vault-stat-label mono-upper">Vault TVL</span>
        {/* A dash until the read answers, a real 0.00 once it does. An empty vault and an
            unread one are different facts, so the dash carries a reason rather than
            being mistaken for "the vault is empty". */}
        <span
          className="vault-stat-value"
          data-testid="vault-tvl"
          title={tvl === null ? 'IOstiumVault.tvl has not been read yet' : undefined}
        >
          {tvl === null ? '—' : `${formatMoney(tvl, COLLATERAL_DECIMALS)} USDW`}
        </span>
      </div>

      {!isConnected ? (
        <p className="vault-hint" data-testid="vault-disconnected">
          Connect your wallet to see your LP position.
        </p>
      ) : (
        <>
          <div className="vault-stat">
            <span className="vault-stat-label mono-upper">Your shares</span>
            <span className="vault-stat-value" data-testid="vault-shares">
              {formatMoney(shares, COLLATERAL_DECIMALS)}
            </span>
          </div>
          <div className="vault-stat">
            <span className="vault-stat-label mono-upper">Wallet balance</span>
            <span className="vault-stat-value" data-testid="vault-usdw-balance">
              {formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW
            </span>
          </div>

          <div className="vault-actions">
            <button type="button" onClick={() => setMode('deposit')} data-testid="vault-deposit-button">
              Deposit
            </button>
            <button type="button" onClick={() => setMode('withdraw')} data-testid="vault-withdraw-button">
              Withdraw
            </button>
          </div>

          <p className="hint">Connected as {address}</p>
        </>
      )}

      <FundingModal
        open={mode !== null}
        mode={mode ?? 'deposit'}
        onClose={() => setMode(null)}
        onModeChange={setMode}
      />
    </div>
  );
}
