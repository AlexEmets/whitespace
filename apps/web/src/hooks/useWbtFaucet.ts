'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/** What the server-side faucet sends per claim, and how often it allows one. Mirrors
 * FAUCET_WBT_AMOUNT / FAUCET_COOLDOWN_HOURS in services/api/src/faucet.ts — stated in the
 * UI so the cooldown refusal reads as the cadence it is, not as a broken faucet. */
export const FAUCET_WBT_AMOUNT = '0.3';
export const FAUCET_WBT_COOLDOWN_HOURS = 24;

export interface WbtFaucetState {
  /** Sends WBT to `address`. Resolves true only when the funding tx was broadcast. */
  request: () => Promise<boolean>;
  /** True from the click until the server answers. */
  pending: boolean;
  /** The funding transaction hash, set only after a claim that broadcast. */
  txHash: string | null;
  /** Set by the most recent claim; cleared when the next one starts. */
  error: string | null;
  /** Seconds until this wallet/IP may claim again, when the last decline was a cooldown. */
  retryAfterSeconds: number | null;
}

/**
 * The WBT faucet's request/result/error state machine, mirroring useFaucet's shape so the
 * two claim panels behave identically.
 *
 * WHY THIS IS A SERVER CALL, NOT A WALLET TRANSACTION. WBT is the chain's native gas coin
 * and a wallet holding zero of it cannot sign anything — so unlike USDW's `claim()`, this
 * cannot be a transaction the visitor signs. It is a POST to services/api, which sends the
 * WBT from a funded server wallet. There is nothing for the wallet to confirm; the button
 * is armed the moment an address is connected.
 *
 * A declined claim (cooldown, out-of-funds, an unconfigured faucet) is not an exception —
 * the API returns it as a body with `ok: false` and a message, which is surfaced verbatim.
 * Only a network-level failure (API unreachable) throws, and it gets its own message so a
 * dropped connection is not misread as "already claimed".
 */
export function useWbtFaucet(address: string | undefined): WbtFaucetState {
  const [pending, setPending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  async function request(): Promise<boolean> {
    if (!address) return false;
    setError(null);
    setTxHash(null);
    setRetryAfterSeconds(null);
    setPending(true);
    try {
      const result = await api.requestWbt(address);
      if (result.ok && result.txHash) {
        setTxHash(result.txHash);
        return true;
      }
      setError(result.error ?? 'The WBT faucet could not complete your request.');
      if (result.retryAfterSeconds != null) setRetryAfterSeconds(result.retryAfterSeconds);
      return false;
    } catch {
      setError('Could not reach the faucet. Check your connection and try again.');
      return false;
    } finally {
      setPending(false);
    }
  }

  return { request, pending, txHash, error, retryAfterSeconds };
}
