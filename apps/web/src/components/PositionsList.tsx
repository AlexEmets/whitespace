'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useCloseTrade, FULL_CLOSE_PERCENT } from '@/hooks/useCloseTrade';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositions } from '@/hooks/usePositions';
import { usePrice } from '@/hooks/usePrice';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { useLiquidationPrice } from '@/hooks/useLiquidationPrice';
import { marketLabel } from '@/lib/markets';
import { collateralToRaw, formatLeverage, formatMoney, leverageToRaw, priceToRaw } from '@/lib/money';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import type { MarketSummary, PositionSummary } from '@/lib/types';
import { describeTxError } from '@/lib/tx';

/** The partial-close sizes offered behind the chevron. The contract takes any percentage
 * (`closeTradeMarket`'s `closePercentage`); these are the three anyone actually reaches
 * for, and a fixed set removes the typo class that a free number input invites on a
 * control that exits a leveraged position. */
const PARTIAL_PERCENTS = [25, 50, 75] as const;

function PositionRow({ position, market }: { position: PositionSummary; market: MarketSummary | undefined }) {
  const { address } = useAccount();
  const { data: price } = usePrice(position.pairIndex);
  const { closeTrade, isPending } = useCloseTrade();
  const [partialOpen, setPartialOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pnl = price
    ? estimateUnrealisedPnl({
        collateral: position.collateral,
        leverage: position.leverage,
        openPrice: position.openPrice,
        markPrice: price.mark,
        buy: position.buy,
      })
    : null;

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
    collateralRaw: collateralToRaw(position.collateral),
    leverageRaw: leverageToRaw(position.leverage),
    // The pair's cap, not this trade's leverage — it is what the contract's liquidation
    // margin scales against. Zero while /markets is still loading, which keeps the read
    // disabled rather than firing with a wrong bound.
    maxLeverageRaw: market ? leverageToRaw(market.maxLeverage) : 0n,
  });

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
      // A rejected signature is not a failure: fall back to idle so the row simply offers
      // Close again, rather than accusing the trader of an error they chose.
      const message = describeTxError(err);
      setStatus(message === null ? 'idle' : 'error');
      setErrorMessage(message);
    }
  }

  return (
    <tr data-testid={`position-row-${position.pairIndex}-${position.index}`}>
      {/* The reference marks each row's side with a coloured bar before the symbol, which
          is the only place the row says long or short — SIZE carries a sign, but a bar is
          read at a glance across a stack of rows. */}
      <td>
        <span className={`side-bar ${position.buy ? 'long' : 'short'}`} aria-hidden="true" />
        {marketLabel(market, position.pairIndex)}{' '}
        <span className="row-leverage">{formatLeverage(position.leverage)}</span>
      </td>
      <td className={position.buy ? 'pos' : 'neg'}>{formatMoney(signedSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false, signDisplay: true })}</td>
      <td>
        {formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}
      </td>
      <td>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</td>
      {/* UPnL sits before Liq. so the two coloured columns — SIZE and UPNL — are the only
          things on the row carrying a signal, and the eye runs entry -> mark -> result. */}
      <td data-testid="unrealized-pnl" className={pnl !== null && pnl >= 0n ? 'pos' : 'neg'}>
        {pnl === null ? '—' : formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })}
      </td>
      {/* Read from the contract for THIS trade slot, so it includes the funding and
          rollover this position has actually accrued — see hooks/useLiquidationPrice.ts
          for why the order form uses a different function for its estimate.

          Deliberately NOT red. A liquidation price is a level, not a loss: colouring every
          row's Liq. cell red makes four healthy positions look like four margin calls, and
          it competes with UPnL, which is the cell whose colour actually means something. */}
      <td className={liqPrice !== null ? undefined : 'dash'} data-testid="liq-price">
        {liqPrice !== null ? formatMoney(liqPrice, PRICE_DECIMALS_NUM) : '—'}
      </td>
      <td>
        {/* terminal_design.pdf's positions row ends in a single `Close` button, so that is
            what the row shows: one click closes the whole position, which is what the
            overwhelming majority of closes are.

            Partial closing is NOT dropped — `closeTradeMarket` takes a percentage and the
            contract supports it, so hiding the capability entirely would remove real
            function to match a picture. It moves behind the chevron instead, where it
            costs nothing until someone wants it. */}
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
          <th>Market</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>UPnL</th>
          <th>Liq.</th>
          <th>Close</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <PositionRow
            key={`${p.pairIndex}-${p.index}`}
            position={p}
            market={markets.find((m) => m.pairIndex === p.pairIndex)}
          />
        ))}
      </tbody>
    </table>
  );
}
