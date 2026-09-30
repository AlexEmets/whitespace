// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_RING, FOOTER, ShareCardImage } from '@/components/share/ShareCardImage';
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

  /**
   * The date and the site sat in two lines at the bottom right, across the ring's lower arc.
   * They are one line now, pinned under the ring: its top edge stays below the ring's
   * lowest point with room to spare.
   */
  it('keeps the footer below the ring rather than across it', () => {
    const footerTop = CARD_HEIGHT - FOOTER.bottom - FOOTER.lineHeight;
    expect(footerTop).toBeGreaterThan(CARD_RING.cy + CARD_RING.r + 8);
  });

  it('sets the date, the network and the site as one line', () => {
    const html = renderToStaticMarkup(<ShareCardImage card={CARD} theme="solar" />);
    const footer = html.slice(html.indexOf('data-testid="card-footer"'));
    const line = footer.slice(0, footer.indexOf('</div></div>'));
    expect(line).toContain('28 Sep 2026');
    expect(line).toContain('Whitechain testnet');
    expect(line).toContain('whitespace.finance');
  });
});
