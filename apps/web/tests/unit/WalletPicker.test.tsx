import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Connector } from 'wagmi';
import { WalletPicker } from '@/components/WalletPicker';

/** The EIP-1193 objects the connectors hand back. Identity is what the hook compares, so
 *  GENERIC deliberately shares MetaMask's — that is the real shape of a browser where
 *  MetaMask won the race for window.ethereum and also announced itself. */
const MM_PROVIDER = { isMetaMask: true };
const TW_PROVIDER = { isMetaMask: true, isTrust: true };

function fakeConnector(id: string, name: string, icon: string | undefined, provider: unknown): Connector {
  return { uid: `uid:${id}`, id, name, icon, type: 'injected', getProvider: async () => provider } as unknown as Connector;
}

const METAMASK = fakeConnector('io.metamask', 'MetaMask', 'data:image/svg+xml;base64,TU0=', MM_PROVIDER);
const TRUST = fakeConnector('com.trustwallet.app', 'Trust Wallet', 'data:image/svg+xml;base64,VFc=', TW_PROVIDER);
const GENERIC = fakeConnector('injected', 'Injected', undefined, MM_PROVIDER);

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

/** The hook resolves providers asynchronously to compare them, so let that settle before
 *  asserting — otherwise every test races the effect and React logs act() warnings. */
async function renderPicker(props: { open: boolean; onClose: () => void }) {
  const utils = render(<WalletPicker {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe('<WalletPicker>', () => {
  it('renders nothing while closed', async () => {
    await renderPicker({ open: false, onClose: vi.fn() });

    expect(screen.queryByTestId('wallet-picker')).not.toBeInTheDocument();
  });

  it('connects the wallet the trader actually clicked', async () => {
    await renderPicker({ open: true, onClose: vi.fn() });

    fireEvent.click(screen.getByTestId('wallet-option-metamask'));

    // Before this component existed the app connected `connectors[0]` — the generic
    // injected connector, which on a machine with Trust installed is Trust. Asserting the
    // exact connector, not just that connect() ran, is what makes this a regression test.
    expect(connectMock).toHaveBeenCalledWith({ connector: METAMASK });
    expect(connectMock).not.toHaveBeenCalledWith({ connector: GENERIC });
  });

  it('offers Trust separately from MetaMask', async () => {
    await renderPicker({ open: true, onClose: vi.fn() });

    fireEvent.click(screen.getByTestId('wallet-option-trust'));

    expect(connectMock).toHaveBeenCalledWith({ connector: TRUST });
  });

  it('does not add a duplicate row for the wallet that owns window.ethereum', async () => {
    await renderPicker({ open: true, onClose: vi.fn() });

    expect(screen.queryByTestId('wallet-option-injected')).not.toBeInTheDocument();
  });

  it('offers window.ethereum as its own row when no announced wallet wraps it', async () => {
    // Trust here is old enough that it never announces: it exists only at window.ethereum,
    // while a newer MetaMask announces itself. Hiding the generic row would strand it.
    const silentTrust = fakeConnector('injected', 'Injected', undefined, TW_PROVIDER);
    connectors = [silentTrust, METAMASK];
    await renderPicker({ open: true, onClose: vi.fn() });

    const row = screen.getByTestId('wallet-option-injected');
    expect(row).toHaveTextContent('Trust Wallet');

    fireEvent.click(row);
    expect(connectMock).toHaveBeenCalledWith({ connector: silentTrust });
  });

  it('points at the download page for a wallet that is not installed', async () => {
    connectors = [GENERIC, METAMASK];
    await renderPicker({ open: true, onClose: vi.fn() });

    expect(screen.queryByTestId('wallet-option-trust')).not.toBeInTheDocument();
    expect(screen.getByTestId('wallet-install-trust')).toHaveAttribute(
      'href',
      'https://trustwallet.com/download',
    );
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await renderPicker({ open: true, onClose });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked but not when the dialog is', async () => {
    const onClose = vi.fn();
    await renderPicker({ open: true, onClose });

    fireEvent.mouseDown(screen.getByTestId('wallet-picker'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId('wallet-picker-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('replaces a raw provider rejection with a readable line, under the row that failed', async () => {
    const { rerender } = await renderPicker({ open: true, onClose: vi.fn() });
    fireEvent.click(screen.getByTestId('wallet-option-metamask'));

    connectError = new Error(
      'User rejected the request.\n\nDetails: MetaMask Tx Signature: User denied\nVersion: viem@2.21.0',
    );
    rerender(<WalletPicker open onClose={vi.fn()} />);

    expect(screen.getByTestId('wallet-picker-error')).toHaveTextContent('Request rejected in the wallet.');
  });

  it('closes itself once a connection lands', async () => {
    const onClose = vi.fn();
    const { rerender } = await renderPicker({ open: true, onClose });

    isConnected = true;
    rerender(<WalletPicker open onClose={onClose} />);

    expect(onClose).toHaveBeenCalled();
  });
});
