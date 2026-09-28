import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '@/lib/closedTrade';
import {
  closedShareRef,
  closedTradeShareCard,
  compactLeverage,
  openPositionShareCard,
  parseShareId,
  roeBps,
  shareId,
  shareImagePath,
  sharePath,
  shareText,
  xIntentUrl,
} from '@/lib/shareCard';
import type { PositionSummary } from '@/lib/types';

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0) / 1000; // 28 Sep 2026 12:00 UTC

function closed(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    pairIndex: 0,
    index: 0,
    buy: true,
    collateral: '100.000000',
    leverage: '10.00',
    openPrice: '80000.000000000000000000',
    closePrice: '81000.000000000000000000',
    openedAt: T0 - 3600,
    closedAt: T0,
    tradeId: '7',
    rowKey: '41',
    isPartial: false,
    percentageClosed: '100.00',
    closeReason: 'close',
    realisedPnlRaw: 12_500_000n, // +12.50 USDW
    notionalRaw: 1_000_000_000n,
    ...overrides,
  };
}

describe('roeBps', () => {
  it('is PnL over the margin put up, in hundredths of a percent', () => {
    expect(roeBps(12_500_000n, 100_000_000n)).toBe(1250n); // +12.50%
    expect(roeBps(-3_000_000n, 100_000_000n)).toBe(-300n); // -3.00%
  });

  it('truncates toward zero rather than rounding a loss into a smaller one', () => {
    expect(roeBps(-1n, 3n)).toBe(-3333n);
    expect(roeBps(1n, 3n)).toBe(3333n);
  });

  it('is zero for zero margin instead of dividing by it', () => {
    expect(roeBps(5_000_000n, 0n)).toBe(0n);
  });
});

describe('compactLeverage', () => {
  it('drops trailing zeros from the PRECISION_2 figure', () => {
    expect(compactLeverage('10.00')).toBe('10×');
    expect(compactLeverage('12.50')).toBe('12.5×');
    expect(compactLeverage('2.25')).toBe('2.25×');
  });
});

describe('closedTradeShareCard', () => {
  it('describes a winning long', () => {
    const card = closedTradeShareCard(closed(), 'BTC');
    expect(card).toEqual({
      status: 'closed',
      market: 'BTC-PERP',
      side: 'long',
      leverage: '10×',
      entry: '80,000.00',
      exit: '81,000.00',
      exitLabel: 'Exit',
      pnl: '+12.50 USDW',
      roe: '+12.50%',
      positive: true,
      reason: null,
      partial: null,
      date: '28 Sep 2026',
    });
  });

  it('describes a losing short', () => {
    const card = closedTradeShareCard(closed({ buy: false, realisedPnlRaw: -3_000_000n }), 'ETH');
    expect(card?.side).toBe('short');
    expect(card?.market).toBe('ETH-PERP');
    expect(card?.pnl).toBe('-3.00 USDW');
    expect(card?.roe).toBe('-3.00%');
    expect(card?.positive).toBe(false);
  });

  it('names an automated close, but not an ordinary one', () => {
    expect(closedTradeShareCard(closed({ closeReason: 'tp' }), 'BTC')?.reason).toBe('Take profit');
    expect(closedTradeShareCard(closed({ closeReason: 'liq' }), 'BTC')?.reason).toBe('Liquidated');
    expect(closedTradeShareCard(closed({ closeReason: 'close' }), 'BTC')?.reason).toBeNull();
  });

  it('marks a partial close with the share that was closed', () => {
    const card = closedTradeShareCard(closed({ isPartial: true, percentageClosed: '50.00' }), 'BTC');
    expect(card?.partial).toBe('50% closed');
  });

  it('refuses to make a card from a row missing its PnL or close price', () => {
    expect(closedTradeShareCard(closed({ realisedPnlRaw: null }), 'BTC')).toBeNull();
    expect(closedTradeShareCard(closed({ closePrice: null }), 'BTC')).toBeNull();
  });
});

describe('openPositionShareCard', () => {
  const position: PositionSummary = {
    pairIndex: 1,
    index: 0,
    buy: true,
    collateral: '200.000000',
    leverage: '5.00',
    openPrice: '2000.000000000000000000',
    tp: '0.000000000000000000',
    sl: '0.000000000000000000',
    openedAt: T0 - 60,
    tradeId: '9',
  };

  it('marks an open position to the given price', () => {
    // 5x on 200 USDW = 1000 notional; +10% on price = +100 USDW = +50% on margin.
    const card = openPositionShareCard(position, 'ETH', '2200.000000000000000000', T0);
    expect(card.status).toBe('open');
    expect(card.exitLabel).toBe('Mark');
    expect(card.exit).toBe('2,200.00');
    expect(card.pnl).toBe('+100.00 USDW');
    expect(card.roe).toBe('+50.00%');
    expect(card.date).toBe('28 Sep 2026');
  });
});

describe('share ids', () => {
  it('round-trips closed and open references', () => {
    expect(shareId({ kind: 'closed', closeOrderId: '41' })).toBe('c41');
    expect(shareId({ kind: 'open', tradeId: '9' })).toBe('o9');
    expect(parseShareId('c41')).toEqual({ kind: 'closed', closeOrderId: '41' });
    expect(parseShareId('o9')).toEqual({ kind: 'open', tradeId: '9' });
  });

  it('rejects anything that is not a kind letter and digits', () => {
    for (const bad of ['', 'c', 'x41', 'c4a', 'c-1', 'c41/../x', 'o' + '9'.repeat(40)]) {
      expect(parseShareId(bad)).toBeNull();
    }
  });

  it('only offers a closed trade for sharing when it has a real close-order id', () => {
    expect(closedShareRef(closed({ rowKey: '41' }))).toEqual({ kind: 'closed', closeOrderId: '41' });
    expect(closedShareRef(closed({ rowKey: '7-0-0' }))).toBeNull();
  });
});

describe('sharePath', () => {
  const address = '0xAbCdEf0000000000000000000000000000000001';

  it('builds a lower-cased, theme-free path by default', () => {
    expect(sharePath(address, { kind: 'closed', closeOrderId: '41' })).toBe(
      '/share/0xabcdef0000000000000000000000000000000001/c41',
    );
  });

  it('carries the Lunar theme so the card matches what the sharer saw', () => {
    expect(sharePath(address, { kind: 'open', tradeId: '9' }, 'lunar')).toBe(
      '/share/0xabcdef0000000000000000000000000000000001/o9?t=lunar',
    );
  });
});

describe('shareImagePath', () => {
  const address = '0xAbCdEf0000000000000000000000000000000001';

  it('points at the card PNG under the share page, carrying the theme', () => {
    const ref = { kind: 'closed' as const, closeOrderId: '41' };
    expect(shareImagePath(address, ref)).toBe('/share/0xabcdef0000000000000000000000000000000001/c41/card.png');
    expect(shareImagePath(address, ref, 'lunar')).toBe(
      '/share/0xabcdef0000000000000000000000000000000001/c41/card.png?t=lunar',
    );
  });
});

describe('shareText and xIntentUrl', () => {
  it('writes a short post for a closed and an open trade', () => {
    const card = closedTradeShareCard(closed(), 'BTC')!;
    expect(shareText(card)).toBe('Closed a 10× long on BTC-PERP at +12.50% on Whitespace testnet');
    const open = { ...card, status: 'open' as const };
    expect(shareText(open)).toBe('Riding a 10× long on BTC-PERP, +12.50% so far, on Whitespace testnet');
  });

  it('encodes the text and link into an X compose URL', () => {
    const url = new URL(xIntentUrl('+12.50% & more', 'https://www.whitespace.finance/share/0xab/c41'));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe('+12.50% & more');
    expect(url.searchParams.get('url')).toBe('https://www.whitespace.finance/share/0xab/c41');
  });
});
