import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FaucetPanel } from '@/components/FaucetPanel';

const claimFaucetMock = vi.fn(async () => {});
const refetchBalanceMock = vi.fn(async () => {});

let balanceState = 0n;
let isConnected = true;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', isConnected }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: balanceState,
    allowance: 0n,
    refetchBalance: refetchBalanceMock,
    refetchAllowance: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    claimFaucet: claimFaucetMock,
    isWritePending: false,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  balanceState = 0n;
  isConnected = true;
});

describe('<FaucetPanel>', () => {
  it('states what the faucet mints and how often, which nothing in the product used to say', () => {
    render(<FaucetPanel />);
    expect(screen.getByTestId('faucet-mint-amount')).toHaveTextContent('1,000.00 USDW');
    expect(screen.getByTestId('faucet-panel')).toHaveTextContent(/once per 24h, per address/i);
  });

  it('claims and refetches the balance, so the figure on screen is the post-mint one', async () => {
    render(<FaucetPanel />);
    fireEvent.click(screen.getByTestId('faucet-panel-button'));

    await waitFor(() => expect(claimFaucetMock).toHaveBeenCalled());
    expect(refetchBalanceMock).toHaveBeenCalled();
    expect(await screen.findByTestId('faucet-panel-success')).toBeInTheDocument();
  });

  /**
   * Carried over from VaultPanel's suite with the faucet. `claimFaucet` waits for its
   * receipt, which on this chain is several seconds of a button that would otherwise look
   * completely inert — indistinguishable from a click that never registered, and the
   * reason a claim that never reached the wallet looked identical to one that did.
   */
  it('shows progress, so a click on a slow confirmation is not mistaken for no click', async () => {
    let release: () => void = () => {};
    claimFaucetMock.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    render(<FaucetPanel />);

    fireEvent.click(screen.getByTestId('faucet-panel-button'));
    await waitFor(() => expect(screen.getByTestId('faucet-panel-button')).toBeDisabled());
    expect(screen.getByTestId('faucet-panel-button')).toHaveTextContent('Claiming');

    release();
    await waitFor(() => expect(screen.getByTestId('faucet-panel-button')).not.toBeDisabled());
  });

  it('surfaces a rejected claim instead of silently doing nothing', async () => {
    claimFaucetMock.mockRejectedValueOnce(new Error('User rejected the request.'));
    render(<FaucetPanel />);

    fireEvent.click(screen.getByTestId('faucet-panel-button'));

    expect(await screen.findByTestId('faucet-panel-error')).toHaveTextContent('User rejected the request.');
    expect(screen.queryByTestId('faucet-panel-success')).not.toBeInTheDocument();
  });

  it('does not offer a mint with no wallet to mint into', () => {
    isConnected = false;
    render(<FaucetPanel />);

    expect(screen.queryByTestId('faucet-panel-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('faucet-disconnected')).toBeInTheDocument();
  });
});
