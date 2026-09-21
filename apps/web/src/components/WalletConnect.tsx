'use client';

import { useCallback, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { useWalletOptions } from '@/hooks/useWalletOptions';
import { GENERIC_INJECTED_ID } from '@/lib/wallets';
import { WalletPicker } from './WalletPicker';

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletConnect() {
  const { address, isConnected, connector } = useAccount();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { connectable, genericInfo } = useWalletOptions();
  const [pickerOpen, setPickerOpen] = useState(false);

  // wagmi names the untargeted connector "Injected", which tells a trader nothing. When
  // that is what connected — a wallet too old to announce over EIP-6963 — fall back to
  // the vendor-flag label so the chip still says which wallet is signing.
  const walletName =
    connector?.id === GENERIC_INJECTED_ID ? (genericInfo?.name ?? connector.name) : connector?.name;

  /**
   * With one wallet there is no choice to make, so Connect goes straight to it rather
   * than opening a dialog holding a single row. The picker only appears once the browser
   * actually has competing wallets — which is the case this component exists for: before
   * it, `connectors[0]` silently resolved to whichever extension won the race for
   * `window.ethereum`, so a trader running both MetaMask and Trust could never reach
   * MetaMask.
   */
  const handleConnectClick = useCallback(() => {
    const only = connectable.length === 1 ? connectable[0] : undefined;
    if (only) {
      connect({ connector: only.connector });
      return;
    }
    setPickerOpen(true);
  }, [connectable, connect]);

  if (isConnected && address) {
    return (
      <div className="wallet-connect wallet-chip" data-testid="wallet-connected">
        {connector?.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={connector.icon} alt="" className="wallet-chip-icon" width={14} height={14} />
        ) : null}
        {walletName ? <span className="wallet-chip-name">{walletName}</span> : null}
        <span data-testid="wallet-address">{shortenAddress(address)}</span>
        <button type="button" onClick={() => disconnect()} data-testid="disconnect-button">
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <button
        type="button"
        className="connect-btn mono-upper"
        data-testid="connect-wallet-button"
        disabled={isPending}
        onClick={handleConnectClick}
      >
        {isPending ? 'Connecting…' : 'Connect'}
      </button>
      {/* The picker owns its own error line. This one covers the fast path above, where
          a rejection would otherwise have nowhere to surface. */}
      {error && !pickerOpen ? (
        <span role="alert" className="error-text" data-testid="connect-error">
          {error.message.split('\n')[0]}
        </span>
      ) : null}
      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}
