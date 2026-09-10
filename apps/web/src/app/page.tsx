'use client';

import Link from 'next/link';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketFees } from '@/hooks/useMarketFees';
import { MarketsTable } from '@/components/MarketsTable';
import { TickerStrip } from '@/components/TickerStrip';
import { formatMoney, leverageToRaw } from '@/lib/money';

/**
 * Landing page. Structure and copy follow landing_design.pdf, with the design-honesty
 * corrections from the phase-5 review:
 *  - "Deep books" -> replaced (this is a vault-backed, oracle-priced perp with no order
 *    book — see design spec §3.2). Kept the rest of the voice.
 *  - MAX LEVERAGE is read from `/markets`, not from the mockup's 50x. The tile makes a
 *    product-wide claim, so it shows the highest per-market cap the API reports — the
 *    same numbers the terminal enforces order-side, so the landing page can never
 *    advertise leverage the trading form would reject.
 *  - TAKER FEE is a real on-chain read (useMarketFees), not the mockup's 0.035% — the
 *    live market is currently configured at 0%.
 *  - REFERRAL SHARE (the stat tile and the mockup's "25% of taker fees" block) is gone:
 *    the referral programme was cut from scope, so there is no policy and no data behind
 *    that number. The POINTS block stays — points are in scope and the copy already
 *    promises no totals until a live service backs them.
 */
export default function LandingPage() {
  const { markets } = useMarkets();
  const firstMarket = markets[0];
  const fees = useMarketFees(firstMarket?.pairIndex ?? null);

  // PRECISION_2 leverage (see src/lib/money.ts), compared as bigint so a 100x cap is
  // never rounded through a JS float. Stays 0n while `/markets` is in flight or failed,
  // which is what renders the placeholder dash below.
  const maxLeverageRaw = markets.reduce((highest, market) => {
    const cap = leverageToRaw(market.maxLeverage);
    return cap > highest ? cap : highest;
  }, 0n);

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
        {/* Hero art: the brand sphere from landing_design.pdf, drawn entirely in CSS (see
            .brand-render in globals.css) — decorative, so it carries no text and is
            hidden from assistive tech rather than being announced as an empty region. */}
        <div className="brand-render" aria-hidden="true">
          <div className="sphere" />
        </div>
      </section>

      <section className="stat-tiles">
        <div className="stat-tile">
          <div className="label mono-upper">Max leverage</div>
          <div className="value" data-testid="landing-max-leverage">
            {/* Same em-dash placeholder the terminal and the taker-fee tile use while a
                figure is unavailable — never a fabricated stand-in number. */}
            {maxLeverageRaw > 0n ? `${formatMoney(maxLeverageRaw, 2, { fractionDigits: 0, grouping: false })}×` : '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label mono-upper">Taker fee</div>
          <div className="value" data-testid="landing-taker-fee">
            {fees.takerFeeRaw !== null ? `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%` : '—'}
          </div>
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
