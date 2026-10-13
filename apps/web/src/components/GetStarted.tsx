'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { type Erc20Handle, useErc20 } from '@/hooks/useErc20';
import { FAUCET_MINT_USDW, useFaucet } from '@/hooks/useFaucet';
import { useWbtBalance } from '@/hooks/useWbtBalance';
import { FAUCET_WBT_AMOUNT, formatRetryAfter, useWbtFaucet } from '@/hooks/useWbtFaucet';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { formatMoney } from '@/lib/money';
import {
  type FundingNeeds,
  formatWbt,
  fundingNeeds,
  hasSeenGetStarted,
  markGetStartedSeen,
  needsFunding,
} from '@/lib/testFunds';
import { Modal } from './Modal';
import { EXPLORER_BASE } from './WbtFaucetPanel';
import styles from './GetStarted.module.css';

/**
 * The setup dialog a wallet meets the first time it connects without the means to trade.
 *
 * A brand-new tester holds no WBT and no USDW. Without WBT they cannot sign anything — not
 * an order, not even the USDW claim — and nothing on the terminal said where either comes
 * from: /faucet was one nav link among six. So the first connect of a wallet that is short
 * of gas or margin opens this, with both claims in it, in the order they have to happen:
 * gas first (a request to our API, nothing to sign), then USDW (a transaction, which the
 * gas pays for).
 *
 * Offered once per address per browser. A wallet that already has both never sees it, and
 * one that closes it keeps /faucet for later.
 */
export function GetStarted() {
  const { address } = useAccount();
  // TradingStorage, as on /faucet: naming the spender lets the USDW claim arm the trading
  // allowance in the same gesture (see FaucetPanel).
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const wbt = useWbtBalance(address);
  const needs = fundingNeeds(wbt.wei, erc20.balanceLoaded ? erc20.balance : null);
  const wantsSetup = needsFunding(needs);
  const [open, setOpen] = useState(false);
  // Belt to the storage's braces: where localStorage is unavailable the dialog would
  // otherwise reopen on every balance poll.
  const offered = useRef(new Set<string>());

  // Another wallet connecting is another visitor; the open dialog was for the last one.
  useEffect(() => {
    setOpen(false);
  }, [address]);

  useEffect(() => {
    if (!address || !wantsSetup) return;
    const key = address.toLowerCase();
    if (offered.current.has(key)) return;
    offered.current.add(key);
    if (hasSeenGetStarted(address)) return;
    markGetStartedSeen(address);
    setOpen(true);
  }, [address, wantsSetup]);

  // Stable, because Modal re-runs its focus handling whenever onClose changes identity —
  // and the balances above re-render this every few seconds.
  const close = useCallback(() => setOpen(false), []);

  if (!address) return null;
  return <GetStartedDialog open={open} onClose={close} address={address} erc20={erc20} wbtWei={wbt.wei} needs={needs} />;
}

function GetStartedDialog({
  open,
  onClose,
  address,
  erc20,
  wbtWei,
  needs,
}: {
  open: boolean;
  onClose: () => void;
  address: Address;
  erc20: Erc20Handle;
  wbtWei: bigint | null;
  needs: FundingNeeds | null;
}) {
  const wbtFaucet = useWbtFaucet(address);
  const usdwFaucet = useFaucet(erc20);
  const hasGas = wbtWei !== null && wbtWei > 0n;
  const gasDone = needs !== null && !needs.gas;
  const marginDone = needs !== null && !needs.collateral;
  const ready = gasDone && marginDone;
  // Focus lands on the claim the wallet needs first, not on the close button: Enter
  // should do the thing this dialog was opened for.
  const firstClaim = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Get set up to trade"
      testId="get-started"
      size="wide"
      initialFocusRef={firstClaim}
      footer={
        <>
          Testnet tokens have no value. Both faucets refill every 24h on the{' '}
          <Link href="/faucet" className={styles.link} onClick={onClose} data-testid="get-started-faucet">
            Faucet page
          </Link>
          .
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.lede}>
          A new wallet needs two free testnet tokens before its first trade: <b>WBT</b> to pay gas, and <b>USDW</b> to
          use as margin.
        </p>

        <ol className={styles.steps}>
          <li className={styles.step} data-testid="get-started-gas" data-done={gasDone}>
            <div className={styles.stepHead}>
              <span className={styles.stepIndex} aria-hidden="true">
                {gasDone ? '✓' : '1'}
              </span>
              <div className={styles.stepText}>
                <span className={styles.stepTitle}>Gas · WBT</span>
                <span className={styles.stepSub} data-testid="get-started-wbt-balance">
                  In your wallet: {wbtWei === null ? '—' : `${formatWbt(wbtWei)} WBT`}
                </span>
              </div>
            </div>
            {gasDone ? null : (
              <button
                ref={firstClaim}
                type="button"
                className={styles.primary}
                data-testid="get-started-claim-wbt"
                onClick={wbtFaucet.request}
                disabled={wbtFaucet.pending}
              >
                {wbtFaucet.pending ? `Sending ${FAUCET_WBT_AMOUNT} WBT…` : `Claim ${FAUCET_WBT_AMOUNT} WBT`}
              </button>
            )}
            {wbtFaucet.txHash ? (
              <p className={styles.ok} role="status" data-testid="get-started-wbt-success">
                Sent {FAUCET_WBT_AMOUNT} WBT — it lands in a few seconds.{' '}
                <a
                  className={styles.link}
                  href={`${EXPLORER_BASE}/tx/${wbtFaucet.txHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  View the transaction ↗
                </a>
              </p>
            ) : null}
            {wbtFaucet.error ? (
              <p className="error-text" role="alert" data-testid="get-started-wbt-error">
                {wbtFaucet.error}
                {wbtFaucet.retryAfterSeconds != null ? ` Try again in ${formatRetryAfter(wbtFaucet.retryAfterSeconds)}.` : ''}
              </p>
            ) : null}
          </li>

          <li className={styles.step} data-testid="get-started-usdw" data-done={marginDone}>
            <div className={styles.stepHead}>
              <span className={styles.stepIndex} aria-hidden="true">
                {marginDone ? '✓' : '2'}
              </span>
              <div className={styles.stepText}>
                <span className={styles.stepTitle}>Margin · USDW</span>
                <span className={styles.stepSub} data-testid="get-started-usdw-balance">
                  In your wallet: {erc20.balanceLoaded ? `${formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW` : '—'}
                </span>
              </div>
            </div>
            {marginDone ? null : (
              <>
                <button
                  ref={gasDone ? firstClaim : undefined}
                  type="button"
                  className={styles.primary}
                  data-testid="get-started-claim-usdw"
                  onClick={usdwFaucet.claim}
                  disabled={usdwFaucet.pending || !hasGas}
                >
                  {usdwFaucet.pending
                    ? 'Claiming… confirm in your wallet'
                    : `Claim ${formatMoney(FAUCET_MINT_USDW, COLLATERAL_DECIMALS)} USDW`}
                </button>
                {hasGas ? null : (
                  <p className={styles.hint} data-testid="get-started-usdw-needs-gas">
                    Claim WBT first: this one is a transaction your wallet signs, and signing costs gas.
                  </p>
                )}
              </>
            )}
            {usdwFaucet.error ? (
              <p className="error-text" role="alert" data-testid="get-started-usdw-error">
                {usdwFaucet.error}
              </p>
            ) : null}
          </li>
        </ol>

        {/* Quiet until the wallet can actually trade, so it does not outshine the claims
            above; the way out is always there, though — nobody is held in this dialog. */}
        <Link
          href="/trade"
          className={ready ? styles.trade : styles.later}
          onClick={onClose}
          data-testid="get-started-trade"
          data-ready={ready}
        >
          {ready ? 'Start trading' : 'Go to the terminal'}
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </Modal>
  );
}
