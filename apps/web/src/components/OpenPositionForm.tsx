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
import { usePositions } from '@/hooks/usePositions';
import { usePrice } from '@/hooks/usePrice';
import { useQuote } from '@/hooks/useQuote';
import { explainCancelReason, type OpenOrderKind } from '@/lib/abi';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { formatMoney, parseHumanDecimal, priceToRaw } from '@/lib/money';
import { tpSlErrors, triggerPriceError } from '@/lib/orderRules';
import {
  computeTicket,
  convertSizeInput,
  percentOfBalance,
  sizeForPercentOfBalance,
  type SizeUnit,
} from '@/lib/orderTicket';
import { estimatePositionSizeBase } from '@/lib/pnl';
import { slippageBpsToCover } from '@/lib/quote';
import type { MarketSummary } from '@/lib/types';
import { describeTxError } from '@/lib/tx';
import { RiskPreview } from './RiskPreview';
import styles from './OrderPanel.module.css';

const PERCENT_MARKS = [0, 25, 50, 75, 100] as const;
const ORDER_KINDS: readonly OpenOrderKind[] = ['MARKET', 'LIMIT', 'STOP'];
const KIND_LABEL: Record<OpenOrderKind, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP: 'Stop' };

type SubmitState =
  | { phase: 'idle' }
  | { phase: 'approving' }
  | { phase: 'submitting' }
  | { phase: 'submitted'; orderId: string }
  | { phase: 'placed'; kind: OpenOrderKind }
  | { phase: 'error'; message: string };

/** Percent at 1e18 scale → "0.0123%". */
function formatPercent18(p: bigint, digits = 4): string {
  return `${formatMoney(p, 18, { fractionDigits: digits, grouping: false })}%`;
}

function parsePriceInput(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseHumanDecimal(text, PRICE_DECIMALS_NUM);
  } catch {
    return null;
  }
}

/**
 * Order-entry panel, modelled on Variational Omni's: there is no order book, so the panel
 * leads with the vault's two-sided QUOTE for the size being entered — Buy at the ask, Sell at
 * the bid, both after size-dependent impact (lib/quote.ts, the contract's own formula) — and
 * the side buttons carry those prices. Isolated margin only (Ostium has no cross margin).
 *
 * MARKET fills at the next oracle report within the trader's max slippage around the QUOTED
 * fill (not the mark, so a large order is not cancelled for the impact it was shown). LIMIT
 * and STOP rest on chain until the automation bot triggers them; their slippage must be 0
 * (OstiumTrading.openTrade).
 */
export function OpenPositionForm({
  pairIndex,
  maxLeverage,
  market,
}: {
  pairIndex: number | null;
  maxLeverage: bigint;
  market?: MarketSummary;
}) {
  const { address, isConnected } = useAccount();
  const { data: price } = usePrice(pairIndex);
  // The spender is TradingStorage: it runs the safeTransferFrom at open
  // (OstiumTradingStorage.sol:486), not Trading.
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const faucet = useFaucet(erc20);
  const { openTrade, isPending } = useOpenTrade();
  const { orders } = useOrders(address);
  const { positions } = usePositions(address);
  const fees = useMarketFees(pairIndex);

  const [kind, setKind] = useState<OpenOrderKind>('MARKET');
  const [buy, setBuy] = useState(true);
  const [unit, setUnit] = useState<SizeUnit>('BASE');
  const [sizeInput, setSizeInput] = useState('');
  const [triggerInput, setTriggerInput] = useState('');
  const [tpSlOn, setTpSlOn] = useState(false);
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [maxSlippageBps, setMaxSlippageBps] = useState<bigint>(DEFAULT_SLIPPAGE_BPS);
  const [editingSlippage, setEditingSlippage] = useState(false);
  const maxLeverageX = maxLeverage > 0n ? Number(maxLeverage / 100n) : 1;
  const [leverageX, setLeverageX] = useState(Math.min(10, Math.max(1, maxLeverageX)));
  const [leverageTouched, setLeverageTouched] = useState(false);
  const [state, setState] = useState<SubmitState>({ phase: 'idle' });

  // `maxLeverage` is 0n until /markets resolves; re-derive the default then unless the trader
  // already chose one, or the default stays clamped at 1x forever.
  useEffect(() => {
    if (!leverageTouched) setLeverageX(Math.min(10, Math.max(1, maxLeverageX)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxLeverageX]);

  const leverageRaw = BigInt(leverageX * 100);
  const baseAsset = market?.from ?? 'BASE';
  const markRaw = price ? priceToRaw(price.mark) : 0n;
  const triggerRaw = parsePriceInput(triggerInput);

  // A first pass at the mark gives the notional the quote is sized for; the quote then gives
  // the real entry for a market order. The mark-based notional differs from the quote-based
  // one by the spread only, which does not move the impact curve meaningfully.
  const provisional = computeTicket({
    unit,
    sizeInput,
    leverageRaw,
    entryPrice: markRaw,
    takerFeeRaw: fees.takerFeeRaw,
    oracleFeeRaw: fees.oracleFeeRaw,
  });
  const { quote, unavailable: quoteUnavailable } = useQuote(pairIndex, provisional?.notionalRaw ?? 0n);

  const entryPrice =
    kind === 'MARKET' ? (quote ? (buy ? quote.buyPrice : quote.sellPrice) : markRaw) : (triggerRaw ?? 0n);

  const ticket = useMemo(
    () =>
      computeTicket({
        unit,
        sizeInput,
        leverageRaw,
        entryPrice,
        takerFeeRaw: fees.takerFeeRaw,
        oracleFeeRaw: fees.oracleFeeRaw,
      }),
    [unit, sizeInput, leverageRaw, entryPrice, fees.takerFeeRaw, fees.oracleFeeRaw],
  );
  const collateralRaw = ticket?.collateralRaw ?? null;

  const tpRaw = tpSlOn ? parsePriceInput(tpInput) : 0n;
  const slRaw = tpSlOn ? parsePriceInput(slInput) : 0n;
  const tpSl =
    tpRaw === null || slRaw === null
      ? { tp: tpRaw === null ? 'Not a price.' : null, sl: slRaw === null ? 'Not a price.' : null }
      : tpSlErrors({ buy, entryPrice, tp: tpRaw, sl: slRaw });
  const triggerError = kind === 'MARKET' ? null : triggerRaw === null ? 'Not a price.' : triggerPriceError(kind, buy, triggerRaw, markRaw);

  // The minimum tolerance that accepts the quoted fill. A default below it would cancel a large
  // order for the very impact the panel showed; the trader's setting is raised to cover it.
  const coverBps = quote ? slippageBpsToCover(quote, buy) : 0n;
  const effectiveSlippageBps = maxSlippageBps > coverBps ? maxSlippageBps : coverBps + 1n;

  const isDegraded = price?.degraded ?? false;
  const needsApproval = collateralRaw !== null && collateralRaw > 0n && erc20.allowance < collateralRaw;
  const insufficientBalance = collateralRaw !== null && collateralRaw > 0n && erc20.balance < collateralRaw;
  const leverageTooHigh = leverageRaw > maxLeverage;
  const needsFunds = isConnected && (erc20.balance === 0n || insufficientBalance);

  // Everything else this wallet holds on this market, summed as a signed base quantity.
  const currentPosition = useMemo(() => {
    if (pairIndex === null) return null;
    const mine = positions.filter((p) => p.pairIndex === pairIndex);
    if (mine.length === 0) return null;
    return mine.reduce((acc, p) => {
      const size = estimatePositionSizeBase({ collateral: p.collateral, leverage: p.leverage, openPrice: p.openPrice });
      return acc + (p.buy ? size : -size);
    }, 0n);
  }, [positions, pairIndex]);

  const estLiqPrice = useEstimatedLiquidationPrice({
    openPriceRaw: entryPrice,
    long: buy,
    collateralRaw: collateralRaw ?? 0n,
    leverageRaw,
    maxLeverageRaw: maxLeverage,
  });

  // The outcome banner describes one submitted order; editing composes a new one.
  useEffect(() => {
    setState((c) => (c.phase === 'submitted' || c.phase === 'placed' || c.phase === 'error' ? { phase: 'idle' } : c));
  }, [sizeInput, buy, leverageX, pairIndex, kind, triggerInput]);

  const submittedOrder = state.phase === 'submitted' ? orders.find((o) => o.orderId === state.orderId) : undefined;

  const canSubmit =
    isConnected &&
    pairIndex !== null &&
    Boolean(price) &&
    !isDegraded &&
    ticket !== null &&
    collateralRaw !== null &&
    collateralRaw > 0n &&
    entryPrice > 0n &&
    !insufficientBalance &&
    !leverageTooHigh &&
    !triggerError &&
    (kind === 'MARKET' || (triggerRaw !== null && triggerRaw > 0n)) &&
    !tpSl.tp &&
    !tpSl.sl &&
    (kind !== 'MARKET' || quote !== null) &&
    state.phase !== 'approving' &&
    state.phase !== 'submitting' &&
    !isPending;

  const percentUsed = collateralRaw ? percentOfBalance(collateralRaw, erc20.balance) : 0;

  function setPercent(percent: number) {
    setSizeInput(
      sizeForPercentOfBalance({ percent, balanceRaw: erc20.balance, leverageRaw, entryPrice, unit }),
    );
  }

  function toggleUnit() {
    const next: SizeUnit = unit === 'BASE' ? 'USD' : 'BASE';
    setSizeInput(
      convertSizeInput(
        { unit, sizeInput, leverageRaw, entryPrice, takerFeeRaw: fees.takerFeeRaw, oracleFeeRaw: fees.oracleFeeRaw },
        next,
      ),
    );
    setUnit(next);
  }

  /**
   * Grants the TradingStorage allowance on the way to the order when it is missing — one button,
   * two wallet prompts on a wallet's first order only (max approval; testnet mock token).
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || pairIndex === null || collateralRaw === null) return;
    try {
      if (needsApproval) {
        setState({ phase: 'approving' });
        await erc20.approve(maxUint256);
        await erc20.refetchAllowance();
      }
      setState({ phase: 'submitting' });
      const result = await openTrade({
        pairIndex,
        buy,
        collateralRaw,
        leverageRaw,
        wantedPriceRaw: entryPrice,
        slippageBps: effectiveSlippageBps,
        tp: tpRaw ?? 0n,
        sl: slRaw ?? 0n,
        kind,
      });
      if (kind === 'MARKET') {
        setState({ phase: 'submitted', orderId: result.orderId !== undefined ? result.orderId.toString() : '' });
      } else {
        setState({ phase: 'placed', kind });
      }
    } catch (err) {
      const message = describeTxError(err);
      setState(message === null ? { phase: 'idle' } : { phase: 'error', message });
    }
  }

  const buyLabel = quote ? formatMoney(quote.buyPrice, PRICE_DECIMALS_NUM) : '—';
  const sellLabel = quote ? formatMoney(quote.sellPrice, PRICE_DECIMALS_NUM) : '—';
  const submitLabel =
    state.phase === 'approving'
      ? 'Approving USDW…'
      : state.phase === 'submitting'
        ? 'Submitting…'
        : kind === 'MARKET'
          ? `${buy ? 'Buy · Long' : 'Sell · Short'} ${baseAsset}`
          : `Place ${KIND_LABEL[kind]} ${buy ? 'Buy' : 'Sell'} ${baseAsset}`;

  // The spread meter is display-only: the width of a bar, from a percentage that is also
  // printed exactly beside it. Square-root scaled so the half-spread of a small order is a
  // visible sliver and a very large order still fits (0.8% fills the track).
  const spreadPercent = quote ? Number(quote.spreadP) / 1e18 : 0;
  const spreadWidth = Math.min(100, Math.sqrt(Math.max(0, spreadPercent) / 0.8) * 100);
  const quoteSize =
    ticket && ticket.sizeBaseRaw > 0n ? `${formatMoney(ticket.sizeBaseRaw, PRICE_DECIMALS_NUM, { fractionDigits: 4 })} ${baseAsset}` : null;
  const leverageFill = maxLeverageX > 1 ? ((leverageX - 1) / (maxLeverageX - 1)) * 100 : 100;

  return (
    <form onSubmit={handleSubmit} data-testid="open-position-form" className={styles.panel}>
      <section className={styles.quoteCard} aria-label="Vault quote">
        <div className={styles.quoteHead}>
          <span className={styles.quoteTitle}>Vault quote{quoteSize ? ` · ${quoteSize}` : ''}</span>
          <span className={styles.quoteLive}>{quote ? 'live' : '—'}</span>
        </div>
        <div className={styles.sideTrack}>
          <button
            type="button"
            data-testid="direction-long"
            aria-pressed={buy}
            className={`${styles.side} ${buy ? `${styles.buyActive} active` : ''}`}
            onClick={() => setBuy(true)}
          >
            <span>Long</span>
            <span className={styles.sidePrice} data-testid="quote-buy">{buyLabel}</span>
          </button>
          <button
            type="button"
            data-testid="direction-short"
            aria-pressed={!buy}
            className={`${styles.side} ${!buy ? `${styles.sellActive} active` : ''}`}
            onClick={() => setBuy(false)}
          >
            <span>Short</span>
            <span className={styles.sidePrice} data-testid="quote-sell">{sellLabel}</span>
          </button>
        </div>
        <div className={styles.spreadRow}>
          <div className={styles.spreadTrack} aria-hidden="true">
            {quote ? <span className={styles.spreadFill} style={{ left: `${50 - spreadWidth / 2}%`, width: `${spreadWidth}%` }} /> : null}
            <span className={styles.spreadMid} />
          </div>
          <span>
            spread <b data-testid="quote-spread">{quote ? formatPercent18(quote.spreadP) : '—'}</b>
          </span>
        </div>
      </section>

      <div className={styles.kindTabs} role="tablist">
        {ORDER_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            data-testid={`order-kind-${k.toLowerCase()}`}
            className={kind === k ? styles.kindActive : undefined}
            onClick={() => setKind(k)}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
        <span className={styles.marginMode} title="Every position has its own margin. Cross margin does not exist in these contracts.">
          Isolated
        </span>
      </div>

      {kind !== 'MARKET' ? (
        <div className="field-group">
          <div className="field-label-row">
            <span>{kind === 'LIMIT' ? 'Limit price' : 'Stop price'}</span>
            <button type="button" className={styles.linkButton} onClick={() => price && setTriggerInput(formatMoney(markRaw, PRICE_DECIMALS_NUM, { grouping: false }))}>
              Mark
            </button>
          </div>
          <div className="input-with-suffix">
            <input
              data-testid="trigger-price-input"
              inputMode="decimal"
              placeholder="0.00"
              value={triggerInput}
              onChange={(e) => setTriggerInput(e.target.value)}
            />
            <span className="field-suffix">USD</span>
          </div>
          {triggerError ? <p className="error-text" data-testid="trigger-error">{triggerError}</p> : null}
        </div>
      ) : null}

      <div className={`field-group ${styles.sizeInput}`}>
        <div className="field-label-row">
          <span>Size</span>
          <span>
            Avail. <span className="mono" data-testid="usdw-balance">{formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</span>
          </span>
        </div>
        <div className="input-with-suffix">
          <input
            data-testid="size-input"
            inputMode="decimal"
            placeholder={unit === 'BASE' ? '0.0000' : '0.00'}
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value)}
          />
          <button type="button" className={styles.unitToggle} data-testid="size-unit-toggle" onClick={toggleUnit} title="Switch between the base asset and USD">
            {unit === 'BASE' ? baseAsset : 'USD'} ⇄
          </button>
        </div>
        {ticket === null ? <p className="error-text">Not a number.</p> : null}
      </div>

      <div className={styles.percentRow}>
        <div className={styles.percentMarks}>
          {PERCENT_MARKS.slice(1).map((pct) => (
            <button type="button" key={pct} onClick={() => setPercent(pct)} data-testid={`quick-fill-${pct}`}>
              {pct === 100 ? 'Max' : `${pct}%`}
            </button>
          ))}
        </div>
        <input
          type="range"
          className="slim-range"
          min={0}
          max={100}
          step={1}
          value={Math.min(100, Math.round(percentUsed))}
          aria-label="Percent of available balance"
          data-testid="size-percent-slider"
          style={{ ['--fill' as string]: `${Math.min(100, Math.round(percentUsed))}%` }}
          onChange={(e) => setPercent(Number(e.target.value))}
        />
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
          aria-label="Leverage"
          style={{ ['--fill' as string]: `${leverageFill}%` }}
          onChange={(e) => {
            setLeverageTouched(true);
            setLeverageX(Number(e.target.value));
          }}
        />
        <div className="bounds">
          <span>1×</span>
          <span>{maxLeverageX}× max</span>
        </div>
      </div>

      <label className={styles.checkbox}>
        <input type="checkbox" checked={tpSlOn} onChange={(e) => setTpSlOn(e.target.checked)} data-testid="tpsl-toggle" />
        Take profit / Stop loss
      </label>
      {tpSlOn ? (
        <div className={styles.tpSl}>
          <div className="field-group">
            <div className="field-label-row"><span>Take profit</span></div>
            <input data-testid="tp-input" inputMode="decimal" placeholder="0.00" value={tpInput} onChange={(e) => setTpInput(e.target.value)} />
            {tpSl.tp ? <p className="error-text" data-testid="tp-error">{tpSl.tp}</p> : null}
          </div>
          <div className="field-group">
            <div className="field-label-row"><span>Stop loss</span></div>
            <input data-testid="sl-input" inputMode="decimal" placeholder="0.00" value={slInput} onChange={(e) => setSlInput(e.target.value)} />
            {tpSl.sl ? <p className="error-text" data-testid="sl-error">{tpSl.sl}</p> : null}
          </div>
        </div>
      ) : null}

      {ticket && ticket.sizeBaseRaw > 0n ? <RiskPreview entry={entryPrice} liq={estLiqPrice} tp={tpRaw} sl={slRaw} /> : null}

      {isDegraded ? (
        <p role="alert" className="error-text" data-testid="open-blocked-degraded">
          Opening is disabled: the price feed is degraded
          {price?.minHealthyVenues != null ? ` (fewer than ${price.minHealthyVenues} healthy venues)` : ''}.
        </p>
      ) : null}
      {kind === 'MARKET' && !quote && quoteUnavailable.length > 0 ? (
        <p className="error-text" data-testid="quote-unavailable">No quote: {quoteUnavailable[0]?.detail}</p>
      ) : null}
      {leverageTooHigh ? <p className="error-text">Leverage exceeds this market&apos;s maximum.</p> : null}
      {insufficientBalance ? <p className="error-text">Insufficient USDW balance.</p> : null}

      {needsFunds ? (
        <div className="faucet-row" data-testid="faucet-row">
          <button type="button" data-testid="faucet-button" onClick={faucet.claim} disabled={faucet.pending}>
            {faucet.pending ? 'Claiming…' : 'Get testnet USDW'}
          </button>
        </div>
      ) : null}
      {faucet.error ? (
        <p role="alert" className="error-text" data-testid="faucet-error">{faucet.error}</p>
      ) : null}

      <dl className={styles.summary}>
        <div>
          <dt>Current position</dt>
          <dd data-testid="current-position" className={currentPosition === null ? undefined : currentPosition >= 0n ? styles.long : styles.short}>
            {currentPosition === null
              ? '—'
              : `${currentPosition >= 0n ? '+' : '−'}${formatMoney(currentPosition >= 0n ? currentPosition : -currentPosition, PRICE_DECIMALS_NUM, { fractionDigits: 4 })} ${baseAsset}`}
          </dd>
        </div>
        <div>
          <dt>Liquidation price</dt>
          <dd data-testid="est-liq-price" className={estLiqPrice !== null ? styles.liq : undefined}>
            {estLiqPrice !== null ? formatMoney(estLiqPrice, PRICE_DECIMALS_NUM) : '—'}
          </dd>
        </div>
        <div>
          <dt>Order value</dt>
          <dd data-testid="order-value">{ticket ? `${formatMoney(ticket.notionalRaw, COLLATERAL_DECIMALS)} USDW` : '—'}</dd>
        </div>
        <div>
          <dt>Order quantity</dt>
          <dd data-testid="order-quantity">
            {ticket && ticket.sizeBaseRaw > 0n ? `${formatMoney(ticket.sizeBaseRaw, PRICE_DECIMALS_NUM, { fractionDigits: 6 })} ${baseAsset}` : '—'}
          </dd>
        </div>
        <div>
          <dt>Margin required</dt>
          <dd data-testid="margin-required">{collateralRaw !== null ? `${formatMoney(collateralRaw, COLLATERAL_DECIMALS)} USDW` : '—'}</dd>
        </div>
        <div>
          <dt>{kind === 'MARKET' ? 'Quoted price' : 'Trigger price'}</dt>
          <dd data-testid="quoted-price">{entryPrice > 0n ? formatMoney(entryPrice, PRICE_DECIMALS_NUM) : '—'}</dd>
        </div>
        {kind === 'MARKET' ? (
          <div>
            <dt>Slippage</dt>
            <dd data-testid="slippage">
              <span>Est: {quote ? formatPercent18(buy ? quote.buySlippageP : quote.sellSlippageP) : '—'}</span>
              {' / '}
              {editingSlippage ? (
                <input
                  className={styles.slippageInput}
                  data-testid="max-slippage-input"
                  inputMode="decimal"
                  autoFocus
                  defaultValue={formatMoney(maxSlippageBps, 2, { grouping: false })}
                  onBlur={(e) => {
                    try {
                      const bps = parseHumanDecimal(e.target.value, 2);
                      if (bps > 0n && bps <= MAX_SLIPPAGE_BPS) setMaxSlippageBps(bps);
                    } catch {
                      // keep the previous tolerance
                    }
                    setEditingSlippage(false);
                  }}
                />
              ) : (
                <button type="button" className={styles.linkButton} data-testid="max-slippage" onClick={() => setEditingSlippage(true)}>
                  Max: {formatMoney(effectiveSlippageBps, 2, { grouping: false })}%
                </button>
              )}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Fee</dt>
          <dd data-testid="fee">
            {fees.takerFeeRaw !== null ? `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%` : '—'}
            {ticket?.feeRaw != null ? ` / ${formatMoney(ticket.feeRaw, COLLATERAL_DECIMALS)} USDW` : ''}
          </dd>
        </div>
      </dl>

      <div className="submit-row">
        <button type="submit" className={buy ? 'long' : 'short'} data-testid="submit-open-button" disabled={!canSubmit}>
          {submitLabel}
        </button>
        {state.phase === 'approving' ? (
          <p className="approval-notice" role="status" data-testid="approval-notice">
            First order from this wallet — it will ask twice: once to allow USDW, then for the order itself.
          </p>
        ) : null}
      </div>

      {state.phase === 'error' ? (
        <p role="alert" className="error-text" data-testid="open-error">{state.message}</p>
      ) : null}

      {state.phase === 'placed' ? (
        <p role="status" className={styles.status} data-testid="order-placed">
          {KIND_LABEL[state.kind]} order placed. It rests on chain until the price reaches it — see Open Orders.
        </p>
      ) : null}

      {state.phase === 'submitted' ? (
        <div className={styles.status} data-testid="order-pending-banner" role="status">
          {!submittedOrder || submittedOrder.status === 'pending' ? (
            <p className={styles.status}>
              Order requested (id {state.orderId || '—'}). Nothing has happened yet — the position opens, or the order
              is cancelled, once a keeper delivers the signed price report.
            </p>
          ) : submittedOrder.status === 'executed' ? (
            <p className={`${styles.status} ${styles.long}`} data-testid="order-filled">Filled — your position is now open.</p>
          ) : (
            <p data-testid="order-cancelled" className="error-text">
              Cancelled ({submittedOrder.cancelReason ?? 'unknown reason'}): {explainCancelReason(submittedOrder.cancelReason ?? '')}
            </p>
          )}
        </div>
      ) : null}
    </form>
  );
}
