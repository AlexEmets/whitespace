import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FaucetPage } from '@/components/FaucetPage';
import { COLLATERAL_ADDRESS } from '@/lib/deployment';

/**
 * /faucet exists so that "where do I get USDW" is a destination rather than a button
 * discovered by accident on a page about LP positions. These assertions are about that:
 * the claim control is here, and the page says what the token actually is before
 * offering it.
 */

let isConnected = true;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', isConnected }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: 0n,
    allowance: 0n,
    refetchBalance: vi.fn(async () => {}),
    refetchAllowance: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    claimFaucet: vi.fn(async () => {}),
    isWritePending: false,
  }),
}));

beforeEach(() => {
  isConnected = true;
});

describe('<FaucetPage>', () => {
  it('carries the claim control, which used to live on /vaults', () => {
    render(<FaucetPage />);
    expect(screen.getByTestId('faucet-panel')).toBeInTheDocument();
    expect(screen.getByTestId('faucet-panel-button')).toBeInTheDocument();
  });

  /** A token called USDW next to a leverage slider invites exactly one wrong assumption,
   * so the page states the absence of backing rather than leaving it to be inferred. */
  it('says what the token is not, not only what it is', () => {
    render(<FaucetPage />);
    const page = screen.getByTestId('faucet-page');

    expect(page).toHaveTextContent(/not a stablecoin and not redeemable/i);
    expect(page).toHaveTextContent(/uncapped, permissionless/i);
  });

  it('names the collateral contract it mints from', () => {
    render(<FaucetPage />);
    expect(screen.getByTestId('faucet-page').innerHTML).toContain(COLLATERAL_ADDRESS);
  });

  it('explains the disconnected state instead of showing a dead control', () => {
    isConnected = false;
    render(<FaucetPage />);

    expect(screen.getByTestId('account-state-disconnected')).toBeInTheDocument();
    expect(screen.queryByTestId('faucet-panel-button')).not.toBeInTheDocument();
  });

  /** The faucet is a plain mint, not the vault's request/settle/claim lifecycle. Saying
   * so here stops it being read as another thing that has to settle. */
  it('does not describe the mint as something that settles', () => {
    render(<FaucetPage />);
    expect(screen.getByTestId('faucet-page')).toHaveTextContent(/this one is immediate/i);
  });
});
