import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '@/lib/closedTrade';
import { sparkPath, statsImagePath, statsSharePath, statsShareText, traderStatsCard } from '@/lib/statsCard';

const ADDRESS = '0x2f783207089fBdf0167868E6e4a85c086293E865';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0) / 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0) / 1000;
const MARKETS: Record<number, string> = { 0: 'BTC', 1: 'ETH', 2: 'SOL' };
const marketFrom = (pairIndex: number) => MARKETS[pairIndex] ?? null;

let key = 100;
function trade(pairIndex: number, pnl: bigint | null, closedAt: number, collateral = '100.000000', leverage = '10.00'): ClosedTrade {
  key += 1;
  return {
    pairIndex,
    index: 0,
    buy: true,
    collateral,
    leverage,
    openPrice: '80000.000000000000000000',
    closePrice: '81000.000000000000000000',
    openedAt: closedAt - 600,
    closedAt,
    tradeId: String(key),
    rowKey: String(key),
    isPartial: false,
    percentageClosed: null,
    closeReason: 'close',
    realisedPnlRaw: pnl,
    notionalRaw: 0n, // set below from collateral x leverage
  };
}

function withNotional(t: ClosedTrade): ClosedTrade {
  const c = BigInt(Math.round(Number(t.collateral) * 1e6));
  const l = BigInt(Math.round(Number(t.leverage) * 100));
  return { ...t, notionalRaw: (c * l) / 100n };
}

// Newest first, as the API sends them.
const TRADES = [
  trade(2, 0n, T0 + 240, '100.000000', '1.00'), // break-even, 100 notional
  trade(0, 15_000000n, T0 + 180, '50.000000', '10.00'), // +15, 500 notional
  trade(1, -10_000000n, T0 + 120, '200.000000', '10.00'), // -10, 2,000 notional
  trade(0, 25_000000n, T0 + 60), // +25, 1,000 notional — the best
].map(withNotional);

describe('traderStatsCard', () => {
  it('sums the realised PnL and counts every close, with the volume they traded', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(card.pnl).toBe('+30.00');
    expect(card.positive).toBe(true);
    expect(card.trades).toBe('4');
    expect(card.volume).toBe('3.6K');
  });

  it('rates wins over decided closes only — a break-even close decides nothing', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(card.winRate).toBe('67%');
    expect(card.record).toBe('2W · 1L');
  });

  it('names the best trade and the market it was on', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(card.best).toBe('+25.00');
    expect(card.bestMarket).toBe('BTC-PERP');
  });

  it('shortens the wallet and dates the card on the day it is made', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(card.wallet).toBe('0x2f78…e865');
    expect(card.date).toBe('03 Nov 2026');
  });

  it('runs the PnL curve oldest close first, from zero to the total', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(card.series).toEqual([0, 25, 15, 30, 30]);
  });

  it('thins a long history to at most 48 points, keeping its start and its end', () => {
    const many = Array.from({ length: 120 }, (_, i) => withNotional(trade(0, 1_000000n, T0 + i))).reverse();
    const card = traderStatsCard(ADDRESS, many, marketFrom, NOW)!;
    expect(card.series.length).toBeLessThanOrEqual(48);
    expect(card.series[0]).toBe(0);
    expect(card.series[card.series.length - 1]).toBe(120);
  });

  it('reads a losing record as a loss', () => {
    const card = traderStatsCard(ADDRESS, [withNotional(trade(0, -42_500000n, T0))], marketFrom, NOW)!;
    expect(card.pnl).toBe('-42.50');
    expect(card.positive).toBe(false);
    expect(card.winRate).toBe('0%');
  });

  it('has no win rate to show when every close broke even', () => {
    const card = traderStatsCard(ADDRESS, [withNotional(trade(0, 0n, T0))], marketFrom, NOW)!;
    expect(card.winRate).toBe('—');
  });

  it('is not made for a wallet with nothing closed', () => {
    expect(traderStatsCard(ADDRESS, [], marketFrom, NOW)).toBeNull();
  });

  it('is not made when a close is missing its PnL — a total over part of the closes is not the total', () => {
    expect(traderStatsCard(ADDRESS, [...TRADES, withNotional(trade(0, null, T0))], marketFrom, NOW)).toBeNull();
  });
});

describe('stats share links', () => {
  it('link to the wallet stats page and its card, lower-cased, with the Lunar theme when asked', () => {
    expect(statsSharePath(ADDRESS)).toBe('/share/0x2f783207089fbdf0167868e6e4a85c086293e865/stats');
    expect(statsImagePath(ADDRESS)).toBe('/share/0x2f783207089fbdf0167868e6e4a85c086293e865/stats/card.png');
    expect(statsImagePath(ADDRESS, 'lunar')).toBe('/share/0x2f783207089fbdf0167868e6e4a85c086293e865/stats/card.png?t=lunar');
  });

  it('says the PnL, the trades and the win rate in the post', () => {
    const card = traderStatsCard(ADDRESS, TRADES, marketFrom, NOW)!;
    expect(statsShareText(card)).toBe('+30.00 USDW realised over 4 trades with a 67% win rate on Whitespace testnet');
  });

  it('says one trade, and leaves out a win rate there is none of', () => {
    const card = traderStatsCard(ADDRESS, [withNotional(trade(0, 0n, T0))], marketFrom, NOW)!;
    expect(statsShareText(card)).toBe('+0.00 USDW realised over 1 trade on Whitespace testnet');
  });
});

describe('sparkPath', () => {
  it('spreads the points across the width and fits them to the height, highest at the top', () => {
    expect(sparkPath([0, 10, 5], 100, 50)).toBe('M0.0 50.0 L50.0 0.0 L100.0 25.0');
  });

  it('draws a flat series through the middle', () => {
    expect(sparkPath([3, 3], 100, 50)).toBe('M0.0 25.0 L100.0 25.0');
  });

  it('has no line to draw for fewer than two points', () => {
    expect(sparkPath([7], 100, 50)).toBeNull();
  });
});
