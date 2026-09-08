'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useOpenTrade } from '@/hooks/useOpenTrade';
import { useOrders } from '@/hooks/useOrders';
import { usePrice } from '@/hooks/usePrice';
import { explainCancelReason } from '@/lib/abi';
import {
  COLLATERAL_DECIMALS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  PRICE_DECIMALS_NUM,
} from '@/lib/config';
import { TRADING_ADDRESS } from '@/lib/deployment';
import { formatBps, formatMoney, parseHumanDecimal, parseRawUnits } from '@/lib/money';

const QUICK_FILL_FRACTIONS = [25, 50, 75, 100] as const;

type SubmitState =
  | { phase: 'idle' }
  | { phase: 'approving' }
  | { phase: 'submitting' }
  | { phase: 'submitted'; orderId: string }
  | { phase: 'error'; message: string };

/**
 * Order-entry panel. Visual structure follows terminal_design.pdf's right-hand panel
 * (LONG/SHORT toggle, order-type tabs, price/size fields, leverage slider, order
 * summary) with the phase-5 design-honesty corrections:
 *  - Only MARKET is enabled. LIMIT/STOP exist on-chain (IOstiumTradingStorage
 *    .OpenOrderType) but their full management UI is out of scope for this gate — shown
 *    disabled, not omitted. TWAP does not exist in the contracts at all.
 *  - "Cross · 50x max" is replaced with "Isolated · <maxLeverage>x max" — Ostium
 *    positions are isolated margin, not cross.
 *  - Est. liq. price is not computable from data this app currently reads (would need
 *    on-chain funding/rollover accumulator state) — shown as an honest dash, never a
 *    placeholder number.
 *  - Fee maker/taker is a real on-chain read (useMarketFees), not the mockup's numbers.
 */
export function OpenPositionForm({ pairIndex, maxLeverage }: { pairIndex: number | null; maxLeverage: bigint }) {
  const { address, isConnected } = useAccount();
  const { data: price } = usePrice(pairIndex);
  const erc20 = useErc20(TRADING_ADDRESS);
  const { openTrade, isPending } = useOpenTrade();
  const { orders } = useOrders(address);
  const fees = useMarketFees(pairIndex);

  const [buy, setBuy] = useState(true);
  const [collateralInput, setCollateralInput] = useState('');
  const maxLeverageX = maxLeverage > 0n ? Number(maxLeverage / 100n) : 1;
  const [leverageX, setLeverageX] = useState(Math.min(10, Math.max(1, maxLeverageX)));
  const [leverageTouched, setLeverageTouched] = useState(false);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [state, setState] = useState<SubmitState>({ phase: 'idle' });

  // `maxLeverage` starts at 0n (no market loaded yet) and jumps to its real value once
  // `/markets` resolves. Re-derive the default leverage when that happens, unless the
  // trader has already touched the slider — otherwise the default silently stays
  // clamped at the "unknown market" placeholder of 1x forever (a real bug caught by the
  // phase-5 E2E gate, not a hypothetical).
  useEffect(() => {
    if (!leverageTouched) {
      setLeverageX(Math.min(10, Math.max(1, maxLeverageX)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxLeverageX]);

  function handleLeverageChange(value: number) {
    setLeverageTouched(true);
    setLeverageX(value);
  }

  const collateralRaw = useMemo(() => {
    try {
      if (!collateralInput.trim()) return 0n;
      return parseHumanDecimal(collateralInput, COLLATERAL_DECIMALS);
    } catch {
      return null;
    }
  }, [collateralInput]);

  const leverageRaw = BigInt(leverageX * 100);
  const isDegraded = price?.degraded ?? false;
  const needsApproval = collateralRaw !== null && collateralRaw > 0n && erc20.allowance < collateralRaw;
  const insufficientBalance = collateralRaw !== null && collateralRaw > 0n && erc20.balance < collateralRaw;
  const leverageTooHigh = leverageRaw > maxLeverage;

  const orderValueRaw = collateralRaw !== null && collateralRaw > 0n ? (collateralRaw * leverageRaw) / 100n : 0n;

  const submittedOrder = state.phase === 'submitted' ? orders.find((o) => o.orderId === state.orderId) : undefined;

  const canSubmit =
    isConnected &&
    pairIndex !== null &&
    price &&
    !isDegraded &&
    collateralRaw !== null &&
    collateralRaw > 0n &&
    !insufficientBalance &&
    !leverageTooHigh &&
    !needsApproval &&
    state.phase !== 'approving' &&
    state.phase !== 'submitting' &&
    !isPending;

  function setCollateralFraction(pct: number) {
    const amount = (erc20.balance * BigInt(pct)) / 100n;
    setCollateralInput(formatMoney(amount, COLLATERAL_DECIMALS, { grouping: false }));
  }

  async function handleApprove() {
    if (collateralRaw === null) return;
    setState({ phase: 'approving' });
    try {
      await erc20.approve(collateralRaw);
      await erc20.refetchAllowance();
      setState({ phase: 'idle' });
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pairIndex === null || !price || collateralRaw === null || collateralRaw <= 0n) return;
    setState({ phase: 'submitting' });
    try {
      const { orderId } = await openTrade({
        pairIndex,
        buy,
        collateralRaw,
        leverageRaw,
        wantedPriceRaw: parseRawUnits(price.mark),
        slippageBps,
      });
      setState({ phase: 'submitted', orderId: orderId !== undefined ? orderId.toString() : '' });
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <form onSubmit={handleSubmit} data-testid="open-position-form">
      <div className={`side-toggle`}>
        <button
          type="button"
          data-testid="direction-long"
          className={buy ? 'active long-active' : ''}
          onClick={() => setBuy(true)}
        >
          Long
        </button>
        <button
          type="button"
          data-testid="direction-short"
          className={!buy ? 'active short-active' : ''}
          onClick={() => setBuy(false)}
        >
          Short
        </button>
      </div>

      <div className="order-type-tabs">
        <button type="button" className="active">
          Market
        </button>
        <button type="button" disabled title="On-chain, but resting-order management is out of scope for this release">
          Limit
        </button>
        <button type="button" disabled title="On-chain, but resting-order management is out of scope for this release">
          Stop
        </button>
        <button type="button" disabled title="Not implemented in the contracts (no TWAP order type)">
          TWAP
        </button>
      </div>

      <div className="field-group">
        <div className="field-label-row">
          <span>Price</span>
          <span className="badge">MID</span>
        </div>
        <input
          data-testid="reference-price"
          readOnly
          value={price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}
        />
      </div>

      <div className="field-group">
        <div className="field-label-row">
          <span>Collateral</span>
          <span data-testid="usdw-balance">Avail. {formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</span>
        </div>
        <input
          data-testid="collateral-input"
          inputMode="decimal"
          placeholder="0.00"
          value={collateralInput}
          onChange={(e) => setCollateralInput(e.target.value)}
        />
      </div>
      <div className="quick-fill-row">
        {QUICK_FILL_FRACTIONS.map((pct) => (
          <button type="button" key={pct} onClick={() => setCollateralFraction(pct)} data-testid={`quick-fill-${pct}`}>
            {pct === 100 ? 'Max' : `${pct}%`}
          </button>
        ))}
      </div>

      <div className="leverage-row">
        <div className="field-label-row">
          <span>Leverage</span>
          <span data-testid="leverage-value">{leverageX}×</span>
        </div>
        <input
          data-testid="leverage-slider"
          type="range"
          min={1}
          max={Math.max(1, maxLeverageX)}
          step={1}
          value={leverageX}
          onChange={(e) => handleLeverageChange(Number(e.target.value))}
        />
        <div className="bounds">
          <span>1×</span>
          <span>{maxLeverageX}× max</span>
        </div>
      </div>

      {/* Design §5.1: in this two-phase design slippage is the trader's ONLY defence
          against an unfavourable execution price (the price is not known at request
          time) — so it is shown explicitly here, not tucked into an "advanced" panel. */}
      <div className="leverage-row">
        <div className="field-label-row">
          <span>Max slippage</span>
          <span data-testid="slippage-value">{formatBps(slippageBps)}</span>
        </div>
        <input
          data-testid="slippage-input"
          type="range"
          min={Number(MIN_SLIPPAGE_BPS)}
          max={Number(MAX_SLIPPAGE_BPS)}
          step={5}
          value={Number(slippageBps)}
          onChange={(e) => setSlippageBps(BigInt(e.target.value))}
        />
      </div>
      <p className="slippage-explainer">
        If the execution price (set by the keeper&apos;s signed report, after you submit) moves against you by more
        than {formatBps(slippageBps)}, the order is cancelled and your collateral is refunded, minus the oracle fee.
      </p>

      {isDegraded ? (
        <p role="alert" className="error-text" data-testid="open-blocked-degraded">
          Opening is disabled: the price feed is degraded (fewer than 3 healthy venues).
        </p>
      ) : null}
      {leverageTooHigh ? <p className="error-text">Leverage exceeds this market&apos;s maximum.</p> : null}
      {insufficientBalance ? <p className="error-text">Insufficient USDW balance.</p> : null}

      <div className="submit-row">
        {needsApproval ? (
          <button type="button" data-testid="approve-button" onClick={handleApprove} disabled={state.phase === 'approving'}>
            {state.phase === 'approving' ? 'Approving…' : 'Approve USDW'}
          </button>
        ) : (
          <button type="submit" className={buy ? 'long' : 'short'} data-testid="submit-open-button" disabled={!canSubmit}>
            {state.phase === 'submitting' ? 'Submitting…' : `${buy ? 'Buy · Long' : 'Sell · Short'}`}
          </button>
        )}
      </div>

      <div className="order-summary">
        <div className="row">
          <span>Order value</span>
          <span data-testid="order-value">{formatMoney(orderValueRaw, COLLATERAL_DECIMALS)} USDW</span>
        </div>
        <div className="row">
          <span>Margin required</span>
          <span data-testid="margin-required">
            {collateralRaw !== null ? formatMoney(collateralRaw, COLLATERAL_DECIMALS) : '0.00'} USDW
          </span>
        </div>
        <div className="row">
          <span>Est. liq. price</span>
          <span className="dash" data-testid="est-liq-price" title="Not available: requires on-chain funding/rollover state this app does not currently read">
            —
          </span>
        </div>
        <div className="row">
          <span>Fee · maker/taker</span>
          <span data-testid="fee-maker-taker">
            {fees.makerFeeRaw !== null && fees.takerFeeRaw !== null
              ? `${formatMoney(fees.makerFeeRaw, 6, { grouping: false })}% / ${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%`
              : '—'}
          </span>
        </div>
      </div>

      {state.phase === 'error' ? (
        <p role="alert" className="error-text" data-testid="open-error">
          {state.message}
        </p>
      ) : null}

      {state.phase === 'submitted' ? (
        <div data-testid="order-pending-banner" role="status">
          {!submittedOrder || submittedOrder.status === 'pending' ? (
            <p>
              Order requested (id {state.orderId || '—'}). Nothing has happened yet — the transaction only recorded
              your request. The position opens, or the order is cancelled, once a keeper delivers the signed price
              report. Watch the Orders tab below.
            </p>
          ) : submittedOrder.status === 'executed' ? (
            <p data-testid="order-filled">Filled — your position is now open.</p>
          ) : (
            <p data-testid="order-cancelled" className="error-text">
              Cancelled ({submittedOrder.cancelReason ?? 'unknown reason'}):{' '}
              {explainCancelReason(submittedOrder.cancelReason ?? '')}
            </p>
          )}
        </div>
      ) : null}

      <div className="points-panel" data-testid="points-panel">
        <div className="field-label-row">
          <span>Void points</span>
          <span className="badge badge-soon">Coming soon</span>
        </div>
        <p>Point totals and referral share are not yet backed by a live service — nothing invented here.</p>
      </div>
    </form>
  );
}
