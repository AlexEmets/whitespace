// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShareCardImage } from '@/components/share/ShareCardImage';
import { BRAND_STAR_PATH } from '@/lib/brandMark';
import type { ShareCard } from '@/lib/shareCard';

const CARD: ShareCard = {
  status: 'closed',
  market: 'BTC-PERP',
  side: 'long',
  leverage: '10×',
  entry: '82,708.80',
  exit: '82,732.41',
  exitLabel: 'Exit',
  pnl: '+0.28 USDW',
  roe: '+0.28%',
  positive: true,
  reason: 'Take profit',
  partial: null,
  date: '28 Sep 2026',
};

describe('<ShareCardImage>', () => {
  it('signs the card with the brand mark, not a bare ring', () => {
    const html = renderToStaticMarkup(<ShareCardImage card={CARD} theme="solar" />);
    expect(html).toContain(`d="${BRAND_STAR_PATH}"`);
  });

  it("draws the mark's flare in the theme's own light", () => {
    const solar = renderToStaticMarkup(<ShareCardImage card={CARD} theme="solar" />);
    const lunar = renderToStaticMarkup(<ShareCardImage card={CARD} theme="lunar" />);
    expect(solar).toContain('fill="#fff4e0"');
    expect(lunar).toContain('fill="#eef7ff"');
  });
});
