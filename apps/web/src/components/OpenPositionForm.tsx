'use client';

import { useEffect, useMemo, useState } from 'react';
import { maxUint256 } from 'viem';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useFaucet } from '@/hooks/useFaucet';
import { useEstimatedLiquidationPrice } from '@/hooks/useLiquidationPrice';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useOpenTrade } from '@/hooks/useOpenTrade';
import { useOrders } from '@/hooks/useOrders';
import { usePrice } from '@/hooks/usePrice';
import { explainCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { formatMoney, parseHumanDecimal, priceToRaw } from '@/lib/money';
import { collateralForPositionSize, estimatePositionSizeBase } from '@/lib/pnl';
import type { MarketSummary } from '@/lib/types';
import { describeTxError } from '@/lib/tx';

const QUICK_FILL_FRACTIONS = [25, 50, 75, 100] as const;

/**
 * Slippage tolerance for every order this form submits.
 *
 * It was a slider until the strip-to-reference pass; terminal_design.pdf has exactly one
 * slider, LEVERAGE. Deleting the control is NOT the same as deleting the parameter —
 * `openTrade` takes `slippageP` on every call, and in this two-phase design it is the
 * trader's only defence against an unfavourable execution price (the price does not exist
 * at request time; see config.ts:47-52). Removing the control without pinning the value
 * would have submitted orders with whatever the last render left behind.
 *
 * Pinned to the same constant `PositionsList.tsx:64` already passes when closing, so both
 * money paths now agree by construction rather than by the coincidence of a slider's
 * default position.
 */
const SLIPPAGE_BPS = DEFAULT_SLIPPAGE_BPS;

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
export function OpenPositionForm({
  pairIndex,
  maxLeverage,
  market,
}: {
  pairIndex: number | null;
  maxLeverage: bigint;
  /** Optional: only used to name the base asset in the derived size readout. Passed down
   * from the page rather than re-fetched here, so this component keeps its single data
   * dependency on the price feed. */
  market?: MarketSummary;
}) {
  const { address, isConnected } = useAccount();
  const { data: price } = usePrice(pairIndex);
  /**
   * The spender is TradingStorage, not Trading.
   *
   * `OstiumTrading.openTrade` does not move the collateral itself — it calls into
   * `OstiumTradingStorage`, which runs `SafeERC20.safeTransferFrom(usdc, trader, …)` at
   * OstiumTradingStorage.sol:486. The token therefore sees TradingStorage as `msg.sender`,
   * and that is the address whose allowance must be set.
   *
   * This used to approve `TRADING_ADDRESS`, so the Approve button granted an allowance
   * nothing ever spends: the form then showed a ready "Buy · Long", and the transaction
   * reverted on chain with `ERC20InsufficientAllowance(tradingStorage, 0, collateral)`.
   * It went unnoticed because the account used for end-to-end testing had been given an
   * unlimited TradingStorage allowance by the deployment script — the one account for
   * which the wrong approval could not matter. Every genuinely new wallet was blocked.
   */
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const faucet = useFaucet(erc20);
  const { openTrade, isPending } = useOpenTrade();
  const { orders } = useOrders(address);
  const fees = useMarketFees(pairIndex);

  const [buy, setBuy] = useState(true);
  /** Base-asset quantity, as typed. The contract never sees this — see `collateralRaw`. */
  const [sizeInput, setSizeInput] = useState('');
  const maxLeverageX = maxLeverage > 0n ? Number(maxLeverage / 100n) : 1;
  const [leverageX, setLeverageX] = useState(Math.min(10, Math.max(1, maxLeverageX)));
  const [leverageTouched, setLeverageTouched] = useState(false);
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

  const leverageRaw = BigInt(leverageX * 100);

  /** The base asset the size field is denominated in. Falls back to the generic label
   * rather than to a hardcoded "BTC", which would be a lie the moment a second pair is
   * listed. */
  const baseAsset = market?.from ?? 'BASE';

  const sizeBaseRaw = useMemo(() => {
    try {
      if (!sizeInput.trim()) return 0n;
      // Base-asset quantities carry PRICE_DECIMALS, the same scale estimatePositionSizeBase
      // returns, so the two directions of the conversion share one unit.
      return parseHumanDecimal(sizeInput, PRICE_DECIMALS_NUM);
    } catch {
      return null;
    }
  }, [sizeInput]);

  /**
   * What is actually submitted.
   *
   * `openTrade` takes collateral and leverage and has no size parameter — the base-asset
   * quantity is a consequence of those and the fill price. The form is denominated in
   * size because the reference's order panel is, so the typed figure is converted here
   * and the result is shown as "Margin required" below, where the trader can see the
   * number that will leave their wallet before they sign for it.
   *
   * Null when the price is not yet known: without one there is no conversion to make, and
   * guessing a rate for a money figure is not an option (see lib/money.ts).
   */
  const collateralRaw = useMemo(() => {
    if (sizeBaseRaw === null) return null;
    if (sizeBaseRaw === 0n) return 0n;
    if (!price) return null;
    return collateralForPositionSize({ sizeBaseRaw, leverage: leverageRaw, openPrice: priceToRaw(price.mark) });
  }, [sizeBaseRaw, leverageRaw, price]);
  const isDegraded = price?.degraded ?? false;
  const needsApproval = collateralRaw !== null && collateralRaw > 0n && erc20.allowance < collateralRaw;
  const insufficientBalance = collateralRaw !== null && collateralRaw > 0n && erc20.balance < collateralRaw;
  const leverageTooHigh = leverageRaw > maxLeverage;

  const orderValueRaw = collateralRaw !== null && collateralRaw > 0n ? (collateralRaw * leverageRaw) / 100n : 0n;

  /**
   * The outcome banner describes ONE submitted order, so it must not outlive the order it
   * describes. Editing the size, flipping the side or switching market composes a new,
   * unsubmitted order — and leaving "Filled — your position is now open." on screen while
   * that happens tells the trader their pending edit has already executed.
   *
   * Seen exactly that: "Insufficient USDW balance", "Approve USDW" and "Filled — your
   * position is now open." all visible at once, describing three different moments.
   *
   * Only settled phases are cleared. Wiping `submitting`/`approving`/`claiming` would
   * discard the in-flight state of a transaction that is still running.
   */
  useEffect(() => {
    setState((current) => (current.phase === 'submitted' || current.phase === 'error' ? { phase: 'idle' } : current));
  }, [sizeInput, buy, leverageX, pairIndex]);

  const submittedOrder = state.phase === 'submitted' ? orders.find((o) => o.orderId === state.orderId) : undefined;

  // Evaluated at the current mark, because that is the price this order would open at —
  // the contract's own liquidation formula, not a copy of it. Null until there is a
  // price, a collateral amount and a leverage to feed it.
  const estLiqPrice = useEstimatedLiquidationPrice({
    openPriceRaw: price ? priceToRaw(price.mark) : 0n,
    long: buy,
    collateralRaw: collateralRaw ?? 0n,
    leverageRaw,
    maxLeverageRaw: maxLeverage,
  });

  // The faucet is offered whenever the connected wallet cannot fund the order it is
  // looking at — including the very common "connected with 0.00 USDW" case, where
  // without this the terminal is a dead end: every control works and nothing can be
  // submitted, with no route to collateral anywhere in the product. USDW.claim() is a
  // testnet mint on the mock collateral token (contracts/src/mocks/USDW.sol).
  const needsFunds = isConnected && (erc20.balance === 0n || insufficientBalance);

  const canSubmit =
    isConnected &&
    pairIndex !== null &&
    price &&
    !isDegraded &&
    collateralRaw !== null &&
    collateralRaw > 0n &&
    !insufficientBalance &&
    !leverageTooHigh &&
    // `needsApproval` is deliberately NOT a blocker: handleSubmit grants the allowance on
    // the way to openTrade. Gating on it here was what put a second button on the panel,
    // and it also meant a wallet with no allowance AND no balance was offered an approval
    // — a gas-costing transaction for an order that could never go through.
    state.phase !== 'approving' &&
    state.phase !== 'submitting' &&
    !isPending;

  /** Quick-fill is a fraction of the WALLET, so it is computed in collateral and then
   * expressed as the size that collateral buys — the inverse direction to submission.
   * Doing it the other way (a fraction of some notional) would let "Max" produce an order
   * the balance cannot fund. */
  function setSizeFraction(pct: number) {
    if (!price) return;
    const collateral = (erc20.balance * BigInt(pct)) / 100n;
    const size = estimatePositionSizeBase({
      collateral,
      leverage: leverageRaw,
      openPrice: priceToRaw(price.mark),
    });
    setSizeInput(formatMoney(size, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false }));
  }

  /**
   * Submits the order, granting the allowance first when there is not one yet.
   *
   * The allowance is what lets `OstiumTradingStorage` pull collateral out of the wallet
   * at open time (safeTransferFrom, OstiumTradingStorage.sol:486). There is no account
   * balance on this exchange to spend from — every order moves USDW straight from the
   * wallet — so the approval is unavoidable; USDW is a plain OpenZeppelin ERC20 with no
   * `permit` (contracts/src/mocks/USDW.sol), which rules out signing instead of sending.
   *
   * What IS avoidable is a second BUTTON. terminal_design.pdf gives this panel one action,
   * and the perp venues it is modelled on show no approval step at all — not because they
   * solved the allowance but because they have a margin account, so nothing is ever pulled
   * from the wallet mid-trade. Lacking that account layer, the next best thing is to make
   * the approval a step of the submit rather than a gate in front of it: one button, and
   * on a wallet's very first order two confirmations instead of one.
   *
   * Approving the maximum, not this order's collateral, is what keeps it to the first
   * order only. The exact amount meant every order LARGER than the last one silently
   * demanded another approval transaction. The downside — TradingStorage authorised for
   * an unbounded amount — is bounded here by the token being a testnet mock with an open
   * faucet.
   *
   * Most wallets never reach the approval leg at all: `useFaucet` arms the allowance when
   * the tokens are minted. This is the backstop for the ones that did not come that way.
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pairIndex === null || !price || collateralRaw === null || collateralRaw <= 0n) return;
    try {
      if (needsApproval) {
        setState({ phase: 'approving' });
        await erc20.approve(maxUint256);
        await erc20.refetchAllowance();
      }
      setState({ phase: 'submitting' });
      const { orderId } = await openTrade({
        pairIndex,
        buy,
        collateralRaw,
        leverageRaw,
        wantedPriceRaw: priceToRaw(price.mark),
        slippageBps: SLIPPAGE_BPS,
      });
      setState({ phase: 'submitted', orderId: orderId !== undefined ? orderId.toString() : '' });
    } catch (err) {
      const message = describeTxError(err);
      setState(message === null ? { phase: 'idle' } : { phase: 'error', message });
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

      {/* Order matches terminal_design.pdf (LIMIT MARKET STOP TWAP). MARKET stays the
          ACTIVE one, which the reference does not: useOpenTrade hardcodes
          OPEN_ORDER_TYPE_MARKET into every submission, so an active LIMIT tab over this
          submit path would name one order type and sign another. LIMIT/STOP exist on
          chain but their resting-order management UI is out of scope (abi.ts); TWAP is
          not in the contracts at all. */}
      <div className="order-type-tabs">
        <button type="button" disabled title="On-chain, but resting-order management is out of scope for this release">
          Limit
        </button>
        <button type="button" className="active">
          Market
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
        <div className="input-with-suffix">
          <input
            data-testid="reference-price"
            readOnly
            value={price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}
          />
          <span className="field-suffix">USDW</span>
        </div>
      </div>

      <div className="field-group">
        <div className="field-label-row">
          <span>Size</span>
          <span data-testid="usdw-balance">Avail. {formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</span>
        </div>
        <div className="input-with-suffix">
          <input
            data-testid="size-input"
            inputMode="decimal"
            placeholder="0.0000"
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value)}
          />
          <span className="field-suffix">{baseAsset}</span>
        </div>
      </div>
      <div className="quick-fill-row">
        {QUICK_FILL_FRACTIONS.map((pct) => (
          <button type="button" key={pct} onClick={() => setSizeFraction(pct)} data-testid={`quick-fill-${pct}`}>
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

      {isDegraded ? (
        <p role="alert" className="error-text" data-testid="open-blocked-degraded">
          {/* The requirement is the market's own, not a hardcoded 3: a market listed with a
              lower minimum would otherwise be described by a threshold it is not judged by.
              Falls back to naming no number when the API did not send one. */}
          Opening is disabled: the price feed is degraded
          {price?.minHealthyVenues != null
            ? ` (fewer than ${price.minHealthyVenues} healthy venues)`
            : ''}
          .
        </p>
      ) : null}
      {leverageTooHigh ? <p className="error-text">Leverage exceeds this market&apos;s maximum.</p> : null}
      {insufficientBalance ? <p className="error-text">Insufficient USDW balance.</p> : null}

      {/* The button survives the strip-to-reference pass and its explanatory note does
          not. A wallet holding 0 USDW reaches a terminal where every control works and
          nothing can be submitted; without a route to collateral here that is a dead
          end. What the faucet mints and how often is now stated once, in FaucetPanel,
          rather than repeated in the order form. */}
      {needsFunds ? (
        <div className="faucet-row" data-testid="faucet-row">
          <button type="button" data-testid="faucet-button" onClick={faucet.claim} disabled={faucet.pending}>
            {faucet.pending ? 'Claiming…' : 'Get testnet USDW'}
          </button>
        </div>
      ) : null}
      {faucet.error ? (
        <p role="alert" className="error-text" data-testid="faucet-error">
          {faucet.error}
        </p>
      ) : null}

      <div className="submit-row">
        <button type="submit" className={buy ? 'long' : 'short'} data-testid="submit-open-button" disabled={!canSubmit}>
          {state.phase === 'approving'
            ? 'Approving USDW…'
            : state.phase === 'submitting'
              ? 'Submitting…'
              : `${buy ? 'Buy · Long' : 'Sell · Short'}`}
        </button>
        {/* Two wallet pop-ups from one click reads as the first one having failed, and the
            instinct is to reject the second. Said only while the approval leg is actually
            in flight — which is the first order from this wallet, and no other. */}
        {state.phase === 'approving' ? (
          <p className="approval-notice" role="status" data-testid="approval-notice">
            First order from this wallet — it will ask twice: once to allow USDW, then for the order itself.
          </p>
        ) : null}
      </div>

      <div className="order-summary">
        <div className="row">
          <span>Order value</span>
          <span data-testid="order-value">{formatMoney(orderValueRaw, COLLATERAL_DECIMALS)} USDW</span>
        </div>
        <div className="row">
          {/* The number that actually leaves the wallet. The size field above is the
              trader's input; this is what it converts to and what `openTrade` is handed,
              so it is the one figure on this panel they should check before signing.
              A dash, not "0.00", when there is no price to convert with — those are
              different states and only one of them means "this order costs nothing". */}
          <span>Margin required</span>
          <span data-testid="margin-required">
            {collateralRaw !== null ? `${formatMoney(collateralRaw, COLLATERAL_DECIMALS)} USDW` : '—'}
          </span>
        </div>
        <div className="row">
          <span>Est. liq. price</span>
          {/* A real contract read (getTradeLiquidationPricePure at rollover=funding=0 —
              see hooks/useLiquidationPrice.ts), not a formula reimplemented here. Still a
              dash until there is a price, a size and a leverage to evaluate it at. */}
          {/* Neutral, matching the positions table: a liquidation price is a level, not a
              loss, and red here competed with the figures whose colour means something. */}
          <span className={estLiqPrice !== null ? undefined : 'dash'} data-testid="est-liq-price">
            {estLiqPrice !== null ? formatMoney(estLiqPrice, PRICE_DECIMALS_NUM) : '—'}
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

    </form>
  );
}
