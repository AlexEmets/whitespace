'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMarketFees } from '@/hooks/useMarketFees';
import { useMarkets } from '@/hooks/useMarkets';
import { useProtocolParams } from '@/hooks/useProtocolParams';
import {
  CHAIN_ID,
  CHAIN_INFO,
  COLLATERAL_DECIMALS,
  DEFAULT_SLIPPAGE_BPS,
  MIN_HEALTHY_VENUES_REEXPORT,
} from '@/lib/config';
import { DEPLOYMENT_1874 } from '@/lib/deployment';
import { formatBps, formatMoney } from '@/lib/money';
import styles from './docs.module.css';

/**
 * /docs — how this exchange actually works, for someone about to put collateral into it.
 *
 * Ground rules this page was written under, because a docs page is the easiest place in a
 * product to write something that sounds right and is not:
 *
 *  1. Every claim traces to either `docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md`,
 *     one of `docs/decisions/*.md`, or a `view` call against the deployed contracts.
 *  2. Every number that can be read from the chain IS read from the chain, live, rather
 *     than transcribed. Where the documents and the deployment disagree — and on the
 *     oracle they do — the chain wins and the reader is told so.
 *  3. The mockups' marketing figures (50x leverage, 0.035% taker, 25% referral) are not
 *     repeated here. Two of them contradict the live configuration and the third describes
 *     a programme that was cut.
 *  4. The limitations section is not an appendix. A trader who reads only half this page
 *     should still have hit the part that says the liquidation upkeep is not deployed.
 */

/**
 * The block explorer that indexes chain 1874.
 *
 * Nothing in this repo configures an explorer, so this was not taken on faith — it was
 * verified before being linked. `GET /api/v2/addresses/<vault>` on this host returns the
 * vault's real creation transaction, its creator, and a
 * `block_number_balance_updated_at` of ~7.39M, matching the head this deployment is
 * indexed at. It is a Blockscout instance, branded "Whitechain Sepolia".
 *
 * The check mattered: Whitechain runs two testnets on confusingly similar hostnames (1874
 * at `rpc.testnet.…`, 2625 at `rpc-testnet.…`), and linking the wrong one would send a
 * trader to an "address not found" page for the contract holding their collateral — worse
 * than plain text.
 */
const EXPLORER_BASE = 'https://explorer.testnet.whitechain.io';

interface SectionDef {
  id: string;
  title: string;
}

const SECTIONS: SectionDef[] = [
  { id: 'model', title: 'The model' },
  { id: 'lifecycle', title: 'Order lifecycle' },
  { id: 'slippage', title: 'Slippage protection' },
  { id: 'margin', title: 'Margin & liquidation' },
  { id: 'oracle', title: 'The signed oracle' },
  { id: 'fees', title: 'Fees' },
  { id: 'contracts', title: 'Contracts' },
  { id: 'limits', title: 'What is not live' },
];

function P({ children }: { children: ReactNode }) {
  return <p className={styles.p}>{children}</p>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className={styles.h3}>{children}</h3>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className={styles.list}>{children}</ul>;
}

function LI({ children }: { children: ReactNode }) {
  return <li className={styles.li}>{children}</li>;
}

function Caveat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.caveat}>
      <div className={`${styles.caveatLabel} mono-upper`}>{label}</div>
      <p className={styles.caveatBody}>{children}</p>
    </div>
  );
}

function DocSection({ index, id, title, children }: { index: number; id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} id={id} data-testid={`docs-section-${id}`}>
      <div className={`${styles.sectionNumber} mono-upper`}>{String(index).padStart(2, '0')}</div>
      <h2 className={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

/** A live-read value, or the app's honest dash if the read has not landed. */
function Live({ value, reason }: { value: string | null; reason: string }) {
  if (value === null) {
    return (
      <span className="dash" title={`Not available: ${reason}`}>
        —
      </span>
    );
  }
  return <strong data-testid="docs-live-value">{value}</strong>;
}

export function DocsArticle() {
  const params = useProtocolParams();
  const { markets } = useMarkets();
  const fees = useMarketFees(markets[0]?.pairIndex ?? null);

  const oracleFee = fees.oracleFeeRaw === null ? null : `${formatMoney(fees.oracleFeeRaw, COLLATERAL_DECIMALS)} USDW`;
  const takerFee = fees.takerFeeRaw === null ? null : `${formatMoney(fees.takerFeeRaw, 6, { grouping: false })}%`;
  const makerFee = fees.makerFeeRaw === null ? null : `${formatMoney(fees.makerFeeRaw, 6, { grouping: false })}%`;

  const contractRows = Object.entries(DEPLOYMENT_1874.contracts) as Array<[string, string]>;

  return (
    <div data-testid="docs-page">
      <header className={styles.head}>
        <div className={`${styles.eyebrow} mono-upper`}>Protocol</div>
        <h1 className={styles.title}>How Whitespace works</h1>
        <p className={styles.lede}>
          Whitespace is a perpetual-futures exchange on Whitechain testnet {CHAIN_ID}. You trade against a shared
          liquidity vault at a price signed by an off-chain oracle — there is no order book and no counterparty to find.
          This page explains what that means for your money, including the parts that are awkward. Every figure marked
          in <strong>bold</strong> below is read live from the deployed contracts as you load the page.
        </p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="Contents">
          <div className={`${styles.tocLabel} mono-upper`}>Contents</div>
          <ol className={styles.tocList}>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.body}>
          <DocSection index={1} id="model" title="A vault, not an order book">
            <P>
              On a normal exchange your counterparty is another trader, matched against you in a book. Here it is a{' '}
              <strong>shared LP vault</strong>. Depositors put USDW into the vault; the vault takes the other side of
              every position, and the price you open and close at comes from an oracle rather than from whoever happens
              to be quoting. When you win, the vault pays you. When you lose, the vault keeps your loss.
            </P>

            <H3>Why there is no book</H3>
            <P>
              A genuinely on-chain order book is not a matter of writing one. The only production example, Hyperliquid,
              needed a bespoke consensus protocol, a matching engine inside chain state, ~200,000 orders/sec, and a
              mempool that understands order-book semantics well enough to sort cancels ahead of aggressive orders. None
              of that is reachable as ordinary EVM contracts on a one-second-block chain with a public mempool — which
              is why even on Arbitrum, no perp team keeps the book on-chain.
            </P>
            <P>
              The decisive argument is simpler than the technical one: <strong>a book with no market makers is an empty
              screen.</strong> This is an independent project with no market-making relationships, on a chain measured
              at 0.4 transactions per block. The vault model exists precisely because it produces tradeable liquidity
              with zero market makers — liquidity is bought with vault capital instead of negotiated with a desk.
            </P>

            <H3>What that costs you, stated plainly</H3>
            <List>
              <LI>
                <strong>No price discovery.</strong> The protocol is a price taker. It cannot disagree with its oracle,
                so oracle correctness is existential rather than merely important — see section 05.
              </LI>
              <LI>
                <strong>Your size is bounded by the vault, not by demand.</strong> Open-interest caps exist because the
                vault has to be able to pay everyone who is winning at once. An order that would breach the cap is
                cancelled with <code>EXPOSURE_LIMITS</code>.
              </LI>
              <LI>
                <strong>There is no depth to read.</strong> No resting bids or asks, no book to infer intent from. The
                order panel instead shows the vault&rsquo;s two-sided quote for the size you enter — Buy at the ask, Sell
                at the bid, after size-dependent impact — which is exactly the price the contract will fill at.
              </LI>
              <LI>
                <strong>LPs absorb trader PnL.</strong> If you are an LP, you are the house — fees, spread and funding
                are what have to cover traders&rsquo; winnings over time.
              </LI>
            </List>
            <p className={styles.sourceLine}>
              Source: design spec §1 (counterparty model), §3.2 (why not an order book), §3.3 (accepted costs).
            </p>
          </DocSection>

          <DocSection index={2} id="lifecycle" title="Your order happens in two phases">
            <P>
              This is the single most important mechanic on this exchange, and it is the one that most often surprises
              people: <strong>when your transaction confirms, you do not have a position.</strong> You have a request.
            </P>

            <div className={styles.phases}>
              <div className={styles.phase}>
                <div className={`${styles.phaseIndex} mono-upper`}>Phase 1</div>
                <div>
                  <div className={styles.phaseTitle}>You request — wallet-signed, on-chain</div>
                  <div className={styles.phaseBody}>
                    <code>openTrade</code> validates your leverage against the market cap, checks the open-interest
                    caps, takes your collateral, stores a pending order, and asks the price router for a price. That
                    emits a <code>PriceRequestedV2</code> event. No price has been applied to anything yet.
                  </div>
                </div>
              </div>
              <div className={styles.phase}>
                <div className={`${styles.phaseIndex} mono-upper`}>Phase 2</div>
                <div>
                  <div className={styles.phaseTitle}>A keeper delivers a signed price report</div>
                  <div className={styles.phaseBody}>
                    An allowlisted keeper watches for that event, fetches a freshly signed report from the price
                    publisher, and calls <code>performUpkeep</code> with it. The on-chain verifier checks the
                    signatures; the trading callbacks then apply spread and price impact to arrive at your execution
                    price.
                  </div>
                </div>
              </div>
              <div className={`${styles.phase} ${styles.phaseOutcome}`}>
                <div className={`${styles.phaseIndex} mono-upper`}>Outcome</div>
                <div>
                  <div className={styles.phaseTitle}>Filled, or cancelled and refunded</div>
                  <div className={styles.phaseBody}>
                    If the execution price is inside your slippage tolerance and every other check passes, the position
                    opens. Otherwise the order is cancelled and your collateral is returned{' '}
                    <strong>minus the oracle fee</strong> (currently{' '}
                    <Live value={oracleFee} reason="pairOracleFee has not been read yet" />
                    ). Closing a position runs through the identical two phases — &ldquo;close requested&rdquo;, then
                    closed.
                  </div>
                </div>
              </div>
            </div>

            <H3>Why it is built this way</H3>
            <P>
              You commit <em>before</em> the price is known, and the execution price comes from a report signed{' '}
              <em>after</em> your request. That ordering is the whole defence. Single-phase execution against a
              previously-stored oracle price is directly exploitable: watch for the oracle lagging spot, then open at
              the stale price and close into the correction. That is the GMX v1 AVAX exploit class, and it has cost real
              protocols real money.
            </P>

            <H3>If no keeper ever shows up</H3>
            <P>
              Your collateral is not stranded, but it is not instant either. After{' '}
              <Live
                value={params.marketOrdersTimeoutBlocks === null ? null : `${params.marketOrdersTimeoutBlocks} blocks`}
                reason="marketOrdersTimeout has not been read yet"
              />{' '}
              (~1 second per block on this chain) you can reclaim it yourself by calling{' '}
              <code>openTradeMarketTimeout</code> for that order.
            </P>
            <Caveat label="Known gap — a dead window">
              A signed report is only deliverable for{' '}
              <Live value={params.maxAgeSeconds === null ? null : `${params.maxAgeSeconds} seconds`} reason="maxAge has not been read yet" />{' '}
              after its timestamp, but the timeout that lets you reclaim collateral is{' '}
              {params.marketOrdersTimeoutBlocks ?? '—'} blocks. Between those two points there is a window — roughly 20
              blocks — where an order can no longer be filled by anyone but is not yet refundable. It is a usability
              problem rather than a safety one: the collateral is recoverable, just not immediately.
            </Caveat>
            <p className={styles.sourceLine}>
              Source: design spec §5.1; docs/decisions/phase-2-oracle-hardening.md §3, §5, §9;
              docs/decisions/phase-3-price-publisher.md §1–2; docs/decisions/phase-4-indexer-api.md §7.
            </p>
          </DocSection>

          <DocSection index={3} id="slippage" title="Slippage is your only price protection">
            <P>
              On a spot DEX, slippage tolerance is a convenience — you can already see the price. Here it is different
              in kind. Because you commit before the price exists, your slippage tolerance is the{' '}
              <strong>only</strong> thing standing between you and an execution price you would not have accepted. The
              terminal therefore shows it as a first-class control rather than hiding it in an advanced panel, and
              defaults it tight: <strong>{formatBps(DEFAULT_SLIPPAGE_BPS)}</strong>.
            </P>
            <P>
              The check itself compares the execution price against the price you asked for, with a tolerance of{' '}
              <code>slippageP</code> basis points. If the report puts execution outside that band, the callback does not
              fill you at a worse price — it cancels:
            </P>
            <div className={styles.formula}>{`CancelReason.SLIPPAGE
  -> position not opened
  -> collateral returned to you
  -> minus the oracle fee`}</div>
            <P>
              Two things worth internalising. First, the execution price is <strong>not</strong> the raw reported price:
              spread and price impact are applied first, and it is the result that is measured against your tolerance.
              Second, a cancellation is a normal outcome, not a failure — it is the system doing exactly what you asked
              it to do when the price moved.
            </P>
            <p className={styles.sourceLine}>
              Source: design spec §5.1; docs/decisions/phase-5-frontend.md (slippage unit verified against{' '}
              <code>OstiumTrading.sol</code> <code>PERCENT_BASE = 100e2</code> and the check in{' '}
              <code>TradingCallbacksLib.sol</code>); <code>CancelReason</code> from{' '}
              <code>IOstiumTradingCallbacks.sol</code>.
            </p>
          </DocSection>

          <DocSection index={4} id="margin" title="Isolated margin, and how liquidation actually decides">
            <P>
              Margin is <strong>isolated</strong>, not cross. Each position carries its own collateral, and a losing
              position can take that collateral and nothing else. A second position in another market is not exposed to
              it, and neither is your wallet balance.
            </P>

            <H3>The trigger is a value test, not a price</H3>
            <P>
              Most exchanges give you a liquidation price. This one does not, and the reason is worth stating rather
              than papering over. The on-chain check is not a price comparison at all — it evaluates your position&rsquo;s
              current value against a margin floor:
            </P>
            <div className={styles.formula}>{`tradeValue     = collateral
                 + collateral * percentProfit / 1e6 / 100
                 - rolloverFee
                 - fundingFee                      (floored at 0)

liqMarginValue = collateral * liqMarginThresholdP * leverage
                 / maxLeverage / 100

liquidated     when  tradeValue < liqMarginValue  (strictly less)`}</div>
            <P>
              <code>liqMarginThresholdP</code> is currently{' '}
              <Live
                value={params.liqMarginThresholdP === null ? null : String(params.liqMarginThresholdP)}
                reason="liqMarginThresholdP has not been read yet"
              />
              , and it is governance-mutable — it can change without your position changing. Note the strict{' '}
              <code>&lt;</code>: a position sitting exactly at the threshold is <em>not</em> liquidatable.
            </P>
            <P>
              Both <code>rolloverFee</code> and <code>fundingFee</code> accrue continuously against your position, which
              means <strong>your liquidation level moves even when the price does not.</strong> That is the deeper
              reason a single &ldquo;liquidation price&rdquo; is misleading here: it is a snapshot of a moving quantity.
            </P>
            <Caveat label="Why the Liq. column is a dash">
              The contract does expose a <code>getTradeLiquidationPrice</code> view — but the liquidation path never
              calls it, and it disagrees with the real predicate exactly at the boundary, where it matters. Showing its
              output as &ldquo;your liquidation price&rdquo; would be presenting an approximation as a guarantee, so the
              terminal and the portfolio both show an explained dash instead.
            </Caveat>

            <H3>What protects you from a single bad tick</H3>
            <P>
              The mark price used for risk is an <strong>EMA of the index</strong>, not the latest tick, specifically so
              that one outlier print cannot cascade a book of positions into liquidation. Liquidations also run through
              the same two-phase signed-price flow as your own close — there is no faster path for the liquidator than
              there is for you — and the liquidator suppresses all new submissions whenever the oracle is degraded (see
              section 05).
            </P>
            <Caveat label="Not currently operational on testnet 1874">
              The repo&rsquo;s phase-6 record (<code>docs/decisions/phase-6-liquidator.md</code> §2.6) states that the
              automation upkeep liquidations execute through, <code>OstiumTradesUpKeep</code>, is not deployed on this
              chain — and that its entry point is gated to an allowlisted forwarder rather than being permissionless, so
              no third party can substitute for it. Treat automatic liquidation as <em>not yet proven on this
              deployment</em>. This has not been independently re-probed by this page.
            </Caveat>
            <p className={styles.sourceLine}>
              Source: docs/decisions/phase-6-liquidator.md §2.1–2.6, §4; docs/decisions/phase-5-frontend.md (isolated
              margin ruling); design spec §5.2 (mark = EMA of index).
            </p>
          </DocSection>

          <DocSection index={5} id="oracle" title="The price is signed by k of N">
            <P>
              Everything above rests on the price being right, so this is the part of the system with the most defence
              built into it. A price only becomes usable on-chain if enough independent signers have signed it{' '}
              <em>and</em> the number itself survives a set of contract-level sanity rails. Those are two different
              checks on two different assumptions, and neither substitutes for the other.
            </P>

            <H3>Layer 1 — threshold signatures</H3>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <td className={`${styles.td} ${styles.tdKey}`}>Signatures required (k)</td>
                  <td className={`${styles.td} ${styles.tdNum}`} data-testid="oracle-threshold">
                    <Live value={params.threshold === null ? null : String(params.threshold)} reason="verifier.threshold() has not returned" />
                  </td>
                </tr>
                <tr>
                  <td className={`${styles.td} ${styles.tdKey}`}>Authorised signers (N)</td>
                  <td className={`${styles.td} ${styles.tdNum}`} data-testid="oracle-signers">
                    <Live value={params.signerCount === null ? null : String(params.signerCount)} reason="verifier.signerCount() has not returned" />
                  </td>
                </tr>
                <tr>
                  <td className={`${styles.td} ${styles.tdKey}`}>Report max age</td>
                  <td className={`${styles.td} ${styles.tdNum}`}>
                    <Live value={params.maxAgeSeconds === null ? null : `${params.maxAgeSeconds}s`} reason="upkeep.maxAge() has not returned" />
                  </td>
                </tr>
                <tr>
                  <td className={`${styles.td} ${styles.tdKey}`}>Max deviation vs last price</td>
                  <td className={`${styles.td} ${styles.tdNum}`}>
                    <Live
                      value={params.maxDeviationBps === null ? null : `${params.maxDeviationBps} bps`}
                      reason="upkeep.maxDeviationBps() has not returned"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
            <P>
              The signers sign one hash over a fixed payload: the chain id, the verifier&rsquo;s own address, the feed
              id, a timestamp, and the price, bid and ask at 18 decimals. Putting the chain id and verifier address{' '}
              <em>inside</em> the signed bytes is what makes a report from one chain worthless on another — testnet and
              mainnet run the same contracts with the same signer set, and without this a testnet report would be a
              mainnet report.
            </P>
            <P>
              The verifier requires the recovered signer addresses to be <strong>strictly ascending</strong>. That is
              not tidiness: it is what stops one compromised key from reaching the threshold by submitting the same
              signature k times. And a single unauthorised signature rejects the entire report — it is not skipped and
              counted as one fewer.
            </P>

            <H3>Layer 2 — rails that do not care who signed</H3>
            <P>
              Threshold signatures defend against key compromise. They are powerless against the case where every signer
              is honest and they all receive the <em>same wrong input</em> — all N will faithfully sign a falsehood. The
              deviation rail catches exactly that, because it does not ask who signed, it asks whether the number is
              plausible against the last accepted one. Alongside it sit a staleness bound, a per-feed circuit breaker,
              and a global pause. The pause is a hot-key emergency stop: a guardian can stop the system immediately, but
              only governance can restart it.
            </P>
            <Caveat label="A pause stops closes too">
              The emergency stop halts new orders, closes and liquidations alike. That is intended behaviour for a
              circuit breaker, but it means &ldquo;you can always exit&rdquo; is not a promise this system makes.
            </Caveat>

            <H3>Where the price comes from before it is signed</H3>
            <P>
              The publisher ingests four venues — Binance, Bybit, OKX and WhiteBIT — and takes each one&rsquo;s{' '}
              <strong>mid of best bid and ask, never last trade</strong>, because a last trade can be moved with one
              cheap order. A venue is dropped if its data is stale, if its spread is too wide, or if it disagrees with
              the median of the others by too much. The surviving venues produce the index; the mark is an EMA of it.
            </P>
            <P>
              Below its healthy-source minimum — <strong>{MIN_HEALTHY_VENUES_REEXPORT}</strong> for a market the major
              exchanges all quote — the market goes <strong>degraded</strong>, and the policy is asymmetric on purpose:{' '}
              <strong>closes are allowed, opens are blocked.</strong> If the price cannot be trusted, letting people out
              is the lesser risk; letting new positions in against an unreliable index is not.
            </P>
            <P>
              The minimum is per market, not global. A market that only one exchange lists carries a lower one, met by
              that exchange&rsquo;s separate spot and perpetual books so the two still cross-check each other. Such a
              market is listed with a lower leverage ceiling and a smaller open-interest cap to match the narrower base
              its price rests on. The banner and the order ticket always name the requirement the market you are looking
              at is actually judged by.
            </P>
            <Caveat label="The degraded signal has a blind spot">
              <code>GET /price/:pairIndex</code> answers from one of two sources and says which. When the publisher
              answers, it carries the healthy-venue list and the degraded flag, and the trading form blocks opening on
              it. When the publisher is unreachable the API falls back to the chain&rsquo;s last settled price, which
              carries no venue health at all — <code>healthyVenues</code> and <code>degraded</code> come back{' '}
              <code>null</code> rather than being guessed. The publisher&rsquo;s own refusal to sign an open still
              holds in that mode, but the front-end gate cannot fire on a signal it is not receiving. Check{' '}
              <code>source</code> if it matters to you.
            </Caveat>
            <p className={styles.sourceLine}>
              Source: design spec §5.2, §6.2–6.4; docs/decisions/phase-2-oracle-hardening.md §1–3;
              docs/decisions/phase-3-price-publisher.md §1, §3–4. Live values read from{' '}
              <code>WhitespaceVerifier</code> and <code>WhitespacePriceUpKeep</code> at the addresses in section 07.
            </p>
          </DocSection>

          <DocSection index={6} id="fees" title="What you are charged">
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Fee</th>
                    <th>Live value</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={`${styles.td} ${styles.tdKey}`}>Oracle fee</td>
                    <td className={`${styles.td} ${styles.tdNum}`}>
                      <Live value={oracleFee} reason="pairOracleFee has not been read yet" />
                    </td>
                    <td className={styles.td}>
                      Flat, per price request. Kept even when your order is cancelled — this is the &ldquo;minus the
                      oracle fee&rdquo; in every refund.
                    </td>
                  </tr>
                  <tr>
                    <td className={`${styles.td} ${styles.tdKey}`}>Opening fee · maker</td>
                    <td className={`${styles.td} ${styles.tdNum}`}>
                      <Live value={makerFee} reason="pairOpeningFees has not been read yet" />
                    </td>
                    <td className={styles.td}>Charged on the notional when a position opens.</td>
                  </tr>
                  <tr>
                    <td className={`${styles.td} ${styles.tdKey}`}>Opening fee · taker</td>
                    <td className={`${styles.td} ${styles.tdNum}`}>
                      <Live value={takerFee} reason="pairOpeningFees has not been read yet" />
                    </td>
                    <td className={styles.td}>
                      Same field group. The landing mockup&rsquo;s 0.035% is a design figure and is not what this market
                      is configured with.
                    </td>
                  </tr>
                  <tr>
                    <td className={`${styles.td} ${styles.tdKey}`}>Rollover</td>
                    <td className={`${styles.td} ${styles.tdNum}`}>
                      <span className="dash" title="Not available: no read endpoint publishes the rollover rate">
                        —
                      </span>
                    </td>
                    <td className={styles.td}>
                      Accrues continuously on an open position and is deducted from <code>tradeValue</code> at
                      settlement. The accrual is real; no endpoint publishes the rate, so none is shown.
                    </td>
                  </tr>
                  <tr>
                    <td className={`${styles.td} ${styles.tdKey}`}>Funding</td>
                    <td className={`${styles.td} ${styles.tdNum}`}>
                      <span className="dash" title="Not available: no read endpoint publishes a funding rate">
                        —
                      </span>
                    </td>
                    <td className={styles.td}>
                      Same treatment. The terminal&rsquo;s FUNDING readout is a dash for the same reason, not because
                      funding is zero.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <P>
              Separately from fees, <strong>spread and price impact</strong> move your execution price away from the
              reported one. They are applied on-chain before your slippage tolerance is checked, and this app does not
              reproduce that arithmetic — which is why the unrealised PnL shown on your positions is labelled an
              estimate rather than a payout.
            </P>
            <p className={styles.sourceLine}>
              Source: <code>IOstiumPairsStorage.pairOracleFee</code> and <code>IOstiumPairInfos.pairOpeningFees</code>{' '}
              (both PRECISION_6), read live; docs/decisions/phase-6-liquidator.md §2.3 (rollover/funding accrual);
              docs/decisions/phase-5-frontend.md (fee-honesty ruling).
            </p>
          </DocSection>

          <DocSection index={7} id="contracts" title="The contracts you are actually trading against">
            <P>
              Deployed to <strong>{CHAIN_INFO.name}</strong> (chain {CHAIN_ID}) on{' '}
              {DEPLOYMENT_1874.deployedAt.slice(0, 10)} from commit <code>{DEPLOYMENT_1874.commit.slice(0, 10)}</code>.
              These addresses are read from <code>deployments/1874.json</code> at build time, so this table cannot drift
              from what the app itself calls.
            </P>
            <div className={styles.tableWrap}>
              <table className={styles.addrTable}>
                <thead>
                  <tr>
                    <th className={styles.td} style={{ textAlign: 'left', color: 'var(--fg-muted)', fontWeight: 400 }}>
                      Contract
                    </th>
                    <th className={styles.td} style={{ textAlign: 'left', color: 'var(--fg-muted)', fontWeight: 400 }}>
                      Address
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {contractRows.map(([name, address]) => (
                    <tr key={name} data-testid={`docs-contract-${name}`}>
                      <td className={`${styles.td} ${styles.tdKey}`}>{name}</td>
                      <td className={styles.td}>
                        <a
                          className={styles.addr}
                          href={`${EXPLORER_BASE}/address/${address}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {address}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.footNote}>
              RPC: <code>{CHAIN_INFO.rpc}</code>. Each address links to{' '}
              <a href={EXPLORER_BASE} target="_blank" rel="noreferrer noopener">
                {EXPLORER_BASE.replace('https://', '')}
              </a>
              , confirmed to index this chain by querying it for the vault&rsquo;s own creation transaction — nothing in
              this repo configures an explorer, so it was checked rather than assumed. Collateral is <code>USDW</code>,
              6 decimals; the vault issues 6-decimal shares against it.
            </p>
          </DocSection>

          <DocSection index={8} id="limits" title="What is not live">
            <P>
              This is a testnet deployment and it is not finished. The list below is the honest inventory, not a
              roadmap.
            </P>
            <List>
              <LI>
                <strong>The collateral is not money.</strong> <code>USDW</code> is a faucet token with no supply cap —
                anyone can mint as much as they like. Nothing traded here has value.
              </LI>
              <LI>
                <strong>{markets.length === 0 ? 'Markets are still loading' : `${markets.length} market${markets.length === 1 ? '' : 's'} exists`}.</strong>{' '}
                The markets list is read from the API and is never padded out with placeholder rows.
              </LI>
              <LI>
                <strong>Market orders only.</strong> Limit and stop orders exist as on-chain order types, but the UI to
                place, list and cancel resting orders was not built. TWAP does not exist in the contracts at all.
              </LI>
              <LI>
                <strong>No liquidation price is shown</strong>, anywhere — see section 04 for why that is a decision
                rather than an omission.
              </LI>
              <LI>
                <strong>No funding rate is published</strong> by any endpoint, so the terminal shows a dash rather than
                a number.
              </LI>
              <LI>
                <strong>Partial closes are missing from history.</strong> The indexer only writes a history row when a
                position closes fully, so a partially-closed position stays in your open table until the remainder is
                closed.
              </LI>
              <LI>
                <strong>Live updates are polled, not pushed.</strong> The WebSocket is backed by a poll, so there is no
                latency floor below the poll interval.
              </LI>
              <LI>
                <strong>There is no points programme and no referral programme.</strong> See <Link href="/points">Points</Link>{' '}
                for the full statement; the referral share in the landing mockup describes something that was cut from
                scope.
              </LI>
              <LI>
                <strong>Nothing here has been audited.</strong> No third-party audit has been performed, and static and
                fuzz analysis are not yet wired into CI.
              </LI>
            </List>
            <p className={styles.sourceLine}>
              Source: docs/decisions/phase-0-1.md §5–6; phase-2-oracle-hardening.md §7, §10;
              phase-4-indexer-api.md §6; phase-5-frontend.md (design-honesty rulings).
            </p>
          </DocSection>
        </div>
      </div>
    </div>
  );
}
