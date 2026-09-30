'use client';

import { useEffect, useState } from 'react';
import { MarketsRail } from '@/components/terminal/MarketsRail';
import { MarketHeaderBar } from '@/components/terminal/MarketHeaderBar';
import { TerminalTabs } from '@/components/terminal/TerminalTabs';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import { OneClickTrading } from '@/components/OneClickTrading';
import { AccountSummary } from '@/components/terminal/AccountSummary';
import { PriceChart } from '@/components/PriceChart';
import { useMarkets } from '@/hooks/useMarkets';
import { leverageToRaw } from '@/lib/money';

/** The trading terminal: markets rail (with the account card at its foot),
 * centre header + chart + tabbed account tables, and the order ticket. There is no order
 * book — like Variational's RFQ terminal, the ticket carries the vault's two-sided quote
 * for the size being entered (see lib/quote.ts), because a vault has no resting depth to
 * draw. */
export default function TradePage() {
  const { markets } = useMarkets();
  const [pairIndex, setPairIndex] = useState<number | null>(null);

  useEffect(() => {
    if (pairIndex === null && markets.length > 0) {
      setPairIndex(markets[0]?.pairIndex ?? null);
    }
  }, [markets, pairIndex]);

  const market = markets.find((m) => m.pairIndex === pairIndex);
  const maxLeverage = market ? leverageToRaw(market.maxLeverage) : 0n;

  return (
    <div className="terminal-grid">
      <MarketsRail pairIndex={pairIndex} onSelect={setPairIndex}>
        <AccountSummary />
      </MarketsRail>

      <div className="terminal-center">
        <MarketHeaderBar market={market} />
        <div className="chart-panel panel">
          <PriceChart pairIndex={pairIndex} />
        </div>
        <TerminalTabs />
      </div>

      <div className="terminal-right panel">
        <OneClickTrading />
        <OpenPositionForm pairIndex={pairIndex} maxLeverage={maxLeverage} market={market} />
      </div>
    </div>
  );
}
