'use client';

import { useState } from 'react';
import { maxUint256 } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { useCloseTrade, FULL_CLOSE_PERCENT } from '@/hooks/useCloseTrade';
import { useErc20 } from '@/hooks/useErc20';
import { useLiquidationPrice } from '@/hooks/useLiquidationPrice';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositions } from '@/hooks/usePositions';
import { usePrice } from '@/hooks/usePrice';
import { useTradingActions } from '@/hooks/useTradingActions';
import { CALLBACKS_ABI, PAIR_INFOS_ABI, TRADING_STORAGE_ABI } from '@/lib/abi';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { CALLBACKS_ADDRESS, PAIR_INFOS_ADDRESS, TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { marketLabel } from '@/lib/markets';
import { collateralToRaw, formatLeverage, formatMoney, leverageToRaw, parseHumanDecimal, priceToRaw } from '@/lib/money';
import { updateSlError, updateTpError } from '@/lib/orderRules';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import { marginUsagePercent, netFundingForDisplay, valueAt } from '@/lib/positionMath';
import type { MarketSummary, PositionSummary } from '@/lib/types';
import { describeTxError } from '@/lib/tx';

/** Fixed partial-close sizes behind the chevron: the contract takes any percentage, and a
 * fixed set removes the typo class a free input invites on a control that exits leverage. */
const PARTIAL_PERCENTS = [25, 50, 75] as const;

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
          disabled={busy || marginRaw === null || marginRaw <= 0n || marginRaw >= collateralToRaw(position.collateral)}
          onClick={() =>
            run('Removal requested — the keeper report applies it, or rejects it if it would leave the position under-margined.', () =>
              actions.removeCollateral(position.pairIndex, position.index, marginRaw!),
            )
          }
        >
          Remove
        </button>
      </div>
      {message ? (
        <p className={message.ok ? 'ok-text' : 'error-text'} role={message.ok ? 'status' : 'alert'} data-testid="manage-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function PositionRow({ position, market }: { position: PositionSummary; market: MarketSummary | undefined }) {
  const { address } = useAccount();
  const { data: price } = usePrice(position.pairIndex);
  const { closeTrade, isPending } = useCloseTrade();
  const [partialOpen, setPartialOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  async function handleClose(percent: number) {
    if (!price) return;
    setStatus('submitting');
    setErrorMessage(null);
    try {
      await closeTrade({
        pairIndex: position.pairIndex,
        index: position.index,
        closePercentage: percent === 100 ? FULL_CLOSE_PERCENT : Math.round((percent / 100) * FULL_CLOSE_PERCENT),
        marketPriceRaw: priceToRaw(price.mark),
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      setStatus('submitted');
    } catch (err) {
      // A rejected signature is not a failure: back to idle so the row offers Close again.
      const message = describeTxError(err);
      setStatus(message === null ? 'idle' : 'error');
      setErrorMessage(message);
    }
  }

  const tp = priceToRaw(position.tp);
  const sl = priceToRaw(position.sl);

  return (
    <>
      <tr data-testid={`position-row-${position.pairIndex}-${position.index}`}>
        <td>
          <span className={`side-bar ${position.buy ? 'long' : 'short'}`} aria-hidden="true" />
          {marketLabel(market, position.pairIndex)} <span className="row-leverage">{formatLeverage(position.leverage)}</span>
        </td>
        <td className={position.buy ? 'pos' : 'neg'}>
          {formatMoney(signedSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false, signDisplay: true })}
        </td>
        <td>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</td>
        <td data-testid="position-value">{markRaw !== null ? formatMoney(valueAt(sizeBase, markRaw), COLLATERAL_DECIMALS) : '—'}</td>
        <td>{formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}</td>
        {/* Neutral, not red: a liquidation price is a level, not a loss. */}
        <td className={liqPrice !== null ? undefined : 'dash'} data-testid="liq-price">
          {liqPrice !== null ? formatMoney(liqPrice, PRICE_DECIMALS_NUM) : '—'}
        </td>
        <td data-testid="position-margin">
          {formatMoney(position.collateral, COLLATERAL_DECIMALS)}
          {usage !== null ? <span className="usage"> ({usage.toFixed(2)}%)</span> : null}
        </td>
        <td data-testid="position-funding" className={netFunding === null ? 'dash' : netFunding >= 0n ? 'pos' : 'neg'}>
          {netFunding === null ? '—' : formatMoney(netFunding, COLLATERAL_DECIMALS, { signDisplay: true })}
        </td>
        <td data-testid="unrealized-pnl" className={pnl !== null && pnl >= 0n ? 'pos' : 'neg'}>
          {pnl === null ? '—' : formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })}
        </td>
        <td data-testid="position-tpsl">
          {tp > 0n ? formatMoney(tp, PRICE_DECIMALS_NUM) : '—'} / {sl > 0n ? formatMoney(sl, PRICE_DECIMALS_NUM) : '—'}
        </td>
        <td>
          <div className="close-control">
            <button
              type="button"
              data-testid="close-position-button"
              disabled={!price || isPending || status === 'submitting'}
              onClick={() => handleClose(100)}
            >
              {status === 'submitting' ? 'Closing…' : 'Close'}
            </button>
            <button
              type="button"
              className="close-more"
              aria-expanded={partialOpen}
              aria-label="Close part of this position"
              data-testid="close-partial-toggle"
              onClick={() => setPartialOpen((v) => !v)}
            >
              ‹
            </button>
            <button
              type="button"
              className="close-more"
              aria-expanded={manageOpen}
              data-testid="manage-toggle"
              onClick={() => setManageOpen((v) => !v)}
            >
              TP/SL · Margin
            </button>
          </div>
          {partialOpen ? (
            <div className="close-partial" data-testid="close-partial-row">
              {PARTIAL_PERCENTS.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  data-testid={`close-partial-${pct}`}
                  disabled={!price || isPending || status === 'submitting'}
                  onClick={() => handleClose(pct)}
                >
                  {pct}%
                </button>
              ))}
            </div>
          ) : null}
          {status === 'submitted' ? (
            <span data-testid="close-pending" role="status">
              {' '}
              Close requested — pending keeper execution.
            </span>
          ) : null}
          {status === 'error' ? (
            <span role="alert" className="error-text">
              {' '}
              {errorMessage}
            </span>
          ) : null}
        </td>
      </tr>
      {manageOpen ? (
        <tr className="manager-row">
          <td colSpan={11}>
            <PositionManager position={position} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function PositionsList() {
  const { address } = useAccount();
  const { positions, loading, error } = usePositions(address);
  const { markets } = useMarkets();

  if (!address) return <p>Connect your wallet to see positions.</p>;
  if (loading) return <p>Loading positions…</p>;
  if (error) return <p className="error-text">Failed to load positions: {error.message}</p>;
  if (positions.length === 0) return <p data-testid="no-positions">No open positions.</p>;

  return (
    <table className="data-table" data-testid="positions-table">
      <thead>
        <tr>
          <th>Instrument</th>
          <th>Quantity</th>
          <th>Mark</th>
          <th>Value</th>
          <th>Entry</th>
          <th>Liq. price</th>
          <th>Margin (usage)</th>
          <th>Funding</th>
          <th>UPnL</th>
          <th>TP / SL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <PositionRow key={`${p.pairIndex}-${p.index}`} position={p} market={markets.find((m) => m.pairIndex === p.pairIndex)} />
        ))}
      </tbody>
    </table>
  );
}
