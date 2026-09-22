'use client';

import { useState } from 'react';
import { maxUint256 } from 'viem';
import type { Erc20Handle } from '@/hooks/useErc20';
import { describeTxError } from '@/lib/tx';

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

  /**
   * Grants the spender an unlimited allowance in the same gesture as the mint.
   *
   * This is what keeps the approval out of the terminal. The allowance transaction is
   * unavoidable — `OstiumTradingStorage` pulls collateral with `safeTransferFrom`
   * (OstiumTradingStorage.sol:486), there is no exchange-side balance to spend from, and
   * USDW is a plain OpenZeppelin ERC20 with no `permit` to sign instead. What IS avoidable
   * is meeting it at trade time: a wallet armed here reaches the order form already
   * allowed, and its first order is a single confirmation.
   *
   * Runs after the mint, never instead of it. Skipped outright when the caller named no
   * spender (`hasSpender`) — `approve` would throw — or when the existing allowance
   * already covers what this mint hands over.
   *
   * A rejected allowance is NOT a failed claim. The USDW is really in the wallet by then,
   * so `claimed` stays true and the message says what did and did not happen. Losing this
   * leg is safe: the order form still folds the approval into its own submit, which is the
   * backstop that makes arming an optimisation rather than a dependency.
   */
  async function armAllowance(): Promise<void> {
    if (!erc20.hasSpender || erc20.allowance >= FAUCET_MINT_USDW) return;
    try {
      await erc20.approve(maxUint256);
      await erc20.refetchAllowance();
    } catch {
      setError(
        'Minted — but the trading allowance was not granted. Your first order will ask for it again.',
      );
    }
  }

  async function claim(): Promise<boolean> {
    setError(null);
    setClaimed(false);
    setPending(true);
    try {
      await erc20.claimFaucet();
      await erc20.refetchBalance();
      setClaimed(true);
      await armAllowance();
      return true;
    } catch (err) {
      setError(describeTxError(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  return { claim, pending, error, claimed };
}
