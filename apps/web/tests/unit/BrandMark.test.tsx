import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '@/components/BrandMark';
import { BRAND_DISC, BRAND_FLARE } from '@/lib/brandMark';

describe('brand mark geometry', () => {
  it('puts the flare on the rim of the disc, where the corona breaks through', () => {
    const distance = Math.hypot(BRAND_FLARE.cx - BRAND_DISC.cx, BRAND_FLARE.cy - BRAND_DISC.cy);
    expect(distance).toBeCloseTo(BRAND_DISC.r, 1);
  });

  it('puts the flare up and to the right of the centre', () => {
    expect(BRAND_FLARE.cx).toBeGreaterThan(BRAND_DISC.cx);
    expect(BRAND_FLARE.cy).toBeLessThan(BRAND_DISC.cy);
  });
});

describe('<BrandMark>', () => {
  it('is decorative, so the link around it is named by its text alone', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
  });

  it('gives every mark on a page its own gradient ids', () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark />
      </>,
    );
    const ids = [...container.querySelectorAll('radialGradient')].map((g) => g.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('points each fill at a gradient inside its own svg', () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark />
      </>,
    );
    for (const svg of container.querySelectorAll('svg')) {
      const refs = [...svg.querySelectorAll('[fill]')]
        .map((el) => el.getAttribute('fill')!)
        .filter((fill) => fill.startsWith('url(#'))
        .map((fill) => fill.slice(5, -1));
      expect(refs).toHaveLength(2);
      for (const ref of refs) expect(svg.querySelector(`[id="${ref}"]`)).not.toBeNull();
    }
  });

  it('takes its colours from the theme tokens, so Solar and Lunar need no prop', () => {
    const { container } = render(<BrandMark />);
    const html = container.innerHTML;
    expect(html).toContain('var(--corona-flare)');
    expect(html).toContain('var(--corona-rim)');
    expect(html).toContain('rgb(var(--accent-rgb))');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
