'use client';

import { useMarkets } from '@/hooks/useMarkets';
import { usePriceImpactLadder, type LadderUnavailableReason } from '@/hooks/usePriceImpactLadder';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';
import { formatExact, formatMoney } from '@/lib/money';
import { baseSizeForNotional } from '@/lib/pnl';
import type { LadderRow } from '@/lib/priceImpact';
import styles from './DepthPanel.module.css';

/**
 * The mockup's ORDER BOOK slot, filled with the only thing in this protocol that is a
 * truthful analogue of book depth.
 *
 * Whitespace has no order book: it is a vault-backed, oracle-priced perp with no resting
 * orders and no counterparties to list (design §3.2). What it *does* have is a real,
 * size-dependent execution price — `TradingCallbacksLib.getDynamicTradePriceImpact`
 * charges spread plus a dynamic impact that grows with the notional you push into the
 * pair. So each row here answers "if I opened this size right now, what would the vault
 * actually fill me at?". These are YOUR prices by size, not other people's orders, and
 * the panel says so on screen rather than only in this comment.
 *
 * The arithmetic lives in src/lib/priceImpact.ts, transcribed line-by-line from the
 * Solidity, and the inputs come from `IOstiumPairInfos` on chain plus the live mark. When
 * any of those inputs is missing the panel renders the missing input by name and nothing
 * else — see the note in usePriceImpactLadder.ts. This panel previously shipped empty on
 * purpose, and a plausible-looking wrong number here would be worse than that empty state,
 * not better.
 */
export function DepthPanel({ pairIndex }: { pairIndex?: number | null } = {}) {
  // The page renders <DepthPanel /> without props today, so fall back to the same market
  // it defaults to (`markets[0]`). Passing the selected `pairIndex` down is a one-line
  // change in app/trade/page.tsx once more than one market is listed.
  const { markets } = useMarkets();
  const resolvedPairIndex = pairIndex ?? markets[0]?.pairIndex ?? null;

  const ladder = usePriceImpactLadder(resolvedPairIndex);

  return (
    <div className="depth-panel" data-testid="depth-panel">
      {/* terminal_design.pdf's header is `ORDER BOOK` with a value in the top-right slot.
          In the reference that slot holds a tick-size selector; there is no grouping to
          select here, so it names the counterparty instead — which is the one thing about
          this book a trader coming from a CLOB needs to know. */}
      <div className={styles.header}>
        <span className="mono-upper">Order book</span>
        <span className={styles.headerNote}>VAULT</span>
      </div>
      {ladder.loading ? (
        <div className={styles.notice} data-testid="depth-panel-loading">
          Reading price-impact parameters from chain…
        </div>
      ) : ladder.rows ? (
        <Ladder ladder={ladder} />
      ) : (
        <Unavailable reasons={ladder.unavailable} chain={ladder.chain} />
      )}
    </div>
  );
}

function Ladder({ ladder }: { ladder: ReturnType<typeof usePriceImpactLadder> }) {
  const rows = ladder.rows;
  const mark = ladder.markRaw;
  if (!rows || mark === null) return null;

  // Number() is reached only here, and only to produce a CSS percentage for the decorative
  // depth bar — never for a monetary value (src/lib/money.ts).
  const deepest = ladder.levels.reduce((a, b) => (b > a ? b : a), 0n);
  const barWidth = (row: LadderRow) => `${Number((row.notionalRaw * 10000n) / deepest) / 100}%`;

  // Rows only ever render with a complete quote (the hook refuses otherwise), so both sides
  // are non-null here.
  const spread = (ladder.askRaw ?? 0n) - (ladder.bidRaw ?? 0n);

  return (
    <div className={styles.ladder} data-testid="depth-panel-ladder">
      <div className={styles.cols}>
        <span>PRICE</span>
        <span className={styles.cell}>SIZE</span>
        <span className={styles.cell}>TOTAL</span>
      </div>

      {/* Asks already arrive worst-first from the hook, which is exactly the reference's
          order: the largest size (furthest fill) at the top, the best price touching the
          spread. Do not reverse — an earlier attempt to "fix" the order here inverted a
          ladder that was already right, and the price assertions in DepthPanel.test.tsx
          caught it. */}
      <div className={`${styles.side} ${styles.sideAsk}`}>
        {rows.long.map((row) => (
          <Row key={`long-${row.notionalRaw}`} row={row} mark={mark} width={barWidth(row)} />
        ))}
      </div>

      {/* The mockup's mid row: the reference price with the spread beside it. Both are real
          here — the mark is the EMA the publisher signs as the report's `price`, the spread
          is the live ask minus bid. */}
      <div className={styles.mid} data-testid="depth-panel-mid">
        <span className={styles.midPrice}>{formatMoney(mark, PRICE_DECIMALS_NUM, { fractionDigits: 2 })}</span>
        <span className={ladder.degraded ? styles.degraded : styles.midLabel}>
          {ladder.degraded
            ? 'oracle degraded'
            : `spread ${formatMoney(spread, PRICE_DECIMALS_NUM, { fractionDigits: 2 })}`}
        </span>
      </div>

      {/* Bids run downward away from the mid — smallest notional (best bid) first, which
          is already the ladder's natural order. */}
      <div className={`${styles.side} ${styles.sideBid}`}>
        {rows.short.map((row) => (
          <Row key={`short-${row.notionalRaw}`} row={row} mark={mark} width={barWidth(row)} />
        ))}
      </div>
    </div>
  );
}

/**
 * One book row, in the reference's three columns.
 *
 *   PRICE  the fill this size would actually get, from the contract's price-impact curve
 *   SIZE   that notional expressed in the base asset — what the reference's SIZE column is
 *   TOTAL  the notional itself, in USDW
 *
 * All three are real. What is NOT here, and cannot be, is someone else's resting order:
 * this protocol has no counterparties to list (design §3.2), so the rows answer "what
 * would I be filled at for this size" rather than "who is offering what". The IMPACT bps
 * column the panel used to carry said the same thing in a shape no trader reads; the
 * information survives as the spacing between PRICE and the mark.
 */
function Row({ row, mark, width }: { row: LadderRow; mark: bigint; width: string }) {
  const sideClass = row.side === 'long' ? styles.long : styles.short;
  const baseSize = baseSizeForNotional(row.notionalRaw, row.priceAfterImpact);

  // The bps figure is no longer a column, but it is still the most precise statement of
  // what this row costs, so it moves to the row's tooltip rather than being dropped.
  // `priceImpactP` is a PERCENT at 1e18 scale and ABSOLUTE (the Solidity takes
  // `SignedMath.abs(price - usedPrice)`), so 1e18 == 1% == 100 bps and `* 100n` is exact.
  //
  // The SIGN has to be derived, and it is NOT simply "long = up": `price` is the EMA mark
  // while ask/bid are the current index quote, so the mark can sit outside the quote and a
  // fill can land on the favourable side of it. Sign by what it costs the trader — a long
  // filled above the mark is worse, a short filled above the mark is better. A zero
  // deviation gets no sign at all, because "−0.000" would imply a favourable fill that is
  // not there.
  const adverse = row.side === 'long' ? row.priceAfterImpact > mark : row.priceAfterImpact < mark;
  const sign = row.priceImpactP === 0n ? '' : adverse ? '+' : '−';
  const impactBps = `${sign}${formatMoney(row.priceImpactP * 100n, 18, { fractionDigits: 3, grouping: false })}`;

  return (
    <div
      className={`${styles.row} ${sideClass}`}
      style={{ ['--depth-width' as string]: width }}
      data-testid="depth-panel-row"
      data-side={row.side}
      data-notional={row.notionalRaw.toString()}
      title={`Fill for ${formatMoney(row.notionalRaw, COLLATERAL_DECIMALS, { fractionDigits: 0 })} USDW notional · ${impactBps} bps from the mark`}
    >
      <span className={`${styles.cell} ${styles.price}`}>
        {formatMoney(row.priceAfterImpact, PRICE_DECIMALS_NUM, { fractionDigits: 2 })}
      </span>
      <span className={styles.cell}>
        {formatMoney(baseSize, PRICE_DECIMALS_NUM, { fractionDigits: 4, grouping: false })}
      </span>
      <span className={styles.cell}>{formatMoney(row.notionalRaw, COLLATERAL_DECIMALS, { fractionDigits: 0 })}</span>
    </div>
  );
}

function Unavailable({
  reasons,
  chain,
}: {
  reasons: LadderUnavailableReason[];
  chain: ReturnType<typeof usePriceImpactLadder>['chain'];
}) {
  return (
    <div className={styles.notice} data-testid="depth-panel-unavailable">
      <span className={`${styles.noticeTitle} mono-upper`}>Impact ladder unavailable</span>
      No number is shown because an input the contract&apos;s formula needs is missing — a guessed ladder would
      be worse than none.
      <ul className={styles.reasons}>
        {reasons.map((reason) => (
          <li key={reason.kind} data-testid={`depth-panel-reason-${reason.kind}`}>
            {reason.detail}
          </li>
        ))}
      </ul>
      {chain && (
        <div className={styles.readout} data-testid="depth-panel-readout">
          <span>pairInfos</span>
          {/* Truncated for a 260px column; the full address is on the title attribute so it
              stays copyable/inspectable rather than being lost. */}
          <span className={styles.readoutValue} title={PAIR_INFOS_ADDRESS}>
            {`${PAIR_INFOS_ADDRESS.slice(0, 6)}…${PAIR_INFOS_ADDRESS.slice(-4)}`}
          </span>
          <span>priceImpactK</span>
          <span className={styles.readoutValue}>{formatExact(chain.priceImpactK, 27)}</span>
          <span>netVolThreshold</span>
          <span className={styles.readoutValue}>{formatExact(chain.netVolThreshold, 18)}</span>
          <span>decayRate</span>
          <span className={styles.readoutValue}>{formatExact(chain.decayRate, 18)}</span>
          <span>buyVolume</span>
          <span className={styles.readoutValue}>{formatExact(chain.buyVolume, 18)}</span>
          <span>sellVolume</span>
          <span className={styles.readoutValue}>{formatExact(chain.sellVolume, 18)}</span>
        </div>
      )}
    </div>
  );
}
