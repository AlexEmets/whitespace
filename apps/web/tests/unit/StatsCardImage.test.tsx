// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_RING, FOOTER } from '@/components/share/ShareCardImage';
import { StatsCardImage } from '@/components/share/StatsCardImage';
import { BRAND_STAR_PATH } from '@/lib/brandMark';
import type { StatsCard } from '@/lib/statsCard';

const CARD: StatsCard = {
  wallet: '0x2f78…e865',
  pnl: '+1,234.56',
  positive: true,
  winRate: '64%',
  record: '18W · 10L',
  trades: '28',
  volume: '412.3K',
  best: '+512.30',
  bestMarket: 'BTC-PERP',
  series: [0, 120, 80, 400, 1234.56],
  date: '03 Nov 2026',
};

const html = (card: StatsCard = CARD, theme: 'solar' | 'lunar' = 'solar') => renderToStaticMarkup(<StatsCardImage card={card} theme={theme} />);

describe('<StatsCardImage>', () => {
  it('leads with the realised PnL, in the profit colour', () => {
    const out = html();
    expect(out).toContain('+1,234.56');
    expect(out).toContain('Realised PnL');
    expect(out).toContain('#5eead4');
  });

  it('turns the PnL to the loss colour for a losing record', () => {
    const out = html({ ...CARD, pnl: '-42.50', positive: false });
    expect(out).toContain('-42.50');
    expect(out).toContain('#ff7a6b');
  });

  it('lays out the win rate with its record, the trades, the volume and the best trade with its market', () => {
    const out = html();
    for (const text of ['64%', '18W · 10L', '28', '412.3K', '+512.30', 'BTC-PERP']) expect(out).toContain(text);
  });

  it('draws the PnL curve when there is one, and nothing when there is not', () => {
    expect(html()).toContain('data-testid="stats-spark"');
    expect(html({ ...CARD, series: [0] })).not.toContain('data-testid="stats-spark"');
  });

  it('signs the card with the brand mark, in the theme of the link', () => {
    expect(html()).toContain(`d="${BRAND_STAR_PATH}"`);
    expect(html(CARD, 'lunar')).toContain('fill="#eef7ff"');
  });

  it('puts the wallet, the date, the network and the site on one footer line under the ring', () => {
    const out = html();
    const footer = out.slice(out.indexOf('data-testid="card-footer"'));
    expect(footer).toContain('0x2f78…e865 · 03 Nov 2026 · Whitechain testnet ·');
    expect(footer).toContain('whitespace.finance');
    expect(CARD_HEIGHT - FOOTER.bottom - FOOTER.lineHeight).toBeGreaterThan(CARD_RING.cy + CARD_RING.r + 8);
  });
});
