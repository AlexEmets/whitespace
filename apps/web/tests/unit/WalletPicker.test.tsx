import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Connector } from 'wagmi';
import { WalletPicker } from '@/components/WalletPicker';

function fakeConnector(id: string, name: string, icon?: string): Connector {
  return { uid: `uid:${id}`, id, name, icon, type: 'injected' } as unknown as Connector;
}

const GENERIC = fakeConnector('injected', 'Injected');
const METAMASK = fakeConnector('io.metamask', 'MetaMask', 'data:image/svg+xml;base64,TU0=');
const TRUST = fakeConnector('com.trustwallet.app', 'Trust Wallet', 'data:image/svg+xml;base64,VFc=');

const connectMock = vi.fn();
const resetMock = vi.fn();

let connectors: Connector[] = [];
let connectError: Error | null = null;
let isPending = false;
let isConnected = false;

vi.mock('wagmi', () => ({
  useConnect: () => ({ connectors, connect: connectMock, isPending, error: connectError, reset: resetMock }),
  useAccount: () => ({ isConnected }),
}));

beforeEach(() => {
  connectMock.mockClear();
  resetMock.mockClear();
  connectors = [GENERIC, METAMASK, TRUST];
  connectError = null;
  isPending = false;
  isConnected = false;
});

describe('<WalletPicker>', () => {
  it('renders nothing while closed', () => {
    render(<WalletPicker open={false} onClose={vi.fn()} />);

    expect(screen.queryByTestId('wallet-picker')).not.toBeInTheDocument();
  });

  it('connects the wallet the trader actually clicked', () => {
    render(<WalletPicker open onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('wallet-option-metamask'));

    // Before this component existed the app connected `connectors[0]` — the generic
    // injected connector, which on a machine with Trust installed is Trust. Asserting the
    // exact connector, not just that connect() ran, is what makes this a regression test.
    expect(connectMock).toHaveBeenCalledWith({ connector: METAMASK });
    expect(connectMock).not.toHaveBeenCalledWith({ connector: GENERIC });
  });

  it('offers Trust separately from MetaMask', () => {
    render(<WalletPicker open onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('wallet-option-trust'));

    expect(connectMock).toHaveBeenCalledWith({ connector: TRUST });
  });

  it('points at the download page for a wallet that is not installed', () => {
    connectors = [GENERIC, METAMASK];
    render(<WalletPicker open onClose={vi.fn()} />);

    expect(screen.queryByTestId('wallet-option-trust')).not.toBeInTheDocument();
    expect(screen.getByTestId('wallet-install-trust')).toHaveAttribute(
      'href',
      'https://trustwallet.com/download',
    );
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<WalletPicker open onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked but not when the dialog is', () => {
    const onClose = vi.fn();
    render(<WalletPicker open onClose={onClose} />);

    fireEvent.mouseDown(screen.getByTestId('wallet-picker'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId('wallet-picker-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('replaces a raw provider rejection with a readable line, under the row that failed', () => {
    const { rerender } = render(<WalletPicker open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('wallet-option-metamask'));

    connectError = new Error(
      'User rejected the request.\n\nDetails: MetaMask Tx Signature: User denied\nVersion: viem@2.21.0',
    );
    rerender(<WalletPicker open onClose={vi.fn()} />);

    expect(screen.getByTestId('wallet-picker-error')).toHaveTextContent('Request rejected in the wallet.');
  });

  it('closes itself once a connection lands', () => {
    const onClose = vi.fn();
    const { rerender } = render(<WalletPicker open onClose={onClose} />);

    isConnected = true;
    rerender(<WalletPicker open onClose={onClose} />);

    expect(onClose).toHaveBeenCalled();
  });
});
