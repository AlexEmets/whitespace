import { sparkPath, type StatsCard } from '@/lib/statsCard';
import type { Theme } from '@/lib/theme';
import {
  CARD_HEIGHT,
  CARD_RING,
  CARD_WIDTH,
  CardBrandMark,
  FG,
  FOOTER,
  GLOW_RADIUS,
  LONG,
  MUTED,
  PALETTE,
  SHORT,
} from './ShareCardImage';

/**
 * A wallet's stats card as an image, rendered by `next/og` (Satori) at 1200×630 — the same
 * frame, eclipse and footer as the trade card, so a feed of Whitespace posts reads as one
 * set. Satori rules apply: inline styles, an explicit `display: flex` on every element with
 * more than one child, no CSS variables, no `filter`.
 */

/** The PnL curve's box under the headline figure, clear of the ring on the right. */
const SPARK = { width: 640, height: 84 } as const;

function Figure({ label, value, sub, colour }: { label: string; value: string; sub?: string; colour?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', fontSize: 20, color: MUTED }}>{label}</div>
      <div style={{ display: 'flex', fontFamily: 'Azeret Mono', fontSize: 30, color: colour ?? FG }}>{value}</div>
      {sub ? <div style={{ display: 'flex', fontSize: 18, color: MUTED }}>{sub}</div> : null}
    </div>
  );
}

export function StatsCardImage({ card, theme }: { card: StatsCard; theme: Theme }) {
  const p = PALETTE[theme];
  const pnlColour = card.positive ? LONG : SHORT;
  const spark = sparkPath(card.series, SPARK.width, SPARK.height);

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
      {/* The eclipse, as on the trade card: a halo, a glow ring, and a disc of page black. */}
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
          right: CARD_WIDTH - (CARD_RING.cx + CARD_RING.r),
          top: CARD_RING.cy - CARD_RING.r,
          width: CARD_RING.r * 2,
          height: CARD_RING.r * 2,
          borderRadius: 9999,
          border: `2px solid ${p.rim}`,
          display: 'flex',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', padding: '56px 64px 64px' }}>
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
            Trader stats
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', fontSize: 22, color: MUTED }}>Realised PnL</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <div style={{ display: 'flex', fontSize: 108, fontWeight: 300, letterSpacing: -3, lineHeight: 1, color: pnlColour }}>{card.pnl}</div>
            <div style={{ display: 'flex', fontFamily: 'Azeret Mono', fontSize: 30, color: pnlColour }}>USDW</div>
          </div>
          {spark ? (
            <svg data-testid="stats-spark" width={SPARK.width} height={SPARK.height} viewBox={`-2 -4 ${SPARK.width + 4} ${SPARK.height + 8}`}>
              <path d={spark} fill="none" stroke={pnlColour} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 52 }}>
          <Figure label="Win rate" value={card.winRate} sub={card.record} />
          <Figure label="Trades" value={card.trades} />
          <Figure label="Volume" value={card.volume} sub="USDW" />
          <Figure label="Best trade" value={card.best} sub={card.bestMarket} colour={LONG} />
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
        <div style={{ display: 'flex', color: MUTED }}>{`${card.wallet} · ${card.date} · Whitechain testnet ·`}</div>
        <div style={{ display: 'flex', color: p.accent }}>whitespace.finance</div>
      </div>
    </div>
  );
}
