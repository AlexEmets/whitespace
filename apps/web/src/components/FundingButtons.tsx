'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { FundingModal, type FundingMode } from './FundingModal';

/**
 * A `DEPOSIT` / `WITHDRAW` pair wired to one `FundingModal`.
 *
 * The pair and the dialog are one unit: both buttons open the same dialog on their own
 * tab, and the dialog can switch between them without closing, which is what makes them
 * feel like two views of one thing rather than two screens. Keeping that wiring here
 * means `/portfolio` and `/vaults` do not each carry their own copy of the mode state —
 * two copies is how one of them ends up opening the wrong tab.
 *
 * `idPrefix` scopes the test ids per call site so a test can name the button it means.
 * `className` is the caller's, because the two contexts want different geometry: a
 * two-column grid on the portfolio funding card, an inline pair on the vault panel.
 */
export function FundingButtons({ idPrefix, className }: { idPrefix: string; className?: string }) {
  const { isConnected } = useAccount();
  const [mode, setMode] = useState<FundingMode | null>(null);

  // Money controls in front of someone with no wallet are an invitation to a dead end.
  // Both current call sites already sit inside a connected branch; this is the backstop
  // for the next one that does not.
  if (!isConnected) return null;

  return (
    <>
      <div className={className}>
        <button type="button" onClick={() => setMode('deposit')} data-testid={`${idPrefix}-deposit-button`}>
          Deposit
        </button>
        <button type="button" onClick={() => setMode('withdraw')} data-testid={`${idPrefix}-withdraw-button`}>
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
