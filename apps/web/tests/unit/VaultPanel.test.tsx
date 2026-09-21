import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VaultPanel } from '@/components/VaultPanel';

/**
 * VaultPanel is now the LP *position* view — the deposit/withdraw controls moved into
 * FundingModal, and the guards that used to be tested here moved with them (see
 * FundingModal.test.tsx, which keeps the `0x7961ccfc…` balance-guard regression).
 * What is left to assert is that this panel reports position state honestly.
 */

let balanceState = 0n;
let sharesState = 0n;
let tvlState: bigint | null = 0n;
let isConnected = true;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x43Ac53c54EaE7E31b6c717FE17a8cE31ba2cB06B', isConnected }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useErc20', () => ({
  useErc20: () => ({
    balance: balanceState,
    allowance: 0n,
    refetchBalance: vi.fn(async () => {}),
    refetchAllowance: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    claimFaucet: vi.fn(async () => {}),
    isWritePending: false,
  }),
}));

vi.mock('@/hooks/useVault', () => ({
  useVault: () => ({
    requestDeposit: vi.fn(),
    claimDeposit: vi.fn(),
    requestWithdraw: vi.fn(),
    claimWithdraw: vi.fn(),
    cancelRequestDeposit: vi.fn(),
    cancelRequestWithdraw: vi.fn(),
    reclaimDeposit: vi.fn(),
    reclaimWithdraw: vi.fn(),
    useDepositStatus: () => ({ status: 'NONE' }),
    useWithdrawStatus: () => ({ status: 'NONE' }),
    isPending: false,
  }),
  useVaultShares: () => ({ shares: sharesState, refetch: vi.fn(async () => {}) }),
  useVaultTvl: () => ({ tvl: tvlState, loading: false }),
}));

beforeEach(() => {
  balanceState = 0n;
  sharesState = 0n;
  tvlState = 0n;
  isConnected = true;
});

describe('<VaultPanel>', () => {
  it('reports the wallet’s share position and balance', () => {
    sharesState = 1_250_000_000n; // 1,250.00 shares
    balanceState = 500_000_000n; // 500.00 USDW
    render(<VaultPanel />);

    expect(screen.getByTestId('vault-shares')).toHaveTextContent('1,250.00');
    expect(screen.getByTestId('vault-usdw-balance')).toHaveTextContent('500.00 USDW');
  });

  /** An unread TVL and an empty vault are different claims, and only one of them is a
   * number. The dash carries its reason on the title attribute rather than reading as
   * "the vault holds nothing". */
  it('distinguishes an unread TVL from a vault that is genuinely empty', () => {
    tvlState = null;
    const { rerender } = render(<VaultPanel />);
    expect(screen.getByTestId('vault-tvl')).toHaveTextContent('—');
    expect(screen.getByTestId('vault-tvl')).toHaveAttribute('title', expect.stringContaining('not been read'));

    tvlState = 0n;
    rerender(<VaultPanel />);
    expect(screen.getByTestId('vault-tvl')).toHaveTextContent('0.00 USDW');
    expect(screen.getByTestId('vault-tvl')).not.toHaveAttribute('title');
  });

  it('offers both funding directions from the vault page', () => {
    render(<VaultPanel />);
    expect(screen.getByTestId('vault-deposit-button')).toBeInTheDocument();
    expect(screen.getByTestId('vault-withdraw-button')).toBeInTheDocument();
  });

  it('asks for a wallet before reporting a position, rather than reporting a zero one', () => {
    isConnected = false;
    render(<VaultPanel />);

    expect(screen.getByTestId('vault-disconnected')).toBeInTheDocument();
    expect(screen.queryByTestId('vault-shares')).not.toBeInTheDocument();
  });
});
