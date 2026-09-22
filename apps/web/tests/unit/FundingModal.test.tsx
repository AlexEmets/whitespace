import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { maxUint256 } from 'viem';
import { FundingModal } from '@/components/FundingModal';

/**
 * The deposit balance guard here is a regression test carried over from VaultPanel when
 * the controls moved into this dialog. It was written after a real failed transaction on
 * Whitechain 1874: `0x7961ccfc…` — `requestDeposit(1000000000)` from a wallet holding 0
 * USDW, reverting inside the token with `ERC20InsufficientBalance(sender, 0, 1000000000)`
 * after the gas was spent. Moving a control must not lose the guard on it.
 *
 * The withdraw side gets the same guard for the same reason: `requestWithdraw` moves the
 * caller's shares with `_transfer` (OstiumVault.sol:475), which reverts identically when
 * the wallet does not hold them.
 */

const requestDepositMock = vi.fn(async () => ({ hash: '0xabc' as const, settlementId: 7 }));
const requestWithdrawMock = vi.fn(async () => ({ hash: '0xdef' as const, settlementId: 9 }));
const claimDepositMock = vi.fn(async () => '0x1' as const);
const claimWithdrawMock = vi.fn(async () => '0x2' as const);
const cancelDepositMock = vi.fn(async () => '0x3' as const);
const cancelWithdrawMock = vi.fn(async () => '0x4' as const);
const reclaimDepositMock = vi.fn(async () => '0x5' as const);
const reclaimWithdrawMock = vi.fn(async () => '0x6' as const);
const approveMock = vi.fn(async () => '0x7' as const);

let balanceState = 0n;
let allowanceState = 10_000_000_000n;
let sharesState = 0n;
let depositStatusState = 'NONE';
let withdrawStatusState = 'NONE';

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
    claimFaucet: vi.fn(async () => {}),
    isWritePending: false,
  }),
}));

vi.mock('@/hooks/useVault', () => ({
  useVault: () => ({
    requestDeposit: requestDepositMock,
    claimDeposit: claimDepositMock,
    requestWithdraw: requestWithdrawMock,
    claimWithdraw: claimWithdrawMock,
    cancelRequestDeposit: cancelDepositMock,
    cancelRequestWithdraw: cancelWithdrawMock,
    reclaimDeposit: reclaimDepositMock,
    reclaimWithdraw: reclaimWithdrawMock,
    useDepositStatus: () => ({ status: depositStatusState }),
    useWithdrawStatus: () => ({ status: withdrawStatusState }),
    isPending: false,
  }),
  useVaultShares: () => ({ shares: sharesState, refetch: vi.fn(async () => {}) }),
  useVaultTvl: () => ({ tvl: 0n, loading: false }),
}));

/** The dialog is a portal behind a `mounted` flag, and `mode` is owned by the parent —
 * both of which a caller has to reproduce for the tabs to actually switch. */
function renderModal(mode: 'deposit' | 'withdraw' = 'deposit') {
  const onModeChange = vi.fn();
  const utils = render(
    <FundingModal open mode={mode} onClose={vi.fn()} onModeChange={onModeChange} />,
  );
  return { ...utils, onModeChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  balanceState = 0n;
  allowanceState = 10_000_000_000n;
  sharesState = 0n;
  depositStatusState = 'NONE';
  withdrawStatusState = 'NONE';
});

describe('<FundingModal> deposit', () => {
  it('refuses a deposit larger than the wallet balance instead of letting it revert on chain', () => {
    balanceState = 0n;
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });

    expect(screen.getByTestId('funding-insufficient')).toBeInTheDocument();
    expect(screen.getByTestId('funding-request')).toBeDisabled();

    fireEvent.click(screen.getByTestId('funding-request'));
    expect(requestDepositMock).not.toHaveBeenCalled();
  });

  it('names both numbers so the shortfall is obvious', () => {
    balanceState = 250_000_000n; // 250.00 USDW
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });

    const alert = screen.getByTestId('funding-insufficient');
    expect(alert).toHaveTextContent('250.00');
    expect(alert).toHaveTextContent('1,000.00');
  });

  it('submits the exact raw amount for a deposit the wallet can cover', async () => {
    balanceState = 1_000_000_000n;
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });

    expect(screen.queryByTestId('funding-insufficient')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('funding-request'));

    await waitFor(() => expect(requestDepositMock).toHaveBeenCalledWith(1_000_000_000n));
  });

  /**
   * The vault is a second spender, so its allowance is a second, independent record — an
   * infinite approval granted to TradingStorage by the terminal does nothing here. What
   * this shares with the terminal is the shape: the approval rides inside the primary
   * action rather than standing in front of it, and it is for MAX so a deposit larger
   * than the last one does not demand a fresh one.
   */
  it('approves inside the deposit request rather than behind a separate button', async () => {
    balanceState = 1_000_000_000n;
    allowanceState = 0n;
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });

    expect(screen.queryByTestId('funding-approve')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('funding-request'));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(maxUint256));
    expect(approveMock).not.toHaveBeenCalledWith(1_000_000_000n);
    await waitFor(() => expect(requestDepositMock).toHaveBeenCalledWith(1_000_000_000n));
    expect(approveMock.mock.invocationCallOrder[0]!).toBeLessThan(requestDepositMock.mock.invocationCallOrder[0]!);
  });

  it('does not approve again when the vault allowance already covers the deposit', async () => {
    balanceState = 1_000_000_000n;
    allowanceState = 10_000_000_000n;
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    await waitFor(() => expect(requestDepositMock).toHaveBeenCalled());
    expect(approveMock).not.toHaveBeenCalled();
  });

  /** The whole point of keeping the lifecycle: a mined `requestDeposit` is NOT a deposit. */
  it('reports the request as unsettled rather than as a completed deposit', async () => {
    balanceState = 1_000_000_000n;
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    const message = await screen.findByTestId('funding-message');
    expect(message).toHaveTextContent(/nothing has moved into your LP position yet/i);
    expect(message).not.toHaveTextContent(/deposited/i);
  });
});

describe('<FundingModal> withdraw', () => {
  /** Withdrawing moves shares the vault already holds — there is no ERC-20 pull to
   * authorise, so an approval on this path would be a transaction that buys nothing. */
  it('never approves, however short the collateral allowance is', async () => {
    sharesState = 1_000_000_000n;
    allowanceState = 0n;
    renderModal('withdraw');
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    await waitFor(() => expect(requestWithdrawMock).toHaveBeenCalled());
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('is denominated in shares, not USDW, and reads the share balance', () => {
    sharesState = 400_000_000n; // 400.00 shares
    balanceState = 0n; // no USDW — must not be what AVAIL. reports here
    renderModal('withdraw');

    const avail = screen.getByTestId('funding-available');
    expect(avail).toHaveTextContent('400.00');
    expect(avail).toHaveTextContent('SHARES');
  });

  it('refuses a withdrawal of more shares than the wallet holds', () => {
    sharesState = 100_000_000n;
    renderModal('withdraw');
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '500' } });

    expect(screen.getByTestId('funding-insufficient')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('funding-request'));
    expect(requestWithdrawMock).not.toHaveBeenCalled();
  });

  it('submits requestWithdraw with the raw share amount', async () => {
    sharesState = 500_000_000n;
    renderModal('withdraw');
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    await waitFor(() => expect(requestWithdrawMock).toHaveBeenCalledWith(500_000_000n));
  });
});

describe('<FundingModal> settlement lifecycle', () => {
  /**
   * Each status accepts exactly one call. `claimWithdraw` reverts unless CLAIMABLE
   * (OstiumVault.sol:532) and `cancelRequest*` only in PENDING (:481, :492), so offering
   * the wrong button is offering a guaranteed revert.
   */
  it('offers cancel — and only cancel — while the request is PENDING', async () => {
    balanceState = 1_000_000_000n;
    depositStatusState = 'PENDING';
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    await screen.findByTestId('funding-settlement');
    expect(screen.getByTestId('funding-settlement-status')).toHaveTextContent('PENDING');
    expect(screen.getByTestId('funding-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('funding-claim')).not.toBeInTheDocument();
    expect(screen.queryByTestId('funding-reclaim')).not.toBeInTheDocument();
  });

  it('cancels with the settlement id AND the amount originally requested', async () => {
    balanceState = 1_000_000_000n;
    depositStatusState = 'PENDING';
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    fireEvent.click(await screen.findByTestId('funding-cancel'));
    // cancelRequestDeposit(uint32 settlementId, uint256 assets) — both, not just the id.
    await waitFor(() => expect(cancelDepositMock).toHaveBeenCalledWith(7, 1_000_000_000n));
  });

  it('offers claim when the settlement is CLAIMABLE', async () => {
    balanceState = 1_000_000_000n;
    depositStatusState = 'CLAIMABLE';
    renderModal();
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    fireEvent.click(await screen.findByTestId('funding-claim'));
    await waitFor(() => expect(claimDepositMock).toHaveBeenCalledWith(7));
  });

  /**
   * The state that had no control at all before this change. A settlement that ran and
   * did not fill the request (`totalSharesToWithdraw == 0`, OstiumVault.sol:590) left the
   * user with funds in the contract and nothing in the product to act on them with.
   */
  it('offers reclaim — not claim — when the settlement did not fill the request', async () => {
    sharesState = 500_000_000n;
    withdrawStatusState = 'RECLAIMABLE';
    renderModal('withdraw');
    fireEvent.change(screen.getByTestId('funding-amount-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('funding-request'));

    await screen.findByTestId('funding-settlement');
    expect(screen.queryByTestId('funding-claim')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('funding-reclaim'));
    await waitFor(() => expect(reclaimWithdrawMock).toHaveBeenCalledWith(9));
  });
});
