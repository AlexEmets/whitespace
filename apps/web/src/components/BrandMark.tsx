import { useId } from 'react';
import { BRAND_DISC, BRAND_FLARE, BRAND_GLOW, BRAND_STAR_PATH, BRAND_VIEWBOX } from '@/lib/brandMark';

/**
 * The brand mark as an inline SVG, sized by its `className`.
 *
 * Every colour is a theme token, so the mark follows Solar and Lunar without a prop and
 * without a flash when the theme script flips `<html data-theme>` before paint.
 *
 * The gradient ids come from `useId`: SVG ids are document-global, and two marks sharing
 * an id would both resolve `url(#…)` to whichever gradient came first. React's ids contain
 * colons, which are stripped so the reference stays a plain fragment.
 */
export function BrandMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const glow = `${id}-brand-glow`;
  const flare = `${id}-brand-flare`;

  return (
    <svg className={className} viewBox={`0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}`} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={glow}>
          <stop offset="0.55" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0 }} />
          <stop offset="0.66" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={flare}>
          <stop offset="0" style={{ stopColor: 'var(--corona-flare)' }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--accent-rgb))', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle cx={BRAND_GLOW.cx} cy={BRAND_GLOW.cy} r={BRAND_GLOW.r} fill={`url(#${glow})`} />
      <circle
        cx={BRAND_DISC.cx}
        cy={BRAND_DISC.cy}
        r={BRAND_DISC.r}
        strokeWidth={1.6}
        style={{ fill: 'var(--bg)', stroke: 'var(--corona-rim)' }}
      />
      <circle cx={BRAND_FLARE.cx} cy={BRAND_FLARE.cy} r={BRAND_FLARE.r} fill={`url(#${flare})`} />
      <path d={BRAND_STAR_PATH} style={{ fill: 'var(--corona-flare)' }} />
    </svg>
  );
}
