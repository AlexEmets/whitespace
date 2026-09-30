import { BRAND_DISC, BRAND_FLARE, BRAND_GLOW, BRAND_STAR_PATH, BRAND_VIEWBOX } from '@/lib/brandMark';
import type { ShareCard } from '@/lib/shareCard';
import type { Theme } from '@/lib/theme';

/**
 * The PnL card as an image, rendered by `next/og` (Satori) at 1200×630 — the size X and
 * Telegram show as a large link preview.
 *
 * Satori is not a browser: every element with more than one child needs an explicit
 * `display: flex`, styles are inline only, and there is no `filter`. The eclipse is
 * therefore drawn with radial gradients rather than the site's blurred box-shadows.
 * Colours are the site's own tokens, spelled out, because CSS variables do not exist here.
 */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** The ring's circle in card pixels: the 2px rim drawn over the glow's inner edge. The
 * glow disc shares its centre. */
export const CARD_RING = { cx: 1020, cy: 360, r: 208 } as const;
const GLOW_RADIUS = 320;

/** The one-line footer — date, network, site — pinned under the ring: its distance from the
 * card's bottom edge and its line box. Two lines at the old height ran across the ring. */
export const FOOTER = { bottom: 26, lineHeight: 24 } as const;

const PALETTE: Record<Theme, { bg: string; accent: string; glow: string; halo: string; rim: string; markRim: string; flare: string }> = {
  solar: {
    bg: '#030305',
    accent: '#ffc37a',
    glow: 'rgba(255, 195, 122, 0.30)',
    halo: 'rgba(255, 150, 80, 0.10)',
    rim: 'rgba(255, 214, 160, 0.55)',
    markRim: 'rgba(255, 214, 160, 0.95)',
    flare: '#fff4e0',
  },
  lunar: {
    bg: '#020309',
    accent: '#8ec5ff',
    glow: 'rgba(142, 197, 255, 0.30)',
    halo: 'rgba(80, 140, 255, 0.12)',
    rim: 'rgba(200, 228, 255, 0.55)',
    markRim: 'rgba(200, 228, 255, 0.95)',
    flare: '#eef7ff',
  },
};

const FG = '#ededf2';
const MUTED = '#8e8fa3';
const LONG = '#5eead4';
const SHORT = '#ff7a6b';

/**
 * The brand mark (lib/brandMark.ts) for Satori, which rasterises an inline SVG through
 * resvg: plain presentation attributes rather than style objects, and fixed gradient ids,
 * since the card draws the mark once.
 */
function CardBrandMark({ p }: { p: (typeof PALETTE)[Theme] }) {
  return (
    <svg width={44} height={44} viewBox={`0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}`}>
      <defs>
        <radialGradient id="card-brand-glow">
          <stop offset="0.55" stopColor={p.accent} stopOpacity={0} />
          <stop offset="0.66" stopColor={p.accent} stopOpacity={0.55} />
          <stop offset="1" stopColor={p.accent} stopOpacity={0} />
        </radialGradient>
        <radialGradient id="card-brand-flare">
          <stop offset="0" stopColor={p.flare} />
          <stop offset="1" stopColor={p.accent} stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={BRAND_GLOW.cx} cy={BRAND_GLOW.cy} r={BRAND_GLOW.r} fill="url(#card-brand-glow)" />
      <circle cx={BRAND_DISC.cx} cy={BRAND_DISC.cy} r={BRAND_DISC.r} fill={p.bg} stroke={p.markRim} strokeWidth={1.8} />
      <circle cx={BRAND_FLARE.cx} cy={BRAND_FLARE.cy} r={BRAND_FLARE.r} fill="url(#card-brand-flare)" />
      <path d={BRAND_STAR_PATH} fill={p.flare} />
    </svg>
  );
}

export function ShareCardImage({ card, theme }: { card: ShareCard; theme: Theme }) {
  const p = PALETTE[theme];
  const sideColour = card.side === 'long' ? LONG : SHORT;
  const pnlColour = card.positive ? LONG : SHORT;
  const status = [card.status === 'open' ? 'Open position' : 'Closed', card.reason, card.partial].filter(Boolean).join(' · ');

  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: 'flex',
        position: 'relative',
        backgroundColor: p.bg,
        color: FG,
        fontFamily: 'Geologica',
        overflow: 'hidden',
      }}
    >
      {/* The eclipse, low on the right: a halo, a glow ring, and a disc of page black. */}
      <div
        style={{
          position: 'absolute',
          right: CARD_WIDTH - (CARD_RING.cx + GLOW_RADIUS),
          top: CARD_RING.cy - GLOW_RADIUS,
          width: GLOW_RADIUS * 2,
          height: GLOW_RADIUS * 2,
          borderRadius: 9999,
          backgroundImage: `radial-gradient(circle, ${p.bg} 0%, ${p.bg} 44%, ${p.glow} 47%, ${p.halo} 58%, rgba(0,0,0,0) 72%)`,
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          // Same centre as the disc above; radius 208 sits on the glow's inner edge — 47% of
          // the gradient's farthest-corner radius, 320·√2.
          right: CARD_WIDTH - (CARD_RING.cx + CARD_RING.r),
          top: CARD_RING.cy - CARD_RING.r,
          width: CARD_RING.r * 2,
          height: CARD_RING.r * 2,
          borderRadius: 9999,
          border: `2px solid ${p.rim}`,
          display: 'flex',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', padding: '56px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CardBrandMark p={p} />
            <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: 0.5 }}>whitespace</div>
          </div>
          <div
            style={{
              display: 'flex',
              padding: '8px 18px',
              borderRadius: 9999,
              border: `1.5px solid ${p.accent}`,
              color: p.accent,
              fontSize: 22,
              fontWeight: 500,
            }}
          >
            {status}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{ fontSize: 44, fontWeight: 500 }}>{card.market}</div>
            <div
              style={{
                display: 'flex',
                padding: '6px 16px',
                borderRadius: 12,
                border: `1.5px solid ${sideColour}`,
                color: sideColour,
                fontSize: 26,
                fontWeight: 500,
              }}
            >
              {`${card.side === 'long' ? 'Long' : 'Short'} ${card.leverage}`}
            </div>
          </div>
          <div style={{ display: 'flex', fontSize: 150, fontWeight: 300, letterSpacing: -4, lineHeight: 1, color: pnlColour }}>{card.roe}</div>
          <div style={{ display: 'flex', fontFamily: 'Azeret Mono', fontSize: 30, color: pnlColour }}>{card.pnl}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 56 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 20, color: MUTED }}>Entry</div>
              <div style={{ fontFamily: 'Azeret Mono', fontSize: 28 }}>{card.entry}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 20, color: MUTED }}>{card.exitLabel}</div>
              <div style={{ fontFamily: 'Azeret Mono', fontSize: 28 }}>{card.exit}</div>
            </div>
          </div>
        </div>
      </div>

      <div
        data-testid="card-footer"
        style={{
          position: 'absolute',
          right: 64,
          bottom: FOOTER.bottom,
          height: FOOTER.lineHeight,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 19,
        }}
      >
        <div style={{ display: 'flex', color: MUTED }}>{`${card.date} · Whitechain testnet ·`}</div>
        <div style={{ display: 'flex', color: p.accent }}>whitespace.finance</div>
      </div>
    </div>
  );
}
