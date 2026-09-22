'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { maxUint256 } from 'viem';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useVault, useVaultShares } from '@/hooks/useVault';
import type { VaultRequestStatus } from '@/lib/abi';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { VAULT_ADDRESS } from '@/lib/deployment';
import { formatMoney, parseHumanDecimal } from '@/lib/money';
import { Modal } from './Modal';
import styles from './FundingModal.module.css';

export type FundingMode = 'deposit' | 'withdraw';

/** A request that has been submitted and is now somewhere in the settlement lifecycle.
 * The amount is kept alongside the id because `cancelRequest*` takes both. */
interface PendingRequest {
  id: number;
  amountRaw: bigint;
}

/**
 * Deposit and withdraw, in the Aster/Hyperliquid button-pair shape the owner asked for —
 * over a vault that does not behave the way theirs do.
 *
 * On those venues a deposit credits an account balance in one transaction. Here it is a
 * *request*: `requestDeposit` -> a settlement runs, outside this UI's control ->
 * `claimDeposit`. So the buttons look like theirs and the panel behind them does not
 * flatten into "Deposited ✓" — it names which of the three states you are in, and refuses
 * to claim success until `claimDeposit` itself mines.
 *
 * Every live branch of `IOstiumVault.RequestStatus` gets a control:
 *
 *   PENDING      -> Cancel request   (`cancelRequest*`, which the contract permits only
 *                                     in PENDING — OstiumVault.sol:481, :492)
 *   CLAIMABLE    -> Claim            (`claim*`; reverts in any other state, :532)
 *   RECLAIMABLE  -> Reclaim          (`reclaim*`; the settlement ran and did not fill the
 *                                     request, :590-591)
 *
 * Before this, only CLAIMABLE had a button. A settlement landing RECLAIMABLE left the
 * user with funds in the contract and nothing in the product to act on them with.
 */
export function FundingModal({
  open,
  mode,
  onClose,
  onModeChange,
}: {
  open: boolean;
  mode: FundingMode;
  onClose: () => void;
  onModeChange: (mode: FundingMode) => void;
}) {
  const { isConnected } = useAccount();
  const erc20 = useErc20(VAULT_ADDRESS);
  const vault = useVault();
  const { shares, refetch: refetchShares } = useVaultShares();

  const [amountInput, setAmountInput] = useState('');
  const [deposit, setDeposit] = useState<PendingRequest | null>(null);
  const [withdraw, setWithdraw] = useState<PendingRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const depositStatus = vault.useDepositStatus(deposit?.id ?? null);
  const withdrawStatus = vault.useWithdrawStatus(withdraw?.id ?? null);

  const isDeposit = mode === 'deposit';

  // The two tabs are denominated in different things — USDW in, shares out — so carrying
  // a typed figure across the switch would silently reinterpret it. "500" meaning half a
  // thousand dollars and "500" meaning five hundred shares are not the same request.
  useEffect(() => {
    setAmountInput('');
    setError(null);
    setMessage(null);
  }, [mode]);

  const amountRaw = useMemo(() => {
    try {
      return amountInput.trim() ? parseHumanDecimal(amountInput, COLLATERAL_DECIMALS) : 0n;
    } catch {
      return null;
    }
  }, [amountInput]);

  const available = isDeposit ? erc20.balance : shares;
  const positive = amountRaw !== null && amountRaw > 0n;
  /**
   * Both directions revert on chain when the amount exceeds what the caller holds — the
   * deposit inside USDW's `transferFrom`, the withdraw inside the vault's own `_transfer`
   * — after the gas is spent and with a message no wallet renders legibly. A real
   * `requestDeposit(1000000000)` from a wallet holding 0 failed exactly that way
   * (tx 0x7961ccfc…). Cheaper to refuse here.
   */
  const insufficient = positive && amountRaw! > available;
  const needsApproval = isDeposit && positive && erc20.allowance < amountRaw!;

  async function run(label: string, fn: () => Promise<void>) {
    setError(null);
    setMessage(null);
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /**
   * The deposit's approval rides inside the request, the same shape the order form uses.
   *
   * The vault is a SECOND spender, so this is a second, independent allowance — the
   * infinite approval the terminal grants `TradingStorage` authorises nothing here, and
   * neither does arming at the faucet. A first deposit therefore costs two confirmations,
   * and every one after it costs one.
   *
   * For MAX, not `amountRaw`: approving the exact amount consumed the allowance on every
   * settlement, so each deposit larger than the last quietly demanded a fresh approval
   * transaction. Withdrawing needs none of this — it moves shares the vault already holds.
   */
  const handleRequest = () =>
    run('request', async () => {
      if (isDeposit) {
        if (needsApproval) {
          setBusy('approve');
          await erc20.approve(maxUint256);
          await erc20.refetchAllowance();
          setBusy('request');
        }
        const { settlementId } = await vault.requestDeposit(amountRaw!);
        setDeposit({ id: settlementId, amountRaw: amountRaw! });
        await erc20.refetchBalance();
        setMessage(`Deposit requested into settlement #${settlementId}. Nothing has moved into your LP position yet.`);
      } else {
        const { settlementId } = await vault.requestWithdraw(amountRaw!);
        setWithdraw({ id: settlementId, amountRaw: amountRaw! });
        await refetchShares();
        setMessage(`Withdrawal requested from settlement #${settlementId}. Your shares are held by the vault until it settles.`);
      }
      setAmountInput('');
    });

  const request = isDeposit ? deposit : withdraw;
  const status: VaultRequestStatus = isDeposit ? depositStatus.status : withdrawStatus.status;
  const clearRequest = () => (isDeposit ? setDeposit(null) : setWithdraw(null));

  const handleClaim = () =>
    run('claim', async () => {
      if (!request) return;
      if (isDeposit) {
        await vault.claimDeposit(request.id);
        await refetchShares();
        setMessage('Deposit claimed — vault shares credited.');
      } else {
        await vault.claimWithdraw(request.id);
        await erc20.refetchBalance();
        setMessage('Withdrawal claimed — USDW returned to your wallet.');
      }
      clearRequest();
    });

  const handleCancel = () =>
    run('cancel', async () => {
      if (!request) return;
      if (isDeposit) {
        await vault.cancelRequestDeposit(request.id, request.amountRaw);
        await erc20.refetchBalance();
      } else {
        await vault.cancelRequestWithdraw(request.id, request.amountRaw);
        await refetchShares();
      }
      setMessage('Request cancelled and returned to your wallet.');
      clearRequest();
    });

  const handleReclaim = () =>
    run('reclaim', async () => {
      if (!request) return;
      if (isDeposit) {
        await vault.reclaimDeposit(request.id);
        await erc20.refetchBalance();
      } else {
        await vault.reclaimWithdraw(request.id);
        await refetchShares();
      }
      setMessage('Reclaimed — the settlement did not fill this request, so it was returned.');
      clearRequest();
    });

  const unit = isDeposit ? 'USDW' : 'SHARES';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDeposit ? 'Deposit to vault' : 'Withdraw from vault'}
      testId="funding-modal"
      initialFocusRef={amountRef}
      footer={<>Requests settle asynchronously — see the lifecycle below.</>}
    >
      <div className={styles.body}>
        <div className={styles.tabs} role="tablist">
          {(['deposit', 'withdraw'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? styles.tabActive : styles.tab}
              onClick={() => onModeChange(m)}
              data-testid={`funding-tab-${m}`}
            >
              {m}
            </button>
          ))}
        </div>

        {!isConnected ? (
          <p className={styles.muted} data-testid="funding-disconnected">
            Connect a wallet to deposit or withdraw.
          </p>
        ) : (
          <>
            <div className={styles.fieldHead}>
              <span className="mono-upper">{isDeposit ? 'Amount' : 'Shares'}</span>
              <span className={styles.avail} data-testid="funding-available">
                AVAIL. {formatMoney(available, COLLATERAL_DECIMALS)} {unit}
              </span>
            </div>
            <div className={styles.inputWrap}>
              <input
                ref={amountRef}
                className={styles.input}
                data-testid="funding-amount-input"
                inputMode="decimal"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
              <span className={styles.suffix}>{unit}</span>
            </div>
            <button
              type="button"
              className={styles.maxButton}
              data-testid="funding-max"
              onClick={() => setAmountInput(formatMoney(available, COLLATERAL_DECIMALS, { grouping: false }))}
            >
              Max
            </button>

            {insufficient ? (
              <p className="error-text" role="alert" data-testid="funding-insufficient">
                You hold {formatMoney(available, COLLATERAL_DECIMALS)} {unit} but this needs{' '}
                {formatMoney(amountRaw ?? 0n, COLLATERAL_DECIMALS)}.
              </p>
            ) : null}

            <button
              type="button"
              className={styles.primary}
              data-testid="funding-request"
              onClick={handleRequest}
              disabled={!positive || insufficient || busy !== null}
            >
              {busy === 'approve'
                ? 'Approving USDW…'
                : busy === 'request'
                  ? 'Submitting…'
                  : isDeposit
                    ? 'Request deposit'
                    : 'Request withdrawal'}
            </button>

            {/* Same reason as the order form's notice: two pop-ups from one press reads as
                the first having failed, and the instinct is to reject the second. */}
            {busy === 'approve' ? (
              <p className={styles.muted} role="status" data-testid="funding-approval-notice">
                First deposit to the vault — it will ask twice: once to allow USDW, then for the deposit itself.
              </p>
            ) : null}

            {request ? (
              <SettlementState
                settlementId={request.id}
                status={status}
                busy={busy}
                onClaim={handleClaim}
                onCancel={handleCancel}
                onReclaim={handleReclaim}
              />
            ) : null}

            {message ? (
              <p className={styles.ok} role="status" data-testid="funding-message">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="error-text" role="alert" data-testid="funding-error">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * The three-state lifecycle, stated rather than hidden. Each status gets exactly the one
 * call the contract will accept in it — offering all three would put two buttons on
 * screen that are guaranteed to revert.
 */
function SettlementState({
  settlementId,
  status,
  busy,
  onClaim,
  onCancel,
  onReclaim,
}: {
  settlementId: number;
  status: VaultRequestStatus;
  busy: string | null;
  onClaim: () => void;
  onCancel: () => void;
  onReclaim: () => void;
}) {
  return (
    <div className={styles.settlement} role="status" data-testid="funding-settlement">
      <div className={styles.settlementHead}>
        <span className="mono-upper">Settlement #{settlementId}</span>
        <span className={styles.status} data-testid="funding-settlement-status">
          {status}
        </span>
      </div>

      {status === 'PENDING' ? (
        <>
          <p className={styles.muted}>Not settled yet. This is expected to take a while.</p>
          <button
            type="button"
            className={styles.secondary}
            data-testid="funding-cancel"
            onClick={onCancel}
            disabled={busy !== null}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel request'}
          </button>
        </>
      ) : null}

      {status === 'CLAIMABLE' ? (
        <button
          type="button"
          className={styles.primary}
          data-testid="funding-claim"
          onClick={onClaim}
          disabled={busy !== null}
        >
          {busy === 'claim' ? 'Claiming…' : 'Claim'}
        </button>
      ) : null}

      {status === 'RECLAIMABLE' ? (
        <>
          <p className={styles.muted}>This settlement did not fill your request. Reclaim returns it to your wallet.</p>
          <button
            type="button"
            className={styles.primary}
            data-testid="funding-reclaim"
            onClick={onReclaim}
            disabled={busy !== null}
          >
            {busy === 'reclaim' ? 'Reclaiming…' : 'Reclaim funds'}
          </button>
        </>
      ) : null}
    </div>
  );
}
