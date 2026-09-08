/**
 * Ties the pure aggregator + EMA to per-feed state and produces signed v2 reports.
 * No network I/O here — `ingestTick` is called by the venue WS layer in production and
 * directly by tests otherwise, so the whole signing pipeline is unit-testable without
 * a socket.
 */

import { computeIndex, canSignForOrderType } from './aggregator.mjs';
import { createMarkEma } from './ema.mjs';
import { buildReportDataV2, signAndEncodeReportV2 } from '@whitespace/reporter/report-v2';
import { getMarket } from '@whitespace/shared/markets';
import { weightOf } from '@whitespace/shared/venues';

/**
 * @param {object} opts
 * @param {number} opts.chainId
 * @param {`0x${string}`} opts.verifierAddress
 * @param {string[]} opts.markets feed names this engine tracks, e.g. ['BTC/USD','ETH/USD']
 * @param {import('@whitespace/shared/bounds').PUBLISHER_BOUNDS} opts.bounds
 * @param {{ address: `0x${string}`, privateKey: `0x${string}` }[]} opts.signerKeys
 * @param {number} opts.signatureThresholdK
 * @param {() => number} [opts.now]
 */
export function createPublisherEngine({
  chainId,
  verifierAddress,
  markets,
  bounds,
  signerKeys,
  signatureThresholdK,
  now = () => Date.now(),
}) {
  const state = new Map();
  for (const feed of markets) {
    state.set(feed, {
      ticks: new Map(),
      ema: createMarkEma({ windowMs: bounds.markEmaWindowMs, sampleIntervalMs: bounds.markEmaSampleIntervalMs }),
    });
  }

  function requireFeed(feed) {
    const s = state.get(feed);
    if (!s) throw new Error(`unknown feed "${feed}"`);
    return s;
  }

  /** @param {string} feed @param {{venue:string,bid:bigint,ask:bigint,ts:number}} tick */
  function ingestTick(feed, tick) {
    requireFeed(feed).ticks.set(tick.venue, tick);
  }

  /** @param {string} feed @param {number} [at] */
  function currentAggregate(feed, at = now()) {
    const s = requireFeed(feed);
    return computeIndex([...s.ticks.values()], at, bounds, weightOf);
  }

  /** Advances the mark EMA by one sample from the current index. Called on a fixed
   * timer in production (main.mjs); called directly with an explicit `at` in tests. */
  function sampleMark(feed, at = now()) {
    const s = requireFeed(feed);
    const aggregate = currentAggregate(feed, at);
    s.ema.update(aggregate.index);
    return { aggregate, mark: s.ema.value };
  }

  function markOf(feed) {
    return requireFeed(feed).ema.value;
  }

  /**
   * Builds and signs a v2 report for `feed`, at the caller-supplied `timestamp` (must
   * be byte-identical to the order's PriceRequestedV2 log — this function does not
   * default to Date.now() anywhere), gated on whether the current aggregate permits
   * signing for `orderTypeName`. Returns { ok: false, reason } instead of a report
   * when the gate fails — the do-not-sign path never has a signedReport in it.
   *
   * @param {string} feed
   * @param {number} timestamp uint32 seconds, from the order's log — verbatim
   * @param {string} orderTypeName e.g. 'MARKET_OPEN'
   * @param {{ isMarketOpen?: boolean, isDayTradingClosed?: boolean }} [opts]
   */
  async function signReportFor(feed, timestamp, orderTypeName, opts = {}) {
    const { isMarketOpen = true, isDayTradingClosed = false } = opts;
    const s = requireFeed(feed);
    const aggregate = currentAggregate(feed);

    const gate = canSignForOrderType(orderTypeName, aggregate);
    if (!gate.ok) return { ok: false, reason: gate.reason, aggregate };

    const mark = s.ema.value;
    if (mark === null) return { ok: false, reason: 'no_mark_yet', aggregate };

    if (signerKeys.length < signatureThresholdK) {
      return { ok: false, reason: 'insufficient_signer_keys', aggregate };
    }

    const market = getMarket(feed);
    const reportData = buildReportDataV2({
      chainId,
      verifier: verifierAddress,
      feedId: market.feedId,
      timestamp,
      price: mark,
      bid: aggregate.indexBid ?? mark,
      ask: aggregate.indexAsk ?? mark,
      isMarketOpen,
      isDayTradingClosed,
    });
    const { signedReport, signers } = await signAndEncodeReportV2(
      reportData,
      signerKeys.map((k) => k.privateKey),
    );
    return { ok: true, signedReport, signers, aggregate, mark, reportData };
  }

  function snapshot(feed) {
    const s = requireFeed(feed);
    return { feed, ticks: [...s.ticks.values()], mark: s.ema.value };
  }

  return {
    markets: [...state.keys()],
    ingestTick,
    currentAggregate,
    sampleMark,
    markOf,
    signReportFor,
    snapshot,
  };
}
