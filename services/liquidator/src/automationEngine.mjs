/**
 * The automation bot's sweep: every open trade and every resting LIMIT/STOP entry from
 * the indexer, re-read from chain, decided with the contract's own trigger rules, gated
 * per kind, deduped, cooled down, and sent as batched performUpkeep calls.
 *
 * One sweep:
 *   1. Candidates from the indexer DB (positions + limit orders). A DB failure fails the
 *      sweep — acting on a partial view would silently skip positions.
 *   2. One publisher /status snapshot (the prices a report would carry right now).
 *   3. Per candidate, isolated (one failing read costs that candidate, not the sweep), up to
 *      `evaluationConcurrency` candidates at a time:
 *        - skip if every kind it could fire is cooling down (saves the chain reads);
 *        - re-read the slot from chain; gone -> skip (lost race / indexer lag / reorg);
 *        - decide with triggerRules.mjs on the chain values, never the DB values;
 *        - gate with degradedMode.canTrigger;
 *        - skip if the timestamp would be BACKDATED_EXECUTION / NO_TP / NO_SL
 *          (OstiumTrading.sol:585-619) or a trigger is already pending on chain
 *          (PENDING_TRIGGER, :621-623).
 *   4. Dedupe by (trader, pair, index, kind), chunk into batches of <= maxBatchSize,
 *      and hand every batch at once to the injected (pipelined) sendPerformUpkeep.
 *
 * The trigger timestamp is taken immediately before each send, never at sweep start. It
 * becomes the order's request timestamp, and WhitespacePriceUpKeep refuses the keeper's
 * report with StaleReport once block.timestamp > timestamp + maxAge (10 s). A sweep that
 * reads a few hundred slots one after another takes longer than that, so a timestamp
 * captured up front made every trigger of a busy sweep undeliverable — while each one still
 * parked its trade behind TriggerPending for triggerTimeout blocks. Every send also carries
 * a deadline `deliveryMarginSec` short of that window (the keeper needs the rest to see the
 * request and land the report); the sender broadcasts nothing after it.
 *
 * A later timestamp is always safe for the decisions made earlier in the sweep: the
 * BACKDATED / NO_SL / NO_TP checks only get easier to pass as the timestamp grows.
 *
 * Per position at most one close kind fires, in LIQ > SL > TP order: the callback turns
 * any close of a liquidatable trade into a liquidation (OstiumTradingCallbacks.sol:546,
 * :583-584), so when LIQ is hit but gated (degraded market, recovery window), SL and TP
 * are held back too — otherwise they would liquidate through the side door.
 *
 * Cooldown: after a send (success or failure) the key is not re-sent for cooldownMs.
 * A NOT_HIT callback clears the on-chain trigger at once, so without this a boundary
 * position would be re-triggered every sweep. Two instances race harmlessly: the loser
 * gets PENDING_TRIGGER / NO_TRADE / NO_LIMIT, which is a status, not a revert.
 *
 * Batch isolation: executeAutomationOrder can revert (pair delisted, trading done) and a
 * revert of one entry reverts the whole batch. When a multi-trigger batch REVERTS (mined,
 * or refused by estimateGas), its keys are marked isolated and go out one per transaction
 * on the very next sweep, without a cooldown: a reverted batch set nothing on chain, and
 * all but one of its keys are innocent. Only the key that then reverts on its own is cooled
 * down. Any other failure (receipt timeout, RPC, nonce) says nothing about the batch's
 * contents, so it isolates nobody — and is cooled down, since the transaction may still
 * mine. Isolation is forgotten for a key whose slot is no longer listed by the indexer.
 */

import { LimitOrder } from './abi.mjs';
import { canTrigger, isDegraded } from './degradedMode.mjs';
import { evaluateCloseTriggers, evaluateOpenTrigger, isTradeableQuote, TriggerKind } from './triggerRules.mjs';

export const DEFAULT_MAX_BATCH_SIZE = 20;
/** triggerTimeout is 30 blocks at ~1 s/block; a NOT_HIT is not retried sooner than that. */
export const DEFAULT_COOLDOWN_MS = 30_000;
/** WhitespacePriceUpKeep.maxAge: the keeper has this long after the trigger timestamp. */
export const DEFAULT_REPORT_MAX_AGE_SEC = 10;
/** Of that window, what the keeper needs once our trigger is mined: notice the request
 * (1 s poll), fetch a report, land its own transaction. */
export const DEFAULT_DELIVERY_MARGIN_SEC = 4;
/** Candidate evaluations in flight at once. Each one costs a handful of eth_calls. */
export const DEFAULT_EVALUATION_CONCURRENCY = 16;

const LIMIT_ORDER_CODE = { TP: LimitOrder.TP, SL: LimitOrder.SL, LIQ: LimitOrder.LIQ, OPEN: LimitOrder.OPEN };
const CLOSE_KINDS = [TriggerKind.LIQ, TriggerKind.SL, TriggerKind.TP];

/** A failure caused by what the batch asked the contract to do, rather than by delivery. */
export function isRevert(result) {
  return result.reverted === true || /revert/i.test(String(result.reason ?? ''));
}

export function triggerKey(trader, pairIndex, index, kind) {
  return `${String(trader).toLowerCase()}-${pairIndex}-${index}-${kind}`;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight; results in input order.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * @param {object} deps
 * @param {() => Promise<{ positions: any[], limitOrders: any[], limitOrdersAvailable?: boolean }>} deps.listCandidates
 * @param {() => Promise<{ quoteFor: (pairIndex: number) => Promise<{ price: bigint, bid: bigint, ask: bigint, healthyVenueCount: number, minHealthyVenues: number }> }>} deps.readPriceSnapshot
 * @param {(trader: string, pairIndex: number, index: number) => Promise<object|null>} deps.readTrade
 * @param {(trader: string, pairIndex: number, index: number) => Promise<object|null>} deps.readLimitOrder
 * @param {(trader: string, pairIndex: number, index: number) => Promise<object>} deps.readOpenFees
 * @param {(pairIndex: number) => Promise<object>} deps.readImpact
 * @param {(pairIndex: number, isDayTrade: boolean) => Promise<bigint>} deps.readMaxLeverage
 * @param {() => Promise<bigint>} deps.readLiqMarginThresholdP
 * @param {(trader: string, pairIndex: number, index: number, limitOrder: number) => Promise<boolean>} deps.readTriggerPending
 * @param {{ state: string }} deps.sequencerMonitor
 * @param {(payload: { trades: object[], timestamp: number, deadlineMs: number }) => Promise<{ ok: boolean, hash?: string, reason?: string, reverted?: boolean, expired?: boolean, attempts?: number }>} deps.sendPerformUpkeep
 * @param {() => number} [deps.now] ms
 * @param {number} [deps.maxBatchSize]
 * @param {number} [deps.cooldownMs]
 * @param {number} [deps.reportMaxAgeSec]
 * @param {number} [deps.deliveryMarginSec]
 * @param {number} [deps.evaluationConcurrency]
 * @param {boolean} [deps.liquidateWhenDegraded]
 * @param {object} [deps.metrics] see metrics.mjs
 */
export function createAutomationEngine({
  listCandidates,
  readPriceSnapshot,
  readTrade,
  readLimitOrder,
  readOpenFees,
  readImpact,
  readMaxLeverage,
  readLiqMarginThresholdP,
  readTriggerPending,
  sequencerMonitor,
  sendPerformUpkeep,
  now = Date.now,
  maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  reportMaxAgeSec = DEFAULT_REPORT_MAX_AGE_SEC,
  deliveryMarginSec = DEFAULT_DELIVERY_MARGIN_SEC,
  evaluationConcurrency = DEFAULT_EVALUATION_CONCURRENCY,
  liquidateWhenDegraded = false,
  metrics = {},
}) {
  if (!(maxBatchSize >= 1)) throw new Error(`createAutomationEngine: maxBatchSize must be >= 1, got ${maxBatchSize}`);
  if (!(evaluationConcurrency >= 1)) throw new Error(`createAutomationEngine: evaluationConcurrency must be >= 1, got ${evaluationConcurrency}`);
  // At least one whole second has to be left to send in, or no trigger could ever be delivered.
  if (!(deliveryMarginSec >= 0 && reportMaxAgeSec - deliveryMarginSec >= 1)) {
    throw new Error(`createAutomationEngine: deliveryMarginSec (${deliveryMarginSec}) must leave at least 1 s of reportMaxAgeSec (${reportMaxAgeSec})`);
  }

  /** key -> ms until which the key is not re-sent */
  const cooldownUntil = new Map();
  /** keys whose last multi-trigger batch reverted; sent one per tx until one succeeds */
  const isolated = new Set();
  const startedAt = now();
  let lastPriceOkAt = null;

  const coolingDown = (key, t) => (cooldownUntil.get(key) ?? -Infinity) > t;

  function pruneCooldowns(t) {
    for (const [key, until] of cooldownUntil) if (until <= t) cooldownUntil.delete(key);
  }

  function setStaleness(t) {
    metrics.oracleStalenessMs?.set(t - (lastPriceOkAt ?? startedAt));
  }

  /** Per-sweep memo so N positions on one pair cost one read. */
  function memo(fn) {
    const cache = new Map();
    return (...args) => {
      const k = args.map(String).join('|');
      if (!cache.has(k)) {
        const p = Promise.resolve().then(() => fn(...args));
        // A failed read must not poison later candidates' retries within the sweep.
        p.catch(() => cache.delete(k));
        cache.set(k, p);
      }
      return cache.get(k);
    };
  }

  async function sweep() {
    const t0 = now();
    pruneCooldowns(t0);
    // Prices the decisions (impact decay, backdating). It is never sent: see sendBatch.
    const tsSec = Math.floor(t0 / 1000);
    const sequencerState = sequencerMonitor.state;

    const { positions, limitOrders, limitOrdersAvailable = true } = await listCandidates();
    metrics.positionsTracked?.set(positions.length);
    metrics.limitOrdersTracked?.set(limitOrders.length);
    metrics.limitOrderTableAvailable?.set(limitOrdersAvailable ? 1 : 0);

    let snapshot;
    try {
      snapshot = await readPriceSnapshot();
      lastPriceOkAt = now();
    } catch (err) {
      setStaleness(now());
      metrics.sweepErrors?.inc(1, { stage: 'prices' });
      return { results: [], sent: [], error: `prices: ${err?.message ?? err}` };
    }
    setStaleness(now());

    const quoteFor = memo((pairIndex) => snapshot.quoteFor(pairIndex));
    const impactFor = memo(readImpact);
    const maxLevFor = memo(readMaxLeverage);
    const thresholdOnce = memo(readLiqMarginThresholdP);

    let belowMaintenance = 0;

    // Candidates are evaluated concurrently, so each writes into its own `out` and the
    // results and triggers are put back in candidate order afterwards: the same output and
    // the same batches whatever order the reads happened to finish in.
    const skip = (out, candidate, kind, reason, extra = {}) => {
      out.results.push({ candidate, kind, action: 'skipped', reason, ...extra });
      if (reason === 'degraded_liquidations_suppressed' || reason === 'degraded_opens_blocked') metrics.suppressedDegraded?.inc(1, { kind });
      if (reason === 'sequencer_stalled' || reason === 'sequencer_recovering') metrics.suppressedSequencer?.inc(1, { kind });
    };

    async function queueIfFree(out, candidate, kind, extra) {
      const { trader, pairIndex, index } = candidate;
      const key = triggerKey(trader, pairIndex, index, kind);
      if (coolingDown(key, t0)) return skip(out, candidate, kind, 'cooldown');
      if (await readTriggerPending(trader, pairIndex, index, LIMIT_ORDER_CODE[kind])) return skip(out, candidate, kind, 'pending_trigger');
      out.trigger = { key, kind, trader, pairIndex, index, limitOrder: LIMIT_ORDER_CODE[kind] };
      out.results.push({ candidate, kind, action: 'queued', ...extra });
    }

    async function evaluatePosition(out, p) {
      const { trader, pairIndex, index } = p;
      if (CLOSE_KINDS.every((k) => coolingDown(triggerKey(trader, pairIndex, index, k), t0))) return skip(out, p, null, 'cooldown');

      const trade = await readTrade(trader, pairIndex, index);
      if (!trade) {
        metrics.lostRace?.inc(1, { kind: 'close' });
        return skip(out, p, null, 'not_open');
      }
      const quote = await quoteFor(pairIndex);
      if (!isTradeableQuote(quote)) return skip(out, p, null, quote.untradeable ?? 'market_closed');

      const [maxLeverage, liqMarginThresholdP, impact] = await Promise.all([
        maxLevFor(pairIndex, trade.isDayTrade === true),
        thresholdOnce(),
        impactFor(pairIndex),
      ]);
      const r = evaluateCloseTriggers({
        trade,
        market: { ...quote, impact },
        maxLeverage,
        liqMarginThresholdP,
        blockTimestamp: BigInt(tsSec),
      });
      const detail = { tradeValue: r.tradeValue, liqMarginValue: r.liqMarginValue };
      if (r.liq) belowMaintenance++;

      const kind = r.liq ? TriggerKind.LIQ : r.sl ? TriggerKind.SL : r.tp ? TriggerKind.TP : null;
      if (!kind) return skip(out, p, null, 'not_hit', detail);

      const degraded = isDegraded(quote.healthyVenueCount, quote.minHealthyVenues);
      if (r.liq) {
        const liqGate = canTrigger({ kind: TriggerKind.LIQ, sequencerState, degraded, liquidateWhenDegraded });
        // SL/TP on a liquidatable trade execute as a liquidation; hold them to the LIQ gate.
        if (!liqGate.ok) return skip(out, p, TriggerKind.LIQ, liqGate.reason, detail);
      } else {
        const gate = canTrigger({ kind, sequencerState, degraded, liquidateWhenDegraded });
        if (!gate.ok) return skip(out, p, kind, gate.reason, detail);
      }

      // executeAutomationOrder's own early returns (OstiumTrading.sol:603-619).
      if (tsSec < trade.createdAt) return skip(out, p, kind, 'backdated', detail);
      if (kind === TriggerKind.SL && trade.slLastUpdated > tsSec) return skip(out, p, kind, 'backdated', detail);
      if (kind === TriggerKind.TP && trade.tpLastUpdated > tsSec) return skip(out, p, kind, 'backdated', detail);

      return queueIfFree(out, p, kind, detail);
    }

    async function evaluateLimitOrder(out, o) {
      const { trader, pairIndex, index } = o;
      if (coolingDown(triggerKey(trader, pairIndex, index, TriggerKind.OPEN), t0)) return skip(out, o, TriggerKind.OPEN, 'cooldown');

      // Gate before any chain read: a degraded market or a stalled chain rules out every
      // entry on it regardless of the order's details.
      const quote = await quoteFor(pairIndex);
      if (!isTradeableQuote(quote)) return skip(out, o, TriggerKind.OPEN, quote.untradeable ?? 'market_closed');
      const gate = canTrigger({
        kind: TriggerKind.OPEN,
        sequencerState,
        degraded: isDegraded(quote.healthyVenueCount, quote.minHealthyVenues),
      });
      if (!gate.ok) return skip(out, o, TriggerKind.OPEN, gate.reason);

      const order = await readLimitOrder(trader, pairIndex, index);
      if (!order) {
        metrics.lostRace?.inc(1, { kind: TriggerKind.OPEN });
        return skip(out, o, TriggerKind.OPEN, 'not_open');
      }
      const [fees, impact] = await Promise.all([readOpenFees(trader, pairIndex, index), impactFor(pairIndex)]);
      const r = evaluateOpenTrigger({ order, market: { ...quote, impact }, fees, blockTimestamp: BigInt(tsSec) });
      if (!r.hit) return skip(out, o, TriggerKind.OPEN, r.reason);
      if (order.lastUpdated > tsSec) return skip(out, o, TriggerKind.OPEN, 'backdated');

      return queueIfFree(out, o, TriggerKind.OPEN, { priceAfterImpact: r.priceAfterImpact });
    }

    const evaluations = [...positions.map((p) => [p, evaluatePosition]), ...limitOrders.map((o) => [o, evaluateLimitOrder])];
    const outs = await mapLimit(evaluations, evaluationConcurrency, async ([candidate, evaluate]) => {
      const out = { results: [], trigger: null };
      try {
        await evaluate(out, candidate);
      } catch (err) {
        out.results.push({ candidate, action: 'error', reason: err?.message ?? String(err) });
        out.trigger = null;
        metrics.candidateErrors?.inc();
      }
      return out;
    });

    // A key isolated for a slot the indexer no longer lists (closed, filled, cancelled)
    // would otherwise stay in the set for the life of the process.
    const listed = new Set([
      ...positions.flatMap((p) => CLOSE_KINDS.map((k) => triggerKey(p.trader, p.pairIndex, p.index, k))),
      ...limitOrders.map((o) => triggerKey(o.trader, o.pairIndex, o.index, TriggerKind.OPEN)),
    ]);
    for (const key of isolated) if (!listed.has(key)) isolated.delete(key);

    const results = [];
    const triggers = new Map(); // key -> trigger; the first listing of a slot wins
    for (const out of outs) {
      if (out.trigger && triggers.has(out.trigger.key)) continue;
      results.push(...out.results);
      if (out.trigger) triggers.set(out.trigger.key, out.trigger);
    }

    metrics.positionsBelowMaintenance?.set(belowMaintenance);
    const sent = await sendTriggers([...triggers.values()]);
    return { results, sent };
  }

  function toBatches(list) {
    const batches = [];
    const shared = [];
    for (const t of list) (isolated.has(t.key) ? batches.push([t]) : shared.push(t));
    for (let i = 0; i < shared.length; i += maxBatchSize) batches.push(shared.slice(i, i + maxBatchSize));
    return batches;
  }

  /**
   * Every batch is handed over at once; the pipelined sender orders their nonces and
   * broadcasts each without waiting for the previous receipt.
   */
  function sendTriggers(list) {
    return Promise.all(toBatches(list).map(sendBatch));
  }

  async function sendBatch(batch) {
    const trades = batch.map(({ trader, pairIndex, index, limitOrder }) => ({ trader, pairIndex, index, limitOrder }));
    // Taken at the moment of hand-over, so neither a slow sweep nor the batches ahead of
    // this one age it. The deadline is the last broadcast that still leaves the keeper
    // deliveryMarginSec to deliver before StaleReport.
    const timestamp = Math.floor(now() / 1000);
    const deadlineMs = (timestamp + reportMaxAgeSec - deliveryMarginSec) * 1000;
    let result;
    try {
      result = await sendPerformUpkeep({ trades, timestamp, deadlineMs });
    } catch (err) {
      result = { ok: false, reason: err?.message ?? String(err) };
    }
    // Expired while still queued: nothing reached the chain, so there is nothing to wait
    // out. The next sweep re-decides it with a fresh timestamp.
    const neverSent = !result.ok && result.expired === true && !(result.attempts > 0);
    // A shared batch that reverted: split it up and retry every key alone next sweep.
    const splitUp = !result.ok && batch.length > 1 && isRevert(result);
    const until = now() + cooldownMs;
    for (const t of batch) {
      if (neverSent) {
        metrics.triggersExpired?.inc(1, { kind: t.kind });
        continue;
      }
      metrics.triggersAttempted?.inc(1, { kind: t.kind });
      if (result.ok) {
        isolated.delete(t.key);
        metrics.triggersSent?.inc(1, { kind: t.kind });
      } else {
        metrics.triggersFailed?.inc(1, { kind: t.kind });
      }
      if (splitUp) isolated.add(t.key);
      else cooldownUntil.set(t.key, until);
    }
    metrics.batchesSent?.inc(1, { ok: String(result.ok) });
    return {
      keys: batch.map((t) => t.key),
      ok: result.ok,
      hash: result.hash,
      reason: result.reason,
      timestamp,
      ...(result.expired ? { expired: true } : {}),
    };
  }

  return {
    sweep,
    /** test/introspection hooks */
    isCoolingDown: (key) => coolingDown(key, now()),
    isIsolated: (key) => isolated.has(key),
  };
}
