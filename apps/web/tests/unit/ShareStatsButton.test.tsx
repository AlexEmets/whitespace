import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShareStatsButton } from '@/components/share/ShareStatsButton';
import type { StatsCard } from '@/lib/statsCard';

const ADDRESS = '0x00000000000000000000000000000000000000AA';
const CARD: StatsCard = {
  wallet: '0x0000…00aa',
  pnl: '+1,234.56',
  positive: true,
  winRate: '64%',
  record: '18W · 10L',
  trades: '28',
  volume: '412.3K',
  best: '+512.30',
  bestMarket: 'BTC-PERP',
  series: [0, 1234.56],
  date: '03 Nov 2026',
};

function open() {
  render(<ShareStatsButton address={ADDRESS} card={CARD} />);
  fireEvent.click(screen.getByTestId('share-stats'));
}

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'solar');
});

describe('<ShareStatsButton>', () => {
  it('opens the share sheet titled for stats, large enough to read the card', () => {
    open();
    const dialog = screen.getByTestId('share-dialog');
    expect(dialog).toHaveAttribute('data-size', 'large');
    expect(dialog).toHaveTextContent('Share your stats');
  });

  it('previews the stats card the link will show', () => {
    open();
    expect(screen.getByTestId('share-preview')).toHaveAttribute('src', '/share/0x00000000000000000000000000000000000000aa/stats/card.png');
  });

  it('uses the Lunar card when the page is in the Lunar theme', () => {
    document.documentElement.setAttribute('data-theme', 'lunar');
    open();
    expect(screen.getByTestId('share-preview')).toHaveAttribute('src', '/share/0x00000000000000000000000000000000000000aa/stats/card.png?t=lunar');
  });

  it('posts to X with the stats line and the absolute stats link', () => {
    open();
    const url = new URL(screen.getByTestId('share-x').getAttribute('href')!);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe('+1,234.56 USDW realised over 28 trades with a 64% win rate on Whitespace testnet');
    expect(url.searchParams.get('url')).toBe(`${window.location.origin}/share/0x00000000000000000000000000000000000000aa/stats`);
  });
});
