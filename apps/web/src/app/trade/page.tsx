'use client';

import { useEffect, useState } from 'react';
import { MarketsRail } from '@/components/terminal/MarketsRail';
import { MarketHeaderBar } from '@/components/terminal/MarketHeaderBar';
import { TerminalTabs } from '@/components/terminal/TerminalTabs';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import { AccountSummary } from '@/components/terminal/AccountSummary';
import { PriceChart } from '@/components/PriceChart';
import { TickerStrip } from '@/components/TickerStrip';
import { useMarkets } from '@/hooks/useMarkets';
import { leverageToRaw } from '@/lib/money';

/** The trading terminal: markets rail, centre chart + tabbed account tables, and the
 * order-entry panel. There is no order book — like Variational's RFQ terminal, the order
 * panel shows the vault's two-sided quote for the size being entered (see lib/quote.ts and
 * the testnet-perfect spec §3), because a vault has no resting depth to draw. */
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
    <>
      {/* terminal_design.pdf runs a ticker row between the nav and the terminal. It was
          built for the landing page and simply never mounted here. Every entry is a real
          listed market — the reference's eight are not invented into existence, the strip
          just shows however many there are. */}
      <TickerStrip />
      <div className="terminal-grid">
        <MarketsRail pairIndex={pairIndex} onSelect={setPairIndex} />

        <div className="terminal-center">
          <MarketHeaderBar market={market} />
          <PriceChart pairIndex={pairIndex} />
          <TerminalTabs />
        </div>

        <div className="terminal-right">
          <OpenPositionForm pairIndex={pairIndex} maxLeverage={maxLeverage} market={market} />
          <AccountSummary />
        </div>
      </div>
    </>
  );
}
