'use client';

import { useChainGuard } from '@/hooks/useChainGuard';
import { CHAIN_ID } from '@/lib/config';

/** Banner + switch prompt shown whenever a connected wallet is on the wrong chain. Does
 * not block reading the app (markets/candles are chain-agnostic reads via the API), only
 * signals that any wallet-signed action will fail until the trader switches. */
export function ChainGuard() {
  const { isConnected, isWrongChain, isSwitching, requestSwitch, switchError } = useChainGuard();

  if (!isConnected || !isWrongChain) return null;

  return (
    <div role="alert" className="banner banner-warning" data-testid="chain-guard-banner">
      <span>
        Wrong network. This app trades on Whitechain testnet ({CHAIN_ID}); your wallet is
        connected elsewhere.
      </span>
      <button type="button" onClick={() => requestSwitch()} disabled={isSwitching} data-testid="switch-chain-button">
        {isSwitching ? 'Switching…' : `Switch to ${CHAIN_ID}`}
      </button>
      {switchError ? <span className="error-text">{switchError.message}</span> : null}
    </div>
  );
}
