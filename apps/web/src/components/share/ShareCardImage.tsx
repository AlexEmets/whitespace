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

const PALETTE: Record<Theme, { bg: string; accent: string; glow: string; halo: string; rim: string }> = {
  solar: {
    bg: '#030305',
    accent: '#ffc37a',
    glow: 'rgba(255, 195, 122, 0.30)',
    halo: 'rgba(255, 150, 80, 0.10)',
    rim: 'rgba(255, 214, 160, 0.55)',
  },
  lunar: {
    bg: '#020309',
    accent: '#8ec5ff',
    glow: 'rgba(142, 197, 255, 0.30)',
    halo: 'rgba(80, 140, 255, 0.12)',
    rim: 'rgba(200, 228, 255, 0.55)',
  },
};

const FG = '#ededf2';
const MUTED = '#8e8fa3';
const LONG = '#5eead4';
const SHORT = '#ff7a6b';

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
          right: -140,
          top: 40,
          width: 640,
          height: 640,
          borderRadius: 9999,
          backgroundImage: `radial-gradient(circle, ${p.bg} 0%, ${p.bg} 44%, ${p.glow} 47%, ${p.halo} 58%, rgba(0,0,0,0) 72%)`,
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          // Same centre as the disc above (1020, 360); radius 208 sits on the glow's
          // inner edge — 47% of the gradient's farthest-corner radius, 320·√2.
          right: -28,
          top: 152,
          width: 416,
          height: 416,
          borderRadius: 9999,
          border: `2px solid ${p.rim}`,
          display: 'flex',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', padding: '56px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 26, height: 26, borderRadius: 9999, border: `2.5px solid ${p.accent}`, display: 'flex' }} />
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
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ fontSize: 20, color: MUTED }}>{`${card.date} · Whitechain testnet`}</div>
            <div style={{ fontSize: 22, color: p.accent }}>whitespace.finance</div>
          </div>
        </div>
      </div>
    </div>
  );
}
