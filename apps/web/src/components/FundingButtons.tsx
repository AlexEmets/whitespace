'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { FundingModal, type FundingMode } from './FundingModal';

/**
 * The `DEPOSIT` / `WITHDRAW` pair in the header chrome, as on Aster and Hyperliquid.
 *
 * Both open the same dialog on the matching tab — one component owns the mode so the
 * dialog can switch between them without closing, which is what makes the pair feel like
 * two views of one thing rather than two unrelated screens.
 *
 * Rendered only when a wallet is connected. The dialog handles the disconnected case too,
 * but putting money controls in front of someone with no wallet is an invitation to a
 * dead end, and the connect button is right beside them.
 */
export function FundingButtons() {
  const { isConnected } = useAccount();
  const [mode, setMode] = useState<FundingMode | null>(null);

  if (!isConnected) return null;

  return (
    <>
      <div className="funding-buttons">
        <button type="button" onClick={() => setMode('deposit')} data-testid="deposit-button">
          Deposit
        </button>
        <button type="button" onClick={() => setMode('withdraw')} data-testid="withdraw-button">
          Withdraw
        </button>
      </div>
      <FundingModal
        open={mode !== null}
        mode={mode ?? 'deposit'}
        onClose={() => setMode(null)}
        onModeChange={setMode}
      />
    </>
  );
}
