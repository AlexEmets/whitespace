'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useCloseTrade, FULL_CLOSE_PERCENT } from '@/hooks/useCloseTrade';
import { useMarkets } from '@/hooks/useMarkets';
import { usePositions } from '@/hooks/usePositions';
import { usePrice } from '@/hooks/usePrice';
import { COLLATERAL_DECIMALS, DEFAULT_SLIPPAGE_BPS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { useLiquidationPrice } from '@/hooks/useLiquidationPrice';
import { collateralToRaw, formatLeverage, formatMoney, leverageToRaw, priceToRaw } from '@/lib/money';
import { estimatePositionSizeBase, estimateUnrealisedPnl } from '@/lib/pnl';
import type { MarketSummary, PositionSummary } from '@/lib/types';

function PositionRow({ position, market }: { position: PositionSummary; market: MarketSummary | undefined }) {
  const { address } = useAccount();
  const { data: price } = usePrice(position.pairIndex);
  const { closeTrade, isPending } = useCloseTrade();
  const [closePercent, setClosePercent] = useState(100);
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
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <tr data-testid={`position-row-${position.pairIndex}-${position.index}`}>
      <td>
        {market ? `${market.from}-${market.to}` : `#${position.pairIndex}`}{' '}
        <span className={position.buy ? 'pos' : 'neg'}>{formatLeverage(position.leverage)}</span>
      </td>
      <td className={position.buy ? 'pos' : 'neg'}>{formatMoney(signedSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false, signDisplay: true })}</td>
      <td>
        {formatMoney(position.openPrice, PRICE_DECIMALS_NUM)}
      </td>
      <td>{price ? formatMoney(price.mark, PRICE_DECIMALS_NUM) : '—'}</td>
      {/* Read from the contract for THIS trade slot, so it includes the funding and
          rollover this position has actually accrued — see hooks/useLiquidationPrice.ts
          for why the order form uses a different function for its estimate. */}
      <td className={liqPrice !== null ? 'neg' : 'dash'} data-testid="liq-price">
        {liqPrice !== null ? formatMoney(liqPrice, PRICE_DECIMALS_NUM) : '—'}
      </td>
      <td data-testid="unrealized-pnl" className={pnl !== null && pnl >= 0n ? 'pos' : 'neg'}>
        {pnl === null ? '—' : formatMoney(pnl, COLLATERAL_DECIMALS, { signDisplay: true })}
      </td>
      <td>
        <input
          type="number"
          min={1}
          max={100}
          value={closePercent}
          data-testid="close-percent-input"
          onChange={(e) => setClosePercent(Number(e.target.value))}
          style={{ width: '3.5rem' }}
        />
        %
        <button
          type="button"
          data-testid="close-position-button"
          disabled={!price || isPending || status === 'submitting'}
          onClick={() => handleClose(closePercent)}
        >
          {status === 'submitting' ? 'Closing…' : 'Close'}
        </button>
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
          <th>Liq.</th>
          <th>UPnL</th>
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
