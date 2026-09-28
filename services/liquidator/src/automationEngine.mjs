/**
 * The automation bot's sweep: every open trade and every resting LIMIT/STOP entry from
 * the indexer, re-read from chain, decided with the contract's own trigger rules, gated
 * per kind, deduped, cooled down, and sent as batched performUpkeep calls.
 *
 * One sweep:
 *   1. Candidates from the indexer DB (positions + limit orders). A DB failure fails the
 *      sweep — acting on a partial view would silently skip positions.
 *   2. One publisher /status snapshot (the prices a report would carry right now).
 *   3. Per candidate, isolated (one failing read costs that candidate, not the sweep):
 *        - skip if every kind it could fire is cooling down (saves the chain reads);
 *        - re-read the slot from chain; gone -> skip (lost race / indexer lag / reorg);
 *        - decide with triggerRules.mjs on the chain values, never the DB values;
 *        - gate with degradedMode.canTrigger;
 *        - skip if the timestamp would be BACKDATED_EXECUTION / NO_TP / NO_SL
 *          (OstiumTrading.sol:585-619) or a trigger is already pending on chain
 *          (PENDING_TRIGGER, :621-623).
 *   4. Dedupe by (trader, pair, index, kind), chunk into batches of <= maxBatchSize,
 *      send sequentially through the injected sendPerformUpkeep.
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
 * revert of one entry reverts the whole batch. When a multi-trigger batch fails, its
 * keys are marked isolated and go out one per transaction next time, so one poisoned
 * trigger cannot hold every other trigger hostage.
 */

import { LimitOrder } from './abi.mjs';
import { canTrigger, isDegraded } from './degradedMode.mjs';
import { evaluateCloseTriggers, evaluateOpenTrigger, isTradeableQuote, TriggerKind } from './triggerRules.mjs';

export const DEFAULT_MAX_BATCH_SIZE = 20;
/** triggerTimeout is 30 blocks at ~1 s/block; a NOT_HIT is not retried sooner than that. */
export const DEFAULT_COOLDOWN_MS = 30_000;

const LIMIT_ORDER_CODE = { TP: LimitOrder.TP, SL: LimitOrder.SL, LIQ: LimitOrder.LIQ, OPEN: LimitOrder.OPEN };
const CLOSE_KINDS = [TriggerKind.LIQ, TriggerKind.SL, TriggerKind.TP];

export function triggerKey(trader, pairIndex, index, kind) {
  return `${String(trader).toLowerCase()}-${pairIndex}-${index}-${kind}`;
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
 * @param {(payload: { trades: object[], timestamp: number }) => Promise<{ ok: boolean, hash?: string, reason?: string }>} deps.sendPerformUpkeep
 * @param {() => number} [deps.now] ms
 * @param {number} [deps.maxBatchSize]
 * @param {number} [deps.cooldownMs]
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
  liquidateWhenDegraded = false,
  metrics = {},
}) {
  if (!(maxBatchSize >= 1)) throw new Error(`createAutomationEngine: maxBatchSize must be >= 1, got ${maxBatchSize}`);

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

    const results = [];
    const triggers = new Map(); // key -> trigger
    let belowMaintenance = 0;

    const skip = (candidate, kind, reason, extra = {}) => {
      results.push({ candidate, kind, action: 'skipped', reason, ...extra });
      if (reason === 'degraded_liquidations_suppressed' || reason === 'degraded_opens_blocked') metrics.suppressedDegraded?.inc(1, { kind });
      if (reason === 'sequencer_stalled' || reason === 'sequencer_recovering') metrics.suppressedSequencer?.inc(1, { kind });
    };

    async function queueIfFree(candidate, kind, extra) {
      const { trader, pairIndex, index } = candidate;
      const key = triggerKey(trader, pairIndex, index, kind);
      if (triggers.has(key)) return;
      if (coolingDown(key, t0)) return skip(candidate, kind, 'cooldown');
      if (await readTriggerPending(trader, pairIndex, index, LIMIT_ORDER_CODE[kind])) return skip(candidate, kind, 'pending_trigger');
      triggers.set(key, { key, kind, trader, pairIndex, index, limitOrder: LIMIT_ORDER_CODE[kind] });
      results.push({ candidate, kind, action: 'queued', ...extra });
    }

    async function evaluatePosition(p) {
      const { trader, pairIndex, index } = p;
      if (CLOSE_KINDS.every((k) => coolingDown(triggerKey(trader, pairIndex, index, k), t0))) return skip(p, null, 'cooldown');

      const trade = await readTrade(trader, pairIndex, index);
      if (!trade) {
        metrics.lostRace?.inc(1, { kind: 'close' });
        return skip(p, null, 'not_open');
      }
      const quote = await quoteFor(pairIndex);
      if (!isTradeableQuote(quote)) return skip(p, null, 'market_closed');

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
      if (!kind) return skip(p, null, 'not_hit', detail);

      const degraded = isDegraded(quote.healthyVenueCount, quote.minHealthyVenues);
      if (r.liq) {
        const liqGate = canTrigger({ kind: TriggerKind.LIQ, sequencerState, degraded, liquidateWhenDegraded });
        // SL/TP on a liquidatable trade execute as a liquidation; hold them to the LIQ gate.
        if (!liqGate.ok) return skip(p, TriggerKind.LIQ, liqGate.reason, detail);
      } else {
        const gate = canTrigger({ kind, sequencerState, degraded, liquidateWhenDegraded });
        if (!gate.ok) return skip(p, kind, gate.reason, detail);
      }

      // executeAutomationOrder's own early returns (OstiumTrading.sol:603-619).
      if (tsSec < trade.createdAt) return skip(p, kind, 'backdated', detail);
      if (kind === TriggerKind.SL && trade.slLastUpdated > tsSec) return skip(p, kind, 'backdated', detail);
      if (kind === TriggerKind.TP && trade.tpLastUpdated > tsSec) return skip(p, kind, 'backdated', detail);

      return queueIfFree(p, kind, detail);
    }

    async function evaluateLimitOrder(o) {
      const { trader, pairIndex, index } = o;
      if (coolingDown(triggerKey(trader, pairIndex, index, TriggerKind.OPEN), t0)) return skip(o, TriggerKind.OPEN, 'cooldown');

      // Gate before any chain read: a degraded market or a stalled chain rules out every
      // entry on it regardless of the order's details.
      const quote = await quoteFor(pairIndex);
      if (!isTradeableQuote(quote)) return skip(o, TriggerKind.OPEN, 'market_closed');
      const gate = canTrigger({
        kind: TriggerKind.OPEN,
        sequencerState,
        degraded: isDegraded(quote.healthyVenueCount, quote.minHealthyVenues),
      });
      if (!gate.ok) return skip(o, TriggerKind.OPEN, gate.reason);

      const order = await readLimitOrder(trader, pairIndex, index);
      if (!order) {
        metrics.lostRace?.inc(1, { kind: TriggerKind.OPEN });
        return skip(o, TriggerKind.OPEN, 'not_open');
      }
      const [fees, impact] = await Promise.all([readOpenFees(trader, pairIndex, index), impactFor(pairIndex)]);
      const r = evaluateOpenTrigger({ order, market: { ...quote, impact }, fees, blockTimestamp: BigInt(tsSec) });
      if (!r.hit) return skip(o, TriggerKind.OPEN, r.reason);
      if (order.lastUpdated > tsSec) return skip(o, TriggerKind.OPEN, 'backdated');

      return queueIfFree(o, TriggerKind.OPEN, { priceAfterImpact: r.priceAfterImpact });
    }

    const evaluations = [
      ...positions.map((p) => () => evaluatePosition(p)),
      ...limitOrders.map((o) => () => evaluateLimitOrder(o)),
    ];
    const candidates = [...positions, ...limitOrders];
    for (let i = 0; i < evaluations.length; i++) {
      try {
        await evaluations[i]();
      } catch (err) {
        results.push({ candidate: candidates[i], action: 'error', reason: err?.message ?? String(err) });
        metrics.candidateErrors?.inc();
      }
    }

    metrics.positionsBelowMaintenance?.set(belowMaintenance);
    const sent = await sendTriggers([...triggers.values()], tsSec);
    return { results, sent };
  }

  function toBatches(list) {
    const batches = [];
    const shared = [];
    for (const t of list) (isolated.has(t.key) ? batches.push([t]) : shared.push(t));
    for (let i = 0; i < shared.length; i += maxBatchSize) batches.push(shared.slice(i, i + maxBatchSize));
    return batches;
  }

  async function sendTriggers(list, timestamp) {
    const outcomes = [];
    for (const batch of toBatches(list)) {
      const trades = batch.map(({ trader, pairIndex, index, limitOrder }) => ({ trader, pairIndex, index, limitOrder }));
      let result;
      try {
        result = await sendPerformUpkeep({ trades, timestamp });
      } catch (err) {
        result = { ok: false, reason: err?.message ?? String(err) };
      }
      const until = now() + cooldownMs;
      for (const t of batch) {
        cooldownUntil.set(t.key, until);
        metrics.triggersAttempted?.inc(1, { kind: t.kind });
        if (result.ok) {
          isolated.delete(t.key);
          metrics.triggersSent?.inc(1, { kind: t.kind });
        } else {
          metrics.triggersFailed?.inc(1, { kind: t.kind });
          if (batch.length > 1) isolated.add(t.key);
        }
      }
      metrics.batchesSent?.inc(1, { ok: String(result.ok) });
      outcomes.push({ keys: batch.map((t) => t.key), ok: result.ok, hash: result.hash, reason: result.reason });
    }
    return outcomes;
  }

  return {
    sweep,
    /** test/introspection hooks */
    isCoolingDown: (key) => coolingDown(key, now()),
    isIsolated: (key) => isolated.has(key),
  };
}
