'use client';

import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useErc20 } from '@/hooks/useErc20';
import { useMarkPrices } from '@/hooks/useMarkPrices';
import { usePositions } from '@/hooks/usePositions';
import { COLLATERAL_DECIMALS } from '@/lib/config';
import { TRADING_STORAGE_ADDRESS } from '@/lib/deployment';
import { collateralToRaw, formatMoney } from '@/lib/money';
import { estimateUnrealisedPnl } from '@/lib/pnl';

/**
 * The account card at the foot of the terminal rail: what the wallet holds,
 * what is locked as isolated margin, the open positions' unrealised PnL at the current marks,
 * and their sum. Every figure is USDW; a market with no mark yet is left out of UPnL rather
 * than valued at its entry.
 */
export function AccountSummary() {
  const { address } = useAccount();
  const erc20 = useErc20(TRADING_STORAGE_ADDRESS);
  const { positions } = usePositions(address);
  const pairIndexes = useMemo(() => positions.map((p) => p.pairIndex), [positions]);
  const { prices } = useMarkPrices(pairIndexes);

  if (!address) return null;

  const margin = positions.reduce((acc, p) => acc + collateralToRaw(p.collateral), 0n);
  let upnl = 0n;
  let complete = true;
  for (const p of positions) {
    const mark = prices[p.pairIndex]?.mark;
    if (!mark) {
      complete = false;
      continue;
    }
    upnl += estimateUnrealisedPnl({ collateral: p.collateral, leverage: p.leverage, openPrice: p.openPrice, markPrice: mark, buy: p.buy });
  }
  const portfolio = erc20.balance + margin + upnl;

  return (
    <div className="rail-card" data-testid="account-summary">
      <div className="rail-card-title">
        <span>Account</span>
      </div>
      <div className="rail-card-row">
        <span>Portfolio</span>
        <span data-testid="account-portfolio">{formatMoney(portfolio, COLLATERAL_DECIMALS)} USDW{complete ? '' : '*'}</span>
      </div>
      <div className="rail-card-row">
        <span>Wallet</span>
        <span data-testid="account-wallet">{formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</span>
      </div>
      <div className="rail-card-row">
        <span>In margin</span>
        <span data-testid="account-margin">{formatMoney(margin, COLLATERAL_DECIMALS)} USDW</span>
      </div>
      <div className="rail-card-row">
        <span>uPnL</span>
        <span data-testid="account-upnl" className={upnl >= 0n ? 'pos' : 'neg'}>
          {formatMoney(upnl, COLLATERAL_DECIMALS, { signDisplay: true })} USDW{complete ? '' : '*'}
        </span>
      </div>
      {complete ? null : <p className="dash" style={{ margin: 0, fontSize: '0.78rem' }}>* a market has no mark yet and is left out.</p>}
    </div>
  );
}
