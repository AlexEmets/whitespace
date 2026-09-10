import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VaultPanel } from '@/components/VaultPanel';

/**
 * Written after a real failed transaction on Whitechain 1874:
 * `0x7961ccfc…` — `requestDeposit(1000000000)` from a wallet holding 0 USDW, reverting
 * inside the token with `ERC20InsufficientBalance(sender, 0, 1000000000)` after the gas
 * was spent. The panel had no balance guard at all, so it submitted a deposit it could
 * see was impossible. The order-entry form has always refused this; this one did not.
 */

const requestDepositMock = vi.fn(async () => ({ hash: '0xabc' as const, settlementId: 1 }));
const claimFaucetMock = vi.fn(async () => {});
const approveMock = vi.fn(async () => {});

let balanceState = 0n;
let allowanceState = 10_000_000_000n;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', isConnected: true }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: balanceState,
    allowance: allowanceState,
    refetchBalance: vi.fn(async () => {}),
    refetchAllowance: vi.fn(async () => {}),
    approve: approveMock,
    claimFaucet: claimFaucetMock,
    isWritePending: false,
  }),
}));

vi.mock('@/hooks/useVault', () => ({
  useVault: () => ({
    requestDeposit: requestDepositMock,
    claimDeposit: vi.fn(async () => {}),
    useDepositStatus: () => ({ status: 'NONE' }),
  }),
}));

beforeEach(() => {
  requestDepositMock.mockClear();
  claimFaucetMock.mockClear();
  balanceState = 0n;
  allowanceState = 10_000_000_000n;
});

describe('<VaultPanel>', () => {
  it('refuses a deposit larger than the wallet balance instead of letting it revert on chain', () => {
    balanceState = 0n;
    render(<VaultPanel />);
    fireEvent.change(screen.getByTestId('deposit-input'), { target: { value: '1000' } });

    expect(screen.getByTestId('vault-insufficient-balance')).toBeInTheDocument();
    expect(screen.getByTestId('request-deposit-button')).toBeDisabled();

    fireEvent.click(screen.getByTestId('request-deposit-button'));
    expect(requestDepositMock).not.toHaveBeenCalled();
  });

  it('names both numbers so the shortfall is obvious', () => {
    balanceState = 250_000_000n; // 250.00 USDW
    render(<VaultPanel />);
    fireEvent.change(screen.getByTestId('deposit-input'), { target: { value: '1000' } });

    const alert = screen.getByTestId('vault-insufficient-balance');
    expect(alert).toHaveTextContent('250.00');
    expect(alert).toHaveTextContent('1,000.00');
  });

  it('allows a deposit the wallet can actually cover', async () => {
    balanceState = 1_000_000_000n;
    render(<VaultPanel />);
    fireEvent.change(screen.getByTestId('deposit-input'), { target: { value: '1000' } });

    expect(screen.queryByTestId('vault-insufficient-balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('request-deposit-button')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('request-deposit-button'));
    await waitFor(() => expect(requestDepositMock).toHaveBeenCalledWith(1_000_000_000n));
  });

  it('shows faucet progress, so a click on a slow confirmation is not mistaken for no click', async () => {
    let release: () => void = () => {};
    claimFaucetMock.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    render(<VaultPanel />);

    fireEvent.click(screen.getByTestId('faucet-button'));
    await waitFor(() => expect(screen.getByTestId('faucet-button')).toBeDisabled());
    expect(screen.getByTestId('faucet-button')).toHaveTextContent('Claiming');

    release();
    await waitFor(() => expect(screen.getByTestId('faucet-button')).not.toBeDisabled());
  });
});
