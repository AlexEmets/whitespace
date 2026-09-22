import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { maxUint256 } from 'viem';
import { FaucetPanel } from '@/components/FaucetPanel';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';

const claimFaucetMock = vi.fn(async () => {});
const refetchBalanceMock = vi.fn(async () => {});
const approveMock = vi.fn(async () => {});
const refetchAllowanceMock = vi.fn(async () => {});

let balanceState = 0n;
let allowanceState = 0n;
let isConnected = true;
/** Which contract the panel names as spender — see the arming test. */
const erc20Spenders: (string | undefined)[] = [];

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', isConnected }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: (spender?: string) => {
    erc20Spenders.push(spender);
    return {
      balance: balanceState,
      allowance: allowanceState,
      hasSpender: Boolean(spender),
      refetchBalance: refetchBalanceMock,
      refetchAllowance: refetchAllowanceMock,
      approve: approveMock,
      claimFaucet: claimFaucetMock,
      isWritePending: false,
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  erc20Spenders.length = 0;
  balanceState = 0n;
  allowanceState = 0n;
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

  /**
   * The faucet is where a wallet is set up, so it is where the trading allowance is set
   * up too. Arming here is what makes the terminal a single confirmation: a wallet that
   * came through this page reaches the order form already allowed to trade and never
   * meets an approval step at all.
   *
   * The spender must be TradingStorage — it is the contract that runs `safeTransferFrom`
   * on the collateral (OstiumTradingStorage.sol:486), so an allowance granted to anything
   * else is a transaction that authorises nothing.
   */
  it('arms the trading allowance with the mint, so the terminal needs one confirmation', async () => {
    allowanceState = 0n;
    render(<FaucetPanel />);
    expect(erc20Spenders).toContain(TRADING_STORAGE_ADDRESS);

    fireEvent.click(screen.getByTestId('faucet-panel-button'));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(maxUint256));
    expect(claimFaucetMock.mock.invocationCallOrder[0]!).toBeLessThan(approveMock.mock.invocationCallOrder[0]!);
  });

  it('does not re-arm an allowance that already covers what the faucet mints', async () => {
    allowanceState = maxUint256;
    render(<FaucetPanel />);

    fireEvent.click(screen.getByTestId('faucet-panel-button'));

    await waitFor(() => expect(claimFaucetMock).toHaveBeenCalled());
    expect(approveMock).not.toHaveBeenCalled();
  });

  /**
   * A rejected approval leaves real minted tokens in the wallet, so reporting the claim
   * as failed would be a lie about where the USDW went. Nor is it silent: the two legs
   * had different outcomes and the panel says so, because "Minted." on its own would let
   * the trader believe they are set up when the terminal is about to ask again.
   */
  it('reports the mint as done and the allowance as not granted when only that leg fails', async () => {
    allowanceState = 0n;
    approveMock.mockRejectedValueOnce(new Error('User rejected the request.'));
    render(<FaucetPanel />);

    fireEvent.click(screen.getByTestId('faucet-panel-button'));

    expect(await screen.findByTestId('faucet-panel-success')).toBeInTheDocument();
    expect(await screen.findByTestId('faucet-panel-error')).toHaveTextContent(
      /allowance was not granted.*first order will ask/i,
    );
  });
});
