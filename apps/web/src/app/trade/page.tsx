'use client';

import { useEffect, useState } from 'react';
import { MarketsRail } from '@/components/terminal/MarketsRail';
import { MarketHeaderBar } from '@/components/terminal/MarketHeaderBar';
import { DepthPanel } from '@/components/terminal/DepthPanel';
import { TerminalTabs } from '@/components/terminal/TerminalTabs';
import { OpenPositionForm } from '@/components/OpenPositionForm';
import { PriceChart } from '@/components/PriceChart';
import { useMarkets } from '@/hooks/useMarkets';
import { leverageToRaw } from '@/lib/money';

/** The trading terminal — layout follows terminal_design.pdf: markets rail, centre
 * chart + tabbed positions/orders/fills/funding table, an honest depth panel (see
 * DepthPanel.tsx for why it isn't a fake order book), and the order-entry panel. */
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
      <MarketsRail pairIndex={pairIndex} onSelect={setPairIndex} />

      <div className="terminal-center">
        <MarketHeaderBar market={market} />
        <PriceChart pairIndex={pairIndex} />
        <TerminalTabs />
      </div>

      {/* The ladder quotes fill prices for the market the trader is actually looking at,
          so it follows the rail's selection rather than defaulting to the first market. */}
      <DepthPanel pairIndex={pairIndex ?? undefined} />

      <div className="terminal-right">
        <OpenPositionForm pairIndex={pairIndex} maxLeverage={maxLeverage} market={market} />
      </div>
    </div>
  );
}
