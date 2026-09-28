'use client';

import Link from 'next/link';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useProtocolParams } from '@/hooks/useProtocolParams';
import { useQuote } from '@/hooks/useQuote';
import { MarketsTable } from '@/components/MarketsTable';
import { TickerStrip } from '@/components/TickerStrip';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { marketLabel } from '@/lib/markets';
import { formatMoney, leverageToRaw } from '@/lib/money';

/** The size the landing page's live quote is shown for: a round 10,000 USDW of notional,
 * large enough that the size-dependent impact is visible in the two prices. */
const DEMO_NOTIONAL_RAW = 10_000n * 10n ** BigInt(COLLATERAL_DECIMALS);

/**
 * Landing page, in the Eclipse design. Every figure on it is read, not written:
 *  - MAX LEVERAGE is the highest per-market cap `/markets` reports — the same numbers the
 *    ticket enforces, so the page can never advertise leverage the ticket would reject.
 *  - TAKER / MAKER FEE are on-chain reads (useMarketFees).
 *  - ORACLE QUORUM is the verifier's own k-of-N (useProtocolParams).
 *  - The quote card is the vault's live two-sided quote (useQuote), the contract's own
 *    fill formula, for 10,000 USDW of the first listed market.
 * Anything not yet read renders the em-dash placeholder, never a stand-in number.
 */
export default function LandingPage() {
  const { markets } = useMarkets();
  const firstMarket = markets[0];
  const fees = useMarketFees(firstMarket?.pairIndex ?? null);
  const { threshold, signerCount } = useProtocolParams();
  const { quote } = useQuote(firstMarket?.pairIndex ?? null, DEMO_NOTIONAL_RAW);

  // PRECISION_2 leverage (see src/lib/money.ts), compared as bigint so a 100x cap is
  // never rounded through a JS float. Stays 0n while `/markets` is in flight or failed.
  const maxLeverageRaw = markets.reduce((highest, market) => {
    const cap = leverageToRaw(market.maxLeverage);
    return cap > highest ? cap : highest;
  }, 0n);
  const maxLeverageLabel =
    maxLeverageRaw > 0n ? `${formatMoney(maxLeverageRaw, 2, { fractionDigits: 0, grouping: false })}×` : null;

  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="copy">
          <span className="eyebrow">Perpetuals · Whitechain testnet</span>
          <h1>
            Space is the
            <br />
            <em>whole</em> edge.
          </h1>
          {/* The leverage clause comes from the same `/markets` read as the tile below;
              with no market loaded it is dropped rather than filled with a placeholder. */}
          <p>
            Whitespace is a perpetuals exchange on Whitechain. Oracle-priced
            {maxLeverageLabel ? `, up to ${maxLeverageLabel} leverage,` : ','} and an interface that gets out of the way
            of the tape.
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
        {/* Hero art: the eclipse, drawn entirely in CSS (.brand-render in globals.css).
            Decorative, so it carries no text and is hidden from assistive tech. */}
        <div className="brand-render" aria-hidden="true">
          <div className="ring ring-outer" />
          <div className="ring ring-inner" />
          <div className="sphere" />
          <div className="moon" />
        </div>
      </section>

      <TickerStrip />

      <section className="stat-tiles" style={{ marginTop: '2.5rem' }}>
        <div className="stat-tile">
          <div className="label">Max leverage</div>
          <div className="value" data-testid="landing-max-leverage">
            {maxLeverageLabel ?? '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Taker fee</div>
          <div className="value" data-testid="landing-taker-fee">
            {fees.takerFeeRaw !== null ? `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%` : '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Maker fee</div>
          <div className="value" data-testid="landing-maker-fee">
            {fees.makerFeeRaw !== null ? `${formatMoney(fees.makerFeeRaw, 6, { grouping: false })}%` : '—'}
          </div>
        </div>
        <div className="stat-tile accent">
          <div className="label">Oracle quorum</div>
          <div className="value" data-testid="landing-oracle-quorum">
            {threshold !== null && signerCount !== null ? `${threshold} of ${signerCount}` : '—'}
          </div>
        </div>
      </section>

      <section className="landing-section landing-split">
        <div>
          <span className="section-eyebrow">01 · No order book</span>
          <h2>You don&rsquo;t read a book. You get a quote.</h2>
          <p className="lede">
            One vault is the counterparty to every trade. Type a size and the ticket shows the vault&rsquo;s two-sided
            price for exactly that size — computed with the same formula the contract fills at, so what you see is
            what the chain will do.
          </p>
        </div>
        <div className="quote-demo panel" data-testid="landing-quote">
          <div className="row">
            <span>
              {firstMarket ? marketLabel(firstMarket) : 'Market'} · 10,000 USDW
            </span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>
              {quote ? 'live' : '—'}
            </span>
          </div>
          <hr />
          <div className="row">
            <span style={{ color: 'var(--long)' }}>Buy · ask + impact</span>
            <span className="big pos">{quote ? formatMoney(quote.buyPrice, PRICE_DECIMALS_NUM) : '—'}</span>
          </div>
          <div className="row">
            <span style={{ color: 'var(--short)' }}>Sell · bid − impact</span>
            <span className="big neg">{quote ? formatMoney(quote.sellPrice, PRICE_DECIMALS_NUM) : '—'}</span>
          </div>
          <hr />
          <div className="row">
            <span>Spread</span>
            <span>{quote ? `${formatMoney(quote.spreadP, 18, { fractionDigits: 4, grouping: false })}%` : '—'}</span>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <span className="section-eyebrow">02 · How a trade happens</span>
        <h2>Commit first. Price second.</h2>
        <p className="lede">Nobody can trade against a price they have already seen.</p>
        <div className="steps">
          <div className="step panel">
            <span className="step-index">01</span>
            <h3>You commit</h3>
            <p>Size, leverage and your max slippage go on-chain before any price exists for the order.</p>
          </div>
          <div className="step panel">
            <span className="step-index">02</span>
            <h3>The oracle signs</h3>
            <p>
              Exchange feeds become one median price, signed by a quorum of independent keys. A report too old or too
              far from the last one is refused.
            </p>
          </div>
          <div className="step panel">
            <span className="step-index">03</span>
            <h3>The vault fills</h3>
            <p>The contract fills at the signed price, or cancels if it breaks your slippage. A stuck order is yours to reclaim.</p>
          </div>
        </div>
      </section>

      <MarketsTable />

      <section className="landing-section">
        <div className="steps two-up">
          <div className="step panel">
            <span className="step-index">Void Points</span>
            <h3>Not live yet.</h3>
            {/* No points contract, no emission schedule and no snapshot exist, which is
                exactly what /points says in full. This page must not promise otherwise. */}
            <p>
              There is no points contract, no emission schedule and no snapshot — nothing traded today carries a
              promised allocation. <Link href="/points">The points page</Link> shows the activity such a programme
              would be computed from.
            </p>
          </div>
          <div className="step panel">
            <span className="step-index">Testnet USDW</span>
            <h3>Collateral to practise with.</h3>
            <p>
              USDW is a mintable test token with no value. <Link href="/faucet">Claim some from the faucet</Link>, then
              open a position in the terminal.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-cta panel">
        <h2>Leave the noise outside.</h2>
        <Link href="/trade" className="btn-primary">
          Launch Whitespace
        </Link>
      </section>

      <footer className="landing-footer">
        <span>whitespace · Whitechain testnet 1874</span>
        <span>
          <Link href="/docs">Docs</Link>
          <Link href="/faucet">Faucet</Link>
          <Link href="/vaults">Vaults</Link>
        </span>
      </footer>
    </div>
  );
}
