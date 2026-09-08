'use client';

import { useAccount, useConnect, useDisconnect } from 'wagmi';

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="wallet-connect wallet-chip" data-testid="wallet-connected">
        <span data-testid="wallet-address">{shortenAddress(address)}</span>
        <button type="button" onClick={() => disconnect()} data-testid="disconnect-button">
          Disconnect
        </button>
      </div>
    );
  }

  const connector = connectors[0];

  return (
    <div>
      <button
        type="button"
        className="connect-btn mono-upper"
        data-testid="connect-wallet-button"
        disabled={!connector || isPending}
        onClick={() => connector && connect({ connector })}
      >
        {isPending ? 'Connecting…' : 'Connect'}
      </button>
      {error ? (
        <span role="alert" className="error-text" data-testid="connect-error">
          {error.message}
        </span>
      ) : null}
    </div>
  );
}
