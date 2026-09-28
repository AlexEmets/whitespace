/**
 * Degraded-mode gate for liquidations (task design point 4).
 *
 * The design spec (§5.2, §7) defines degraded mode at the publisher: below
 * MIN_HEALTHY_VENUES healthy venues, "closes allowed, opens blocked". That rule lives in
 * services/price-publisher/src/aggregator.mjs (`canSignForOrderType` /
 * `OPEN_ORDER_TYPES`) and, critically, treats a liquidation's price request the SAME as
 * any other close: a LIQ trigger asks OstiumTrading.executeAutomationOrder for
 * `OrderType.LIMIT_CLOSE` (never OPEN — see OstiumTrading.sol:624-631), which is NOT in
 * `OPEN_ORDER_TYPES`. So the publisher will happily sign a report for a liquidation
 * close even while degraded (fewer than 3 healthy venues) — that is correct for an
 * ordinary trader-initiated close (a trader must always be able to exit), but wrong for
 * a liquidation, which is *us* forcing a close on someone else's collateral based on a
 * price we already know is under-confirmed.
 *
 * Nothing else in the pipeline stops that: the contract has no venue-health awareness
 * at all, and the publisher's gate is (correctly, for its own purpose) close-permissive.
 * This module is therefore the ONE place that suppresses new liquidation submissions
 * while degraded. Decision: default to NOT liquidating (never liquidate on a suspect
 * price), even though liquidation is technically a "close". Already-in-flight triggers
 * (price already requested before degraded mode began) are not recalled here — the
 * contract's own callback still runs the real `tradeValue < liqMarginValue` check
 * against whatever report the publisher signs, so an in-flight trigger cannot force a
 * wrongful liquidation; it can only fail to trigger one that should have happened
 * (CancelReason.NOT_HIT), which is the safe direction to fail in.
 */

import { MIN_HEALTHY_VENUES } from '@whitespace/shared/bounds';

/**
 * @param {number} healthyVenueCount
 * @param {number} [minHealthyVenues]
 * @returns {boolean}
 */
export function isDegraded(healthyVenueCount, minHealthyVenues = MIN_HEALTHY_VENUES) {
  return healthyVenueCount < minHealthyVenues;
}

/**
 * Per-kind gate for the automation bot (docs/decisions/phase-6-liquidator.md §11).
 *
 *            sequencer STALLED   RECOVERING            degraded market
 *   LIQ      blocked             blocked (window)      blocked unless liquidateWhenDegraded
 *   SL, TP   blocked             allowed               allowed  (the trader's own close order;
 *                                                      the publisher signs LIMIT_CLOSE)
 *   OPEN     blocked             allowed               blocked  (the publisher refuses to
 *                                                      sign LIMIT_OPEN while degraded)
 *
 * STALLED blocks everything because nothing we send can land. The recovery window only
 * protects traders from being liquidated for a move they could not react to; it has no
 * reason to hold back an order the trader placed themselves.
 *
 * @param {object} p
 * @param {'LIQ'|'SL'|'TP'|'OPEN'} p.kind
 * @param {'LIVE'|'STALLED'|'RECOVERING'} p.sequencerState
 * @param {boolean} p.degraded
 * @param {boolean} [p.liquidateWhenDegraded]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canTrigger({ kind, sequencerState, degraded, liquidateWhenDegraded = false }) {
  if (sequencerState === 'STALLED') return { ok: false, reason: 'sequencer_stalled' };
  switch (kind) {
    case 'LIQ':
      if (sequencerState !== 'LIVE') return { ok: false, reason: 'sequencer_recovering' };
      if (degraded && !liquidateWhenDegraded) return { ok: false, reason: 'degraded_liquidations_suppressed' };
      return { ok: true };
    case 'SL':
    case 'TP':
      return { ok: true };
    case 'OPEN':
      if (degraded) return { ok: false, reason: 'degraded_opens_blocked' };
      return { ok: true };
    default:
      throw new Error(`canTrigger: unknown kind ${kind}`);
  }
}
