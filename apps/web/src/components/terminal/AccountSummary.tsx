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
import styles from '../OrderPanel.module.css';

/**
 * The account block under the order panel, as Variational places it: what the wallet holds,
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
    <dl className={styles.summary} data-testid="account-summary">
      <div>
        <dt>Portfolio value</dt>
        <dd data-testid="account-portfolio">{formatMoney(portfolio, COLLATERAL_DECIMALS)} USDW{complete ? '' : '*'}</dd>
      </div>
      <div>
        <dt>Wallet</dt>
        <dd data-testid="account-wallet">{formatMoney(erc20.balance, COLLATERAL_DECIMALS)} USDW</dd>
      </div>
      <div>
        <dt>Isolated margin</dt>
        <dd data-testid="account-margin">{formatMoney(margin, COLLATERAL_DECIMALS)} USDW</dd>
      </div>
      <div>
        <dt>Unrealised PnL</dt>
        <dd data-testid="account-upnl" className={upnl >= 0n ? styles.long : styles.short}>
          {formatMoney(upnl, COLLATERAL_DECIMALS, { signDisplay: true })} USDW{complete ? '' : '*'}
        </dd>
      </div>
      {complete ? null : <p className="dash">* a market has no mark yet and is left out.</p>}
    </dl>
  );
}
