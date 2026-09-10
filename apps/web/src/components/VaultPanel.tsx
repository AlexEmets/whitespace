'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useVault } from '@/hooks/useVault';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { VAULT_ADDRESS } from '@/lib/deployment';
import { formatMoney, parseHumanDecimal } from '@/lib/money';

/**
 * LP deposit/withdraw. The design calls for the honest async lifecycle: `requestDeposit`
 * -> (settlement, off this UI's control) -> `claimDeposit`. This panel never says
 * "Deposited" until `claimDeposit` itself succeeds against a CLAIMABLE settlement.
 */
export function VaultPanel() {
  const { address, isConnected } = useAccount();
  const erc20 = useErc20(VAULT_ADDRESS);
  const vault = useVault();

  const [depositInput, setDepositInput] = useState('');
  const [pendingSettlementId, setPendingSettlementId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [faucetPending, setFaucetPending] = useState(false);

  const depositStatus = vault.useDepositStatus(pendingSettlementId);

  const depositRaw = (() => {
    try {
      return depositInput.trim() ? parseHumanDecimal(depositInput, COLLATERAL_DECIMALS) : 0n;
    } catch {
      return null;
    }
  })();

  const needsApproval = depositRaw !== null && depositRaw > 0n && erc20.allowance < depositRaw;

  /**
   * The vault pulls the deposit with `transferFrom`, so a request for more USDW than the
   * wallet holds reverts inside the token with `ERC20InsufficientBalance` — on chain,
   * after the gas is spent, with a message no wallet renders legibly. The order-entry form
   * has always blocked this; this panel did not, and a real deposit of 1,000 USDW from a
   * wallet holding 0 failed exactly that way. Cheaper to refuse here.
   */
  const insufficientBalance = depositRaw !== null && depositRaw > 0n && erc20.balance < depositRaw;

  async function handleFaucet() {
    setError(null);
    setMessage(null);
    setFaucetPending(true);
    try {
      await erc20.claimFaucet();
      await erc20.refetchBalance();
      setMessage('Testnet USDW claimed from the faucet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFaucetPending(false);
    }
  }

  async function handleApprove() {
    if (depositRaw === null) return;
    setError(null);
    try {
      await erc20.approve(depositRaw);
      await erc20.refetchAllowance();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRequestDeposit() {
    if (depositRaw === null || depositRaw <= 0n || insufficientBalance) return;
    setError(null);
    setMessage(null);
    try {
      const { settlementId } = await vault.requestDeposit(depositRaw);
      setPendingSettlementId(settlementId);
      setMessage(`Deposit requested (settlement #${settlementId}). Waiting for settlement before it can be claimed.`);
      await erc20.refetchBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClaim() {
    if (pendingSettlementId === null) return;
    setError(null);
    try {
      await vault.claimDeposit(pendingSettlementId);
      setMessage('Deposit claimed — vault shares credited.');
      setPendingSettlementId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!isConnected) return <p>Connect your wallet to deposit or withdraw.</p>;

  return (
    <div className="vault-panel" data-testid="vault-panel">
      <div data-testid="vault-usdw-balance">Wallet balance: {formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</div>
      {/* The pending state is not decoration. `claimFaucet` waits for its receipt (so the
          balance it then refetches is the post-mint one), which on this chain is several
          seconds of a button that used to look completely inert — indistinguishable from a
          click that never registered, and the reason a claim that silently never reached
          the wallet looked identical to one that did. */}
      <button type="button" data-testid="faucet-button" onClick={handleFaucet} disabled={faucetPending}>
        {faucetPending ? 'Claiming… confirm in your wallet' : 'Get testnet USDW'}
      </button>
      {/* The two buttons on this panel do opposite things to your balance, and their
          labels do not say so. "Request deposit" was read as "request USDW" and submitted
          from an empty wallet; naming the direction of each is what prevents that. */}
      <p className="vault-hint">
        Mints 1,000 USDW to your wallet, once per 24h. Depositing below sends USDW the other
        way — into the LP vault.
      </p>

      <label>
        Deposit amount (USDW)
        <input
          data-testid="deposit-input"
          inputMode="decimal"
          placeholder="0.00"
          value={depositInput}
          onChange={(e) => setDepositInput(e.target.value)}
        />
      </label>

      {needsApproval ? (
        <button type="button" data-testid="vault-approve-button" onClick={handleApprove}>
          Approve USDW
        </button>
      ) : (
        <button
          type="button"
          data-testid="request-deposit-button"
          disabled={depositRaw === null || depositRaw <= 0n || insufficientBalance}
          onClick={handleRequestDeposit}
        >
          Request deposit
        </button>
      )}

      {insufficientBalance ? (
        <p role="alert" className="error-text" data-testid="vault-insufficient-balance">
          You hold {formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW but this deposit needs{' '}
          {formatMoney(depositRaw ?? 0n, COLLATERAL_DECIMALS)}. Use “Get testnet USDW” above first — depositing is a
          transfer into the LP vault, not a way to obtain USDW.
        </p>
      ) : null}

      {pendingSettlementId !== null ? (
        <div data-testid="deposit-settlement-status" role="status">
          Settlement #{pendingSettlementId}: <strong>{depositStatus.status}</strong>
          {depositStatus.status === 'CLAIMABLE' ? (
            <button type="button" data-testid="claim-deposit-button" onClick={handleClaim}>
              Claim deposit
            </button>
          ) : null}
          {depositStatus.status === 'PENDING' ? <span> — not settled yet, this is expected to take a while.</span> : null}
        </div>
      ) : null}

      {message ? (
        <p role="status" data-testid="vault-message">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="error-text" data-testid="vault-error">
          {error}
        </p>
      ) : null}

      <p className="hint">Connected as {address}</p>
    </div>
  );
}
