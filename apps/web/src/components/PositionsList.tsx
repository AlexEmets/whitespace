'use client';

import { useState } from 'react';
import { maxUint256 } from 'viem';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { useCloseTrade } from '@/hooks/useCloseTrade';
import { useErc20 } from '@/hooks/useErc20';
import { useLiquidationPrice } from '@/hooks/useLiquidationPrice';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useOrdersWithChain } from '@/hooks/useChainPendingOrders';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositions } from '@/hooks/usePositions';
import { usePrice } from '@/hooks/usePrice';
import { useQuoteInputs } from '@/hooks/useQuote';
import { useTradingActions } from '@/hooks/useTradingActions';
import { CALLBACKS_ABI, PAIR_INFOS_ABI, TRADING_STORAGE_ABI, explainCancelReason, humanizeCancelReason } from '@/lib/abi';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { CALLBACKS_ADDRESS, PAIR_INFOS_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { closeSlippageBps } from '@/lib/closeTicket';
import { marketLabel } from '@/lib/markets';
import { collateralToRaw, formatBps, formatLeverage, formatMoney, leverageToRaw, parseHumanDecimal, priceToRaw } from '@/lib/money';
import { updateSlError, updateTpError } from '@/lib/orderRules';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import { leverageAfterRemoval, marginUsagePercent, netFundingForDisplay, valueAt } from '@/lib/positionMath';
import { nearestLiquidation, stackPositions, type PositionStack } from '@/lib/positionStack';
import type { MarketSummary, PositionSummary } from '@/lib/types';
import { openPositionShareCard, roeBps } from '@/lib/shareCard';
import { describeTxError } from '@/lib/tx';
import { ClosePositionDialog, type CloseOutcome } from './ClosePositionDialog';
import { ShareTradeButton } from './share/ShareTradeButton';
import { Spinner } from './Spinner';

function parseOptional(text: string, decimals: number): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseHumanDecimal(text, decimals);
  } catch {
    return null;
  }
}

/**
 * TP/SL and isolated-margin edits for one open position. Each write is simulated first
 * (useTradingActions) and validated against the contract's own bounds (lib/orderRules.ts).
 */
function PositionManager({ position }: { position: PositionSummary }) {
  const { address } = useAccount();
  const actions = useTradingActions();
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const [tpInput, setTpInput] = useState(priceToRaw(position.tp) > 0n ? position.tp : '');
  const [slInput, setSlInput] = useState(priceToRaw(position.sl) > 0n ? position.sl : '');
  const [marginInput, setMarginInput] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const openPrice = priceToRaw(position.openPrice);
  const leverage = leverageToRaw(position.leverage);

  const info = useReadContract({
    address: TRADING_STORAGE_ADDRESS,
    abi: TRADING_STORAGE_ABI,
    functionName: 'openTradesInfo',
    args: address ? [address, position.pairIndex, position.index] : undefined,
    query: { enabled: Boolean(address) },
  });
  const maxSl = useReadContract({ address: CALLBACKS_ADDRESS, abi: CALLBACKS_ABI, functionName: 'maxSl_P' });
  const initialLeverage = info.data ? BigInt(info.data[2]) : leverage;

  const tpRaw = parseOptional(tpInput, PRICE_DECIMALS_NUM);
  const slRaw = parseOptional(slInput, PRICE_DECIMALS_NUM);
  const marginRaw = parseOptional(marginInput, COLLATERAL_DECIMALS);

  const tpError =
    tpRaw === null ? 'Not a price.' : updateTpError({ buy: position.buy, openPrice, leverage, initialLeverage, newTp: tpRaw });
  const slError =
    slRaw === null
      ? 'Not a price.'
      : maxSl.data === undefined
        ? null
        : updateSlError({ buy: position.buy, openPrice, leverage, maxSlP: BigInt(maxSl.data), newSl: slRaw });

  // Removing margin raises leverage, and the keeper report that applies it deletes a stop loss
  // the new leverage puts beyond maxSl_P (WhitespaceTradingCallbacks.handleRemoveCollateral ->
  // correctToNullSl). It used to say "Removal requested" and then leave the position with no
  // stop. It also takes the oracle fee from the WALLET, which nothing mentioned.
  const fees = useMarketFees(position.pairIndex);
  const oracleFee = fees.oracleFeeRaw;
  const collateralRaw = collateralToRaw(position.collateral);
  const removing = marginRaw !== null && marginRaw > 0n && marginRaw < collateralRaw;
  const newLeverage = removing ? leverageAfterRemoval(collateralRaw, leverage, marginRaw!) : null;
  const currentSl = priceToRaw(position.sl);
  const removalDropsSl =
    newLeverage !== null &&
    currentSl > 0n &&
    maxSl.data !== undefined &&
    updateSlError({ buy: position.buy, openPrice, leverage: newLeverage, maxSlP: BigInt(maxSl.data), newSl: currentSl }) !== null;
  const cannotPayFee = oracleFee !== null && erc20.balance < oracleFee;

  async function run(label: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: label });
    } catch (err) {
      const text = describeTxError(err);
      if (text !== null) setMessage({ ok: false, text });
    }
  }

  const busy = actions.pending !== null;

  return (
    <div className="position-manager" data-testid={`position-manager-${position.pairIndex}-${position.index}`}>
      <div className="manager-field">
        <label>
          Take profit
          <input data-testid="manage-tp-input" inputMode="decimal" value={tpInput} onChange={(e) => setTpInput(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="manage-tp-save"
          disabled={busy || tpError !== null}
          onClick={() => run('Take profit updated.', () => actions.updateTp(position.pairIndex, position.index, tpRaw!))}
        >
          Set TP
        </button>
        {tpError && tpInput ? <span className="error-text" data-testid="manage-tp-error">{tpError}</span> : null}
      </div>
      <div className="manager-field">
        <label>
          Stop loss
          <input data-testid="manage-sl-input" inputMode="decimal" value={slInput} onChange={(e) => setSlInput(e.target.value)} placeholder="none" />
        </label>
        <button
          type="button"
          data-testid="manage-sl-save"
          disabled={busy || slError !== null}
          onClick={() =>
            run(slRaw === 0n ? 'Stop loss removed.' : 'Stop loss updated.', () =>
              actions.updateSl(position.pairIndex, position.index, slRaw!),
            )
          }
        >
          {slRaw === 0n ? 'Remove SL' : 'Set SL'}
        </button>
        {slError ? <span className="error-text" data-testid="manage-sl-error">{slError}</span> : null}
      </div>
      <div className="manager-field">
        <label>
          Margin (USDW)
          <input data-testid="manage-margin-input" inputMode="decimal" value={marginInput} onChange={(e) => setMarginInput(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="manage-margin-add"
          disabled={busy || marginRaw === null || marginRaw <= 0n || marginRaw > erc20.balance}
          onClick={() =>
            run('Margin added.', async () => {
              if (erc20.allowance < marginRaw!) {
                await erc20.approve(maxUint256);
                await erc20.refetchAllowance();
              }
              await actions.topUpCollateral(position.pairIndex, position.index, marginRaw!);
            })
          }
        >
          Add
        </button>
        <button
          type="button"
          data-testid="manage-margin-remove"
          disabled={busy || !removing || removalDropsSl || cannotPayFee}
          onClick={() =>
            run('Removal requested — the keeper report applies it, or rejects it if it would leave the position under-margined.', async () => {
              if (oracleFee !== null && erc20.allowance < oracleFee) {
                await erc20.approve(maxUint256);
                await erc20.refetchAllowance();
              }
              await actions.removeCollateral(position.pairIndex, position.index, marginRaw!);
            })
          }
        >
          Remove
        </button>
      </div>
      {removing && oracleFee !== null ? (
        <p className="dash" data-testid="manage-remove-fee">
          Removing margin costs a {formatMoney(oracleFee, COLLATERAL_DECIMALS)} USDW oracle fee, paid from your wallet.
        </p>
      ) : null}
      {removing && cannotPayFee ? (
        <p className="error-text" data-testid="manage-remove-no-fee">Your wallet cannot cover the oracle fee for this request.</p>
      ) : null}
      {removalDropsSl ? (
        <p className="error-text" data-testid="manage-remove-drops-sl">
          This raises leverage to {formatLeverage(newLeverage!)} and your stop loss would be deleted when it applies. Move the
          stop closer first, or remove less.
        </p>
      ) : null}
      {message ? (
        <p className={message.ok ? 'ok-text' : 'error-text'} role={message.ok ? 'status' : 'alert'} data-testid="manage-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function PositionRow({ position, market, nested = false }: { position: PositionSummary; market: MarketSummary | undefined; nested?: boolean }) {
  const { address } = useAccount();
  const { data: price } = usePrice(position.pairIndex);
  const { closeTrade } = useCloseTrade();
  const [closeOpen, setCloseOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // The close request being followed, by order id. The "pending" note used to be a flag that
  // was set and never cleared, so after a partial close, or a close cancelled for SLIPPAGE, the
  // row said "pending keeper execution" forever and never said that the close had failed.
  const [closeRequested, setCloseRequested] = useState<{ orderId: string | null } | null>(null);
  const { orders } = useOrdersWithChain(address);
  const closeOrder = closeRequested?.orderId ? orders.find((o) => o.orderId === closeRequested.orderId) : undefined;
  // While a close is in flight the row shows a spinner, not an explanation of the oracle
  // pipeline. Only a close that will not happen gets words, and few of them.
  const closeNote: { state: 'pending' } | { state: 'failed'; text: string; detail: string } | null =
    closeRequested === null
      ? null
      : closeOrder?.status === 'cancelled'
        ? {
            state: 'failed',
            text: `Close cancelled: ${humanizeCancelReason(closeOrder.cancelReason)}`,
            detail: explainCancelReason(closeOrder.cancelReason ?? ''),
          }
        : closeOrder?.status === 'executed' || closeOrder?.status === 'timeout'
          ? null
          : closeOrder?.expired
            ? { state: 'failed', text: 'Close did not fill — release it in Orders', detail: 'No price report arrived in time.' }
            : { state: 'pending' };

  const collateralRaw = collateralToRaw(position.collateral);
  const leverageRaw = leverageToRaw(position.leverage);
  const markRaw = price ? priceToRaw(price.mark) : null;

  const pnl =
    price === undefined || price === null
      ? null
      : estimateUnrealisedPnl({
          collateral: position.collateral,
          leverage: position.leverage,
          openPrice: position.openPrice,
          markPrice: price.mark,
          buy: position.buy,
        });

  const sizeBase = estimatePositionSizeBase({
    collateral: position.collateral,
    leverage: position.leverage,
    openPrice: position.openPrice,
  });
  const signedSize = position.buy ? sizeBase : -sizeBase;

  const liqPrice = useLiquidationPrice({
    trader: address,
    pairIndex: position.pairIndex,
    index: position.index,
    openPriceRaw: priceToRaw(position.openPrice),
    long: position.buy,
    collateralRaw,
    leverageRaw,
    maxLeverageRaw: market ? leverageToRaw(market.maxLeverage) : 0n,
  });

  const feeArgs = address
    ? ([address, position.pairIndex, position.index, position.buy, collateralRaw, Number(leverageRaw)] as const)
    : undefined;
  const funding = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'getTradeFundingFee',
    args: feeArgs,
    query: { enabled: Boolean(feeArgs), refetchInterval: 30_000 },
  });
  const rollover = useReadContract({
    address: PAIR_INFOS_ADDRESS,
    abi: PAIR_INFOS_ABI,
    functionName: 'getTradeRolloverFee',
    args: feeArgs,
    query: { enabled: Boolean(feeArgs), refetchInterval: 30_000 },
  });
  const netFunding =
    funding.data !== undefined && rollover.data !== undefined ? netFundingForDisplay(funding.data[0], rollover.data) : null;

  const usage =
    liqPrice !== null && markRaw !== null
      ? marginUsagePercent({ buy: position.buy, entry: priceToRaw(position.openPrice), mark: markRaw, liq: liqPrice })
      : null;

  const { inputs: quoteInputs } = useQuoteInputs(position.pairIndex);
  const slippageForShare = (share: number) =>
    closeSlippageBps(quoteInputs, { buy: position.buy, collateralRaw, leverageRaw, share }, DEFAULT_SLIPPAGE_BPS);

  /** `share` is the contract's PRECISION_2 percent, 10000 for all of it. Errors are shown
   * in the dialog, which stays open for them; a declined signature just leaves it open. */
  async function submitClose(share: number): Promise<CloseOutcome> {
    if (!price) return { done: false, error: 'There is no live price to close against right now.' };
    try {
      const sent = await closeTrade({
        pairIndex: position.pairIndex,
        index: position.index,
        closePercentage: share,
        marketPriceRaw: priceToRaw(price.mark),
        slippageBps: slippageForShare(share),
      });
      setCloseRequested({ orderId: sent.orderId === undefined ? null : sent.orderId.toString() });
      return { done: true };
    } catch (err) {
      return { done: false, error: describeTxError(err) };
    }
  }

  const tp = priceToRaw(position.tp);
  const sl = priceToRaw(position.sl);

  return (
    <>
      <tr data-testid={`position-row-${position.pairIndex}-${position.index}`} className={nested ? 'leg-row' : undefined}>
        {/* Two-line cells, columns by importance: what a narrow screen hides is what is
            least needed, and UPnL — the figure the tab is opened for — comes second. Each
            figure carries its name in data-label for the card layout on phones. */}
        <td className="cell-instrument">
          <span className="cell-main">
            <span className={`side-bar ${position.buy ? 'long' : 'short'}`} aria-hidden="true" />
            {marketLabel(market, position.pairIndex)}
          </span>
          <span className={`cell-sub ${position.buy ? 'pos' : 'neg'}`}>
            {position.buy ? 'Long' : 'Short'} {formatLeverage(position.leverage)}
          </span>
        </td>
        <td data-label="UPnL" data-testid="unrealized-pnl" className={pnl !== null && pnl >= 0n ? 'pos' : 'neg'}>
          <span className="cell-main">{pnl === null ? '—' : formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })}</span>
          {pnl !== null ? (
            <span className="cell-sub">
              {pnl >= 0n ? '+' : ''}
              {formatBps(roeBps(pnl, collateralRaw))}
            </span>
          ) : null}
        </td>
        <td data-label="Size / Value">
          <span className={`cell-main ${position.buy ? 'pos' : 'neg'}`}>
            {formatMoney(signedSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false, signDisplay: true })}{' '}
            {market?.from ?? ''}
          </span>
          <span className="cell-sub" data-testid="position-value">
            {markRaw !== null ? formatMoney(valueAt(sizeBase, markRaw), COLLATERAL_DECIMALS) : '—'}
          </span>
        </td>
        <td data-label="Entry / Mark">
          <span className="cell-main">{formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}</span>
          <span className="cell-sub">{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</span>
        </td>
        {/* Neutral, not red: a liquidation price is a level, not a loss. */}
        <td data-label="Liq. price" className={liqPrice !== null ? undefined : 'dash'} data-testid="liq-price">
          {liqPrice !== null ? formatMoney(liqPrice, PRICE_DECIMALS_NUM) : '—'}
        </td>
        <td data-label="Margin" data-testid="position-margin">
          <span className="cell-main">{formatMoney(position.collateral, COLLATERAL_DECIMALS)}</span>
          {usage !== null ? <span className="cell-sub usage">{usage.toFixed(2)}% used</span> : null}
        </td>
        <td data-label="TP / SL" data-testid="position-tpsl">
          <span className="cell-main">TP {tp > 0n ? formatMoney(tp, PRICE_DECIMALS_NUM) : '—'}</span>
          <span className="cell-sub">SL {sl > 0n ? formatMoney(sl, PRICE_DECIMALS_NUM) : '—'}</span>
        </td>
        <td data-label="Funding" data-testid="position-funding" className={netFunding === null ? 'dash' : netFunding >= 0n ? 'pos' : 'neg'}>
          {netFunding === null ? '—' : formatMoney(netFunding, COLLATERAL_DECIMALS, { signDisplay: true })}
        </td>
        <td className="cell-actions">
          <div className="close-control">
            <button
              type="button"
              data-testid="close-position-button"
              aria-haspopup="dialog"
              disabled={!price}
              onClick={() => setCloseOpen(true)}
            >
              Close
            </button>
            <button
              type="button"
              className="close-more"
              aria-expanded={manageOpen}
              aria-label="TP/SL and margin"
              title="TP/SL and margin"
              data-testid="manage-toggle"
              onClick={() => setManageOpen((v) => !v)}
            >
              ⋯
            </button>
          </div>
          {address && market && price ? (
            <ShareTradeButton
              address={address}
              shareRef={{ kind: 'open', tradeId: position.tradeId }}
              card={openPositionShareCard(position, market.from, price.mark, Math.floor(Date.now() / 1000))}
              testId={`position-share-${position.pairIndex}-${position.index}`}
            />
          ) : null}
          {closeNote?.state === 'pending' ? (
            <span data-testid="close-pending" className="close-note">
              <Spinner label="Closing" />
              Closing…
            </span>
          ) : closeNote?.state === 'failed' ? (
            <span data-testid="close-pending" role="alert" className="close-note error-text" title={closeNote.detail}>
              {closeNote.text}
            </span>
          ) : null}
          <ClosePositionDialog
            open={closeOpen}
            onClose={() => setCloseOpen(false)}
            position={position}
            marketName={marketLabel(market, position.pairIndex)}
            baseAsset={market?.from ?? 'BASE'}
            sizeBaseRaw={sizeBase}
            pnlRaw={pnl}
            canClose={Boolean(price)}
            onConfirm={submitClose}
            slippageBpsForShare={slippageForShare}
          />
        </td>
      </tr>
      {manageOpen ? (
        <tr className="manager-row">
          <td colSpan={9}>
            <PositionManager position={position} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Take profit and stop loss for every trade of a stacked position at once. Margin stays a
 * per-trade edit (in each trade's own row): adding or removing it changes that trade's
 * liquidation level only, which a combined figure would hide. */
function StackTpSl({ stack }: { stack: PositionStack }) {
  const actions = useTradingActions();
  const maxSl = useReadContract({ address: CALLBACKS_ADDRESS, abi: CALLBACKS_ABI, functionName: 'maxSl_P' });
  const [tpInput, setTpInput] = useState(stack.tpMixed || priceToRaw(stack.summary.tp) === 0n ? '' : stack.summary.tp);
  const [slInput, setSlInput] = useState(stack.slMixed || priceToRaw(stack.summary.sl) === 0n ? '' : stack.summary.sl);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const tpRaw = parseOptional(tpInput, PRICE_DECIMALS_NUM);
  const slRaw = parseOptional(slInput, PRICE_DECIMALS_NUM);

  // The first trade the level is invalid for decides the message: each one is checked
  // against its own entry and leverage, exactly as the contract will check it.
  const firstError = (check: (leg: PositionSummary) => string | null) => {
    for (const leg of stack.legs) {
      const e = check(leg);
      if (e) return e;
    }
    return null;
  };
  const tpError =
    tpRaw === null
      ? 'Not a price.'
      : firstError((leg) =>
          updateTpError({ buy: leg.buy, openPrice: priceToRaw(leg.openPrice), leverage: leverageToRaw(leg.leverage), initialLeverage: leverageToRaw(leg.leverage), newTp: tpRaw }),
        );
  const slError =
    slRaw === null
      ? 'Not a price.'
      : maxSl.data === undefined
        ? null
        : firstError((leg) =>
            updateSlError({ buy: leg.buy, openPrice: priceToRaw(leg.openPrice), leverage: leverageToRaw(leg.leverage), maxSlP: BigInt(maxSl.data), newSl: slRaw }),
          );

  async function applyToAll(label: string, write: (leg: PositionSummary) => Promise<unknown>) {
    setMessage(null);
    let done = 0;
    try {
      for (const leg of stack.legs) {
        await write(leg);
        done++;
      }
      setMessage({ ok: true, text: label });
    } catch (err) {
      const text = describeTxError(err);
      if (text !== null) setMessage({ ok: false, text: done > 0 ? `Applied to ${done} of ${stack.legs.length} trades. ${text}` : text });
    }
  }

  const busy = actions.pending !== null;
  return (
    <div className="position-manager" data-testid={`stack-manager-${stack.key}`}>
      <div className="manager-field">
        <label>
          Take profit
          <input data-testid="stack-tp-input" inputMode="decimal" value={tpInput} placeholder={stack.tpMixed ? 'mixed' : undefined} onChange={(e) => setTpInput(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="stack-tp-save"
          disabled={busy || tpError !== null}
          onClick={() => applyToAll('Take profit updated.', (leg) => actions.updateTp(leg.pairIndex, leg.index, tpRaw!))}
        >
          Set TP
        </button>
        {tpError && tpInput ? <span className="error-text" data-testid="stack-tp-error">{tpError}</span> : null}
      </div>
      <div className="manager-field">
        <label>
          Stop loss
          <input data-testid="stack-sl-input" inputMode="decimal" value={slInput} placeholder={stack.slMixed ? 'mixed' : 'none'} onChange={(e) => setSlInput(e.target.value)} />
        </label>
        <button
          type="button"
          data-testid="stack-sl-save"
          disabled={busy || slError !== null}
          onClick={() => applyToAll(slRaw === 0n ? 'Stop loss removed.' : 'Stop loss updated.', (leg) => actions.updateSl(leg.pairIndex, leg.index, slRaw!))}
        >
          {slRaw === 0n ? 'Remove SL' : 'Set SL'}
        </button>
        {slError ? <span className="error-text" data-testid="stack-sl-error">{slError}</span> : null}
      </div>
      <p className="dash">Applies to all {stack.legs.length} trades. Margin is managed per trade below.</p>
      {message ? (
        <p className={message.ok ? 'ok-text' : 'error-text'} role={message.ok ? 'status' : 'alert'} data-testid="stack-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Several trades on one market and side, shown as one position (see lib/positionStack.ts).
 * Every figure is the combination of the trades' own on-chain figures: size, margin, PnL and
 * funding add up; entry is the size-weighted average; liquidation is the nearest of the
 * trades' levels, because each trade is liquidated on its own. Close closes the same share of
 * every trade; the individual trades open underneath for per-trade margin and closes.
 */
function StackedPositionRow({ stack, market }: { stack: PositionStack; market: MarketSummary | undefined }) {
  const { address } = useAccount();
  const { data: price } = usePrice(stack.pairIndex);
  const { closeTrade } = useCloseTrade();
  const [closeOpen, setCloseOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState<string[] | null>(null);
  const { orders } = useOrdersWithChain(address);
  const position = stack.summary;
  const markRaw = price ? priceToRaw(price.mark) : null;
  const maxLeverageRaw = market ? leverageToRaw(market.maxLeverage) : 0n;

  const liqReads = useReadContracts({
    contracts: address
      ? stack.legs.map((leg) => ({
          address: PAIR_INFOS_ADDRESS,
          abi: PAIR_INFOS_ABI,
          functionName: 'getTradeLiquidationPrice' as const,
          args: [
            address,
            leg.pairIndex,
            leg.index,
            priceToRaw(leg.openPrice),
            leg.buy,
            collateralToRaw(leg.collateral),
            Number(leverageToRaw(leg.leverage)),
            Number(maxLeverageRaw),
          ] as const,
        }))
      : [],
    query: { enabled: Boolean(address) && maxLeverageRaw > 0n },
  });
  const feeReads = useReadContracts({
    contracts: address
      ? stack.legs.flatMap((leg) => {
          const args = [address, leg.pairIndex, leg.index, leg.buy, collateralToRaw(leg.collateral), Number(leverageToRaw(leg.leverage))] as const;
          return [
            { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_ABI, functionName: 'getTradeFundingFee' as const, args },
            { address: PAIR_INFOS_ADDRESS, abi: PAIR_INFOS_ABI, functionName: 'getTradeRolloverFee' as const, args },
          ];
        })
      : [],
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });

  const liqLevels = stack.legs.map((_, i) => {
    const r = liqReads.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : null;
  });
  const liqPrice = maxLeverageRaw > 0n ? nearestLiquidation(stack.buy, liqLevels) : null;

  let netFunding: bigint | null = 0n;
  for (let i = 0; i < stack.legs.length; i++) {
    const f = feeReads.data?.[2 * i];
    const r = feeReads.data?.[2 * i + 1];
    if (f?.status !== 'success' || r?.status !== 'success' || netFunding === null) {
      netFunding = null;
      break;
    }
    netFunding += netFundingForDisplay((f.result as readonly [bigint, bigint])[0], r.result as bigint);
  }

  const pnl =
    price === undefined || price === null
      ? null
      : stack.legs.reduce(
          (sum, leg) =>
            sum + estimateUnrealisedPnl({ collateral: leg.collateral, leverage: leg.leverage, openPrice: leg.openPrice, markPrice: price.mark, buy: leg.buy }),
          0n,
        );
  const signedSize = stack.buy ? stack.sizeBaseRaw : -stack.sizeBaseRaw;
  const usage =
    liqPrice !== null && markRaw !== null
      ? marginUsagePercent({ buy: stack.buy, entry: priceToRaw(position.openPrice), mark: markRaw, liq: liqPrice })
      : null;

  const { inputs: quoteInputs } = useQuoteInputs(stack.pairIndex);
  const slippageFor = (leg: PositionSummary, share: number) =>
    closeSlippageBps(quoteInputs, { buy: leg.buy, collateralRaw: collateralToRaw(leg.collateral), leverageRaw: leverageToRaw(leg.leverage), share }, DEFAULT_SLIPPAGE_BPS);

  // Followed until every close request has resolved; the first cancellation or expiry is
  // what the row reports.
  const tracked = (closing ?? []).map((id) => orders.find((o) => o.orderId === id));
  const cancelled = tracked.find((o) => o?.status === 'cancelled');
  const expired = tracked.find((o) => o?.status === 'pending' && o.expired);
  const allDone = closing !== null && tracked.every((o) => o?.status === 'executed' || o?.status === 'timeout');
  const closeNote: { state: 'pending' } | { state: 'failed'; text: string; detail: string } | null =
    closing === null || allDone
      ? null
      : cancelled
        ? { state: 'failed', text: `Close cancelled: ${humanizeCancelReason(cancelled.cancelReason)}`, detail: explainCancelReason(cancelled.cancelReason ?? '') }
        : expired
          ? { state: 'failed', text: 'Close did not fill — release it in Orders', detail: 'No price report arrived in time.' }
          : { state: 'pending' };

  async function submitClose(share: number): Promise<CloseOutcome> {
    if (!price) return { done: false, error: 'There is no live price to close against right now.' };
    const sent: string[] = [];
    try {
      for (const leg of stack.legs) {
        const r = await closeTrade({
          pairIndex: leg.pairIndex,
          index: leg.index,
          closePercentage: share,
          marketPriceRaw: priceToRaw(price.mark),
          slippageBps: slippageFor(leg, share),
        });
        if (r.orderId !== undefined) sent.push(r.orderId.toString());
      }
      setClosing(sent);
      return { done: true };
    } catch (err) {
      if (sent.length) setClosing(sent);
      const text = describeTxError(err);
      return { done: false, error: sent.length ? `Close sent for ${sent.length} of ${stack.legs.length} trades. ${text ?? ''}`.trim() : text };
    }
  }

  const tp = priceToRaw(position.tp);
  const sl = priceToRaw(position.sl);
  const level = (raw: bigint, mixed: boolean) => (mixed ? 'mixed' : raw > 0n ? formatMoney(raw, PRICE_DECIMALS_NUM) : '—');

  return (
    <>
      <tr data-testid={`position-stack-${stack.key}`}>
        <td className="cell-instrument">
          <span className="cell-main">
            <span className={`side-bar ${stack.buy ? 'long' : 'short'}`} aria-hidden="true" />
            {marketLabel(market, stack.pairIndex)}
          </span>
          <span className={`cell-sub ${stack.buy ? 'pos' : 'neg'}`}>
            {stack.buy ? 'Long' : 'Short'} {formatLeverage(position.leverage)}
          </span>
        </td>
        <td data-label="UPnL" data-testid="unrealized-pnl" className={pnl !== null && pnl >= 0n ? 'pos' : 'neg'}>
          <span className="cell-main">{pnl === null ? '—' : formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })}</span>
          {pnl !== null ? (
            <span className="cell-sub">
              {pnl >= 0n ? '+' : ''}
              {formatBps(roeBps(pnl, collateralToRaw(position.collateral)))}
            </span>
          ) : null}
        </td>
        <td data-label="Size / Value">
          <span className={`cell-main ${stack.buy ? 'pos' : 'neg'}`}>
            {formatMoney(signedSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false, signDisplay: true })}{' '}
            {market?.from ?? ''}
          </span>
          <span className="cell-sub" data-testid="position-value">
            {markRaw !== null ? formatMoney(valueAt(stack.sizeBaseRaw, markRaw), COLLATERAL_DECIMALS) : '—'}
          </span>
        </td>
        <td data-label="Entry / Mark">
          <span className="cell-main" title="Size-weighted average entry">{formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}</span>
          <span className="cell-sub">{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</span>
        </td>
        <td
          data-label="Liq. price"
          className={liqPrice !== null ? undefined : 'dash'}
          data-testid="liq-price"
          title="The nearest liquidation level of the trades in this position"
        >
          {liqPrice !== null ? formatMoney(liqPrice, PRICE_DECIMALS_NUM) : '—'}
        </td>
        <td data-label="Margin" data-testid="position-margin">
          <span className="cell-main">{formatMoney(position.collateral, COLLATERAL_DECIMALS)}</span>
          {usage !== null ? <span className="cell-sub usage">{usage.toFixed(2)}% used</span> : null}
        </td>
        <td data-label="TP / SL" data-testid="position-tpsl">
          <span className="cell-main">TP {level(tp, stack.tpMixed)}</span>
          <span className="cell-sub">SL {level(sl, stack.slMixed)}</span>
        </td>
        <td data-label="Funding" data-testid="position-funding" className={netFunding === null ? 'dash' : netFunding >= 0n ? 'pos' : 'neg'}>
          {netFunding === null ? '—' : formatMoney(netFunding, COLLATERAL_DECIMALS, { signDisplay: true })}
        </td>
        <td className="cell-actions">
          <div className="close-control">
            <button type="button" data-testid="close-position-button" aria-haspopup="dialog" disabled={!price} onClick={() => setCloseOpen(true)}>
              Close
            </button>
            <button
              type="button"
              className="close-more"
              aria-expanded={expanded}
              title="TP/SL and the trades in this position"
              data-testid="stack-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {stack.legs.length} trades
            </button>
          </div>
          {closeNote?.state === 'pending' ? (
            <span data-testid="close-pending" className="close-note">
              <Spinner label="Closing" />
              Closing…
            </span>
          ) : closeNote?.state === 'failed' ? (
            <span data-testid="close-pending" role="alert" className="close-note error-text" title={closeNote.detail}>
              {closeNote.text}
            </span>
          ) : null}
          <ClosePositionDialog
            open={closeOpen}
            onClose={() => setCloseOpen(false)}
            position={position}
            marketName={marketLabel(market, stack.pairIndex)}
            baseAsset={market?.from ?? 'BASE'}
            sizeBaseRaw={stack.sizeBaseRaw}
            pnlRaw={pnl}
            canClose={Boolean(price)}
            onConfirm={submitClose}
            slippageBpsForShare={(share) => slippageFor(position, share)}
          />
        </td>
      </tr>
      {expanded ? (
        <>
          <tr className="manager-row">
            <td colSpan={9}>
              <StackTpSl stack={stack} />
            </td>
          </tr>
          {stack.legs.map((leg) => (
            <PositionRow key={`${leg.pairIndex}-${leg.index}`} position={leg} market={market} nested />
          ))}
        </>
      ) : null}
    </>
  );
}

export function PositionsList() {
  const { address } = useAccount();
  const { positions, loading, error, stale } = usePositions(address);
  const { markets } = useMarkets();

  if (!address) return <p>Connect your wallet to see positions.</p>;
  if (loading) return <p>Loading positions…</p>;
  if (error) return <p className="error-text">Failed to load positions: {error.message}</p>;
  if (positions.length === 0) return <p data-testid="no-positions">No open positions.</p>;

  return (
    <>
      {stale ? (
        <p role="status" className="error-text" data-testid="positions-stale">
          Live data is unavailable right now — showing the last known positions.
        </p>
      ) : null}
      <table className="data-table" data-testid="positions-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>UPnL</th>
            <th>Size / Value</th>
            <th>Entry / Mark</th>
            <th>Liq. price</th>
            <th>Margin</th>
            <th>TP / SL</th>
            <th>Funding</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stackPositions(positions).map((s) => {
            const market = markets.find((m) => m.pairIndex === s.pairIndex);
            return s.legs.length === 1 ? (
              <PositionRow key={s.key} position={s.summary} market={market} />
            ) : (
              <StackedPositionRow key={s.key} stack={s} market={market} />
            );
          })}
        </tbody>
      </table>
    </>
  );
}
