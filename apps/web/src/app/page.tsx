'use client';

import Link from 'next/link';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketFees } from '@/hooks/useMarketFees';
import { MarketsTable } from '@/components/MarketsTable';
import { TickerStrip } from '@/components/TickerStrip';
import { formatMoney } from '@/lib/money';

/**
 * Landing page. Structure and copy follow landing_design.pdf, with the design-honesty
 * corrections from the phase-5 review:
 *  - "Deep books" -> replaced (this is a vault-backed, oracle-priced perp with no order
 *    book — see design spec §3.2). Kept the rest of the voice.
 *  - MAX LEVERAGE stat tile shows the mockup's 50x as marketing copy (explicitly
 *    sanctioned — it is the product owner's number), while the actual trading terminal
 *    always shows the real per-market max leverage from `/markets` (currently 100x for
 *    BTC/USD — the two intentionally differ; see docs/decisions/phase-5-frontend.md).
 *  - TAKER FEE is a real on-chain read (useMarketFees), not the mockup's 0.035% — the
 *    live market is currently configured at 0%.
 *  - REFERRAL SHARE 25% is retained as literal program-policy marketing copy (not a
 *    computed or per-user figure), distinct from the POINTS panel in the terminal, which
 *    never shows an invented point total or rank.
 */
export default function LandingPage() {
  const { markets } = useMarkets();
  const firstMarket = markets[0];
  const fees = useMarketFees(firstMarket?.pairIndex ?? null);

  return (
    <div>
      <TickerStrip />

      <section className="landing-hero">
        <div className="copy">
          <h1>
            Space is the
            <br />
            whole edge.
          </h1>
          <p>
            Whitespace is a perpetuals exchange on Whitechain. Oracle-priced, 50× leverage, and an interface that
            gets out of the way of the tape.
          </p>
          <div className="cta-row">
            <Link href="/trade" className="btn-primary" data-testid="cta-start-trading">
              Start trading
            </Link>
            <Link href="/docs" className="btn-secondary">
              Read the docs
            </Link>
          </div>
        </div>
        <div className="brand-render">
          <div className="sphere" />
          <span>[ BRAND RENDER ]</span>
        </div>
      </section>

      <section className="stat-tiles">
        <div className="stat-tile">
          <div className="label mono-upper">Max leverage</div>
          {/* Marketing copy — see file header comment for why this differs from the
              terminal's real per-market figure. */}
          <div className="value">50×</div>
        </div>
        <div className="stat-tile">
          <div className="label mono-upper">Taker fee</div>
          <div className="value" data-testid="landing-taker-fee">
            {fees.takerFeeRaw !== null ? `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%` : '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label mono-upper">Referral share</div>
          <div className="value">25%</div>
        </div>
      </section>

      <MarketsTable />

      <section className="landing-section">
        <h2>Void Points, Season One</h2>
        <p style={{ color: 'var(--fg-muted)', maxWidth: '32em' }}>
          Weighted by maker depth and time at risk, not raw churn. Emissions per epoch are fixed and published
          before the epoch opens. <Link href="/points">See the points panel</Link> — live totals are not available
          yet.
        </p>
      </section>

      <section className="landing-cta">
        <h2>Leave the noise outside.</h2>
        <Link href="/trade" className="btn-primary" style={{ display: 'inline-block', marginTop: '1.5rem' }}>
          Launch Whitespace
        </Link>
      </section>

      <footer className="landing-footer">
        <span>WHITESPACE · WHITECHAIN</span>
        <span>
          <Link href="/docs">DOCS</Link>
        </span>
      </footer>
    </div>
  );
}
