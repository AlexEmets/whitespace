'use client';

import { useState } from 'react';
import type { Erc20Handle } from '@/hooks/useErc20';

/** What `USDW.claim()` mints per call, and how often the token allows it. Mirrors
 * contracts/src/mocks/USDW.sol — shown to the user so the faucet's refusal after a
 * second click reads as the cadence it is, not as a failure. */
export const FAUCET_MINT_USDW = 1_000_000_000n; // 1,000.00 USDW at 6 decimals
export const FAUCET_COOLDOWN_HOURS = 24;

export interface FaucetState {
  claim: () => Promise<boolean>;
  /** True from the click until the receipt has been mined AND the balance refetched. */
  pending: boolean;
  /** Set only by the most recent claim; cleared when the next one starts. */
  error: string | null;
  /** True after a claim that mined. Cleared when the next claim starts. */
  claimed: boolean;
}

/**
 * The faucet's pending/error/refetch state machine, in one place.
 *
 * `claimFaucet` itself has always been single (useErc20.ts) — what was duplicated was
 * everything around it: VaultPanel carried a `faucetPending` boolean plus its own
 * message/error strings, while OpenPositionForm folded the same three states into its
 * `SubmitState` union. Two copies, two shapes, and any fix to one silently left the
 * other behind.
 *
 * Takes the caller's existing `Erc20Handle` rather than constructing its own. A second
 * independent balance read would refetch on its own schedule and disagree with the one
 * the component already renders — for a few seconds right after a mint, which is the one
 * moment the user is watching that number.
 *
 * `pending` deliberately spans the refetch as well as the transaction. `claimFaucet`
 * waits for its receipt (see useErc20.ts), so releasing the button at resolution would
 * re-enable it while the displayed balance was still the pre-mint one.
 */
export function useFaucet(erc20: Erc20Handle): FaucetState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  async function claim(): Promise<boolean> {
    setError(null);
    setClaimed(false);
    setPending(true);
    try {
      await erc20.claimFaucet();
      await erc20.refetchBalance();
      setClaimed(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  return { claim, pending, error, claimed };
}
