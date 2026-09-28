import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TradeHistoryTable } from '@/components/portfolio/TradeHistoryTable';
import type { ClosedTrade } from '@/lib/closedTrade';
import type { MarketSummary } from '@/lib/types';

const MARKETS = [{ pairIndex: 0, from: 'BTC', to: 'USD' }] as MarketSummary[];

const TRADE: ClosedTrade = {
  pairIndex: 0,
  index: 0,
  buy: true,
  collateral: '100.000000',
  leverage: '10.00',
  openPrice: '80000.000000000000000000',
  closePrice: '81000.000000000000000000',
  openedAt: 1_790_000_000,
  closedAt: 1_790_003_600,
  tradeId: '7',
  rowKey: '41',
  isPartial: false,
  percentageClosed: '100.00',
  closeReason: 'tp',
  realisedPnlRaw: 12_500_000n,
  notionalRaw: 1_000_000_000n,
};

describe('<TradeHistoryTable>', () => {
  it("offers a share button on each close for the connected trader's own history", () => {
    render(<TradeHistoryTable trades={[TRADE]} markets={MARKETS} address="0x00000000000000000000000000000000000000aa" />);
    expect(screen.getByTestId('history-share-41')).toHaveAttribute('aria-label', 'Share this BTC-PERP trade');
  });

  it('offers none without an address to build the link from', () => {
    render(<TradeHistoryTable trades={[TRADE]} markets={MARKETS} />);
    expect(screen.queryByTestId('history-share-41')).not.toBeInTheDocument();
  });
});
