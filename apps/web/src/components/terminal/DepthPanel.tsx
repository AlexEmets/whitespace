'use client';

import { useMarkets } from '@/hooks/useMarkets';
import { usePriceImpactLadder, type LadderUnavailableReason } from '@/hooks/usePriceImpactLadder';
import { COLLATERAL_DECIMALS, PRICE_DECIMALS_NUM } from '@/lib/config';
import { PAIR_INFOS_ADDRESS } from '@/lib/deployment';
import { formatExact, formatMoney } from '@/lib/money';
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
      <div className={styles.header}>
        <span className="mono-upper">Order book · impact</span>
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
        <span className={styles.cell}>IMPACT bps</span>
      </div>

      <div className={styles.sideLabel}>OPEN LONG · fills at the oracle ask</div>
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

      <div className={`${styles.side} ${styles.sideBid}`}>
        {rows.short.map((row) => (
          <Row key={`short-${row.notionalRaw}`} row={row} mark={mark} width={barWidth(row)} />
        ))}
      </div>
      <div className={styles.sideLabel}>OPEN SHORT · fills at the oracle bid</div>
    </div>
  );
}

function Row({ row, mark, width }: { row: LadderRow; mark: bigint; width: string }) {
  const sideClass = row.side === 'long' ? styles.long : styles.short;

  // `priceImpactP` is a PERCENT at 1e18 scale (1e18 == 1.00%) and is ABSOLUTE — the Solidity
  // takes `SignedMath.abs(price - usedPrice)` on the static path — so the sign has to be
  // derived from the fill itself. It is NOT simply "long = up": `price` is the EMA mark
  // while ask/bid are the current index quote, so the mark can sit outside the quote and a
  // fill can land on the favourable side of it. Sign by what it costs the trader: a long
  // filled above the mark is worse, a short filled above the mark is better.
  // A zero deviation gets no sign at all — "−0.000" would imply a favourable fill that is
  // not there.
  const adverse = row.side === 'long' ? row.priceAfterImpact > mark : row.priceAfterImpact < mark;
  const sign = row.priceImpactP === 0n ? '' : adverse ? '+' : '−';

  // Rendered in BASIS POINTS, not percent. `priceImpactP` is a percent at 1e18 scale, so
  // 1e18 == 1% == 100 bps and the conversion is an exact bigint `* 100n`. Percent was the
  // first choice and it was wrong for this market: the static path's real magnitudes here
  // are ~0.00004% and ~0.00017%, which every row rendered as a flat "0.000%" — a column
  // that reads as broken. In bps the same values are 0.004 and 0.017, and a 0.455% dynamic
  // impact is 45.500, so one fixed precision covers both regimes.
  const impact = `${sign}${formatMoney(row.priceImpactP * 100n, 18, { fractionDigits: 3, grouping: false })}`;

  return (
    <div
      className={`${styles.row} ${sideClass}`}
      style={{ ['--depth-width' as string]: width }}
      data-testid="depth-panel-row"
      data-side={row.side}
      data-notional={row.notionalRaw.toString()}
    >
      <span className={`${styles.cell} ${styles.price}`}>
        {formatMoney(row.priceAfterImpact, PRICE_DECIMALS_NUM, { fractionDigits: 2 })}
      </span>
      <span className={styles.cell}>{formatMoney(row.notionalRaw, COLLATERAL_DECIMALS, { fractionDigits: 0 })}</span>
      <span className={styles.cell}>{impact}</span>
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
