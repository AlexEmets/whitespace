/**
 * Orchestrates one liquidation-candidate evaluation cycle. This is the seam between the
 * pure decision logic (marginEngine.mjs, sequencerLiveness.mjs, degradedMode.mjs) and
 * the outside world: every dependency that touches the chain or the publisher is
 * injected as a function, so the whole decision path is unit-testable with plain mock
 * functions and zero network (see test/liquidatorEngine.test.mjs).
 *
 * Decision order for one candidate:
 *   1. Sequencer must be LIVE (not stalled, not still inside its recovery window).
 *   2. Market must not be degraded (>= MIN_HEALTHY_VENUES healthy venues).
 *   3. Re-read the live trade. leverage === 0n means the slot is not actually open —
 *      either it never really opened (a reorg'd discovery log) or someone else already
 *      closed/liquidated it since this candidate was queued. Both cases are handled
 *      identically: skip cleanly, count it as a lost race if we had reason to think it
 *      was liquidatable, and do not touch chain state.
 *   4. Reconstruct tradeValue and liqMarginValue EXACTLY — see marginEngine.mjs's file
 *      header note 0 for why this is done via the exact fee-accrual view calls and
 *      isLiquidatable (tradeValue < liqMarginValue), not via getTradeLiquidationPrice.
 *   5. If liquidatable, submit. A submission failure (revert, RPC error, or the
 *      contract's own NOT_HIT rejection surfacing later) is recorded, never thrown —
 *      losing a liquidation race is the expected, permissionless-by-design outcome
 *      (design spec §5.3), not an error condition.
 */

import { getTradeLiquidationMargin, currentPercentProfit, getTradeValuePure, isLiquidatable } from './marginEngine.mjs';
import { canSubmitLiquidation } from './degradedMode.mjs';

/**
 * @param {object} deps
 * @param {(trader: `0x${string}`, pairIndex: number, index: number) => Promise<{
 *   collateral: bigint, leverage: bigint, openPrice: bigint, buy: boolean,
 *   initialLeverage: bigint, rolloverFee: bigint, fundingFee: bigint, isDayTrade: boolean,
 * } | null>} deps.readTrade Live trade + exact fee snapshot. Must return
 *   `leverage: 0n` (or null) for a slot that is not currently open.
 * @param {(pairIndex: number, isDayTrade: boolean) => Promise<bigint>} deps.readMaxLeverage
 * @param {() => Promise<bigint>} deps.readLiqMarginThresholdP
 * @param {(pairIndex: number) => Promise<bigint>} deps.readIndexPrice trusted index/mark price, same basis the report will carry
 * @param {(pairIndex: number) => Promise<{ healthyVenueCount: number, minHealthyVenues: number }>} deps.readVenueHealth
 * @param {{ canLiquidate: () => boolean }} deps.sequencerMonitor
 * @param {(candidate: { trader: `0x${string}`, pairIndex: number, index: number }) => Promise<{ ok: boolean, reason?: string, hash?: string }>} deps.submitLiquidation
 * @param {{
 *   positionsTracked?: { set: Function },
 *   positionsBelowMaintenance?: { set: Function },
 *   liquidationsAttempted?: { inc: Function },
 *   liquidationsWon?: { inc: Function },
 *   liquidationsLostRace?: { inc: Function },
 *   liquidationsSuppressedDegraded?: { inc: Function },
 *   liquidationsSuppressedSequencer?: { inc: Function },
 * }} [deps.metrics]
 */
export function createLiquidatorEngine({
  readTrade,
  readMaxLeverage,
  readLiqMarginThresholdP,
  readIndexPrice,
  readVenueHealth,
  sequencerMonitor,
  submitLiquidation,
  metrics = {},
}) {
  /**
   * @param {{ trader: `0x${string}`, pairIndex: number, index: number }} candidate
   */
  async function evaluateOne(candidate) {
    const { trader, pairIndex, index } = candidate;

    if (!sequencerMonitor.canLiquidate()) {
      metrics.liquidationsSuppressedSequencer?.inc();
      return { candidate, action: 'skipped', reason: 'sequencer_not_live' };
    }

    // The threshold travels with the count: this pair's minimum, as the publisher applied
    // it, not this service's global constant. A market fed by fewer sources by design would
    // otherwise read as permanently degraded here and never be liquidated at all.
    const { healthyVenueCount, minHealthyVenues } = await readVenueHealth(pairIndex);
    const gate = canSubmitLiquidation({ healthyVenueCount, minHealthyVenues });
    if (!gate.ok) {
      metrics.liquidationsSuppressedDegraded?.inc();
      return { candidate, action: 'skipped', reason: gate.reason };
    }

    const trade = await readTrade(trader, pairIndex, index);
    if (!trade || trade.leverage === 0n) {
      // Not open: either it never really was (an orphaned discovery log) or another
      // party already closed/liquidated it. Either way, nothing to corrupt: we never
      // called submitLiquidation, and the candidate simply drops out on the next sweep.
      metrics.liquidationsLostRace?.inc();
      return { candidate, action: 'skipped', reason: 'not_open' };
    }

    const [maxLeverage, liqMarginThresholdP, currentPrice] = await Promise.all([
      readMaxLeverage(pairIndex, trade.isDayTrade === true),
      readLiqMarginThresholdP(),
      readIndexPrice(pairIndex),
    ]);

    const liqMarginValue = getTradeLiquidationMargin({
      collateral: trade.collateral,
      leverage: trade.leverage,
      maxLeverage,
      liqMarginThresholdP,
    });
    const { p: percentProfit } = currentPercentProfit({
      openPrice: trade.openPrice,
      currentPrice,
      buy: trade.buy,
      leverage: trade.leverage,
      initialLeverage: trade.initialLeverage,
    });
    const tradeValue = getTradeValuePure({
      collateral: trade.collateral,
      percentProfit,
      rolloverFee: trade.rolloverFee,
      fundingFee: trade.fundingFee,
    });

    if (!isLiquidatable(tradeValue, liqMarginValue)) {
      return { candidate, action: 'skipped', reason: 'above_maintenance', tradeValue, liqMarginValue };
    }

    metrics.liquidationsAttempted?.inc();
    const result = await submitLiquidation(candidate);
    if (result.ok) {
      metrics.liquidationsWon?.inc();
      return { candidate, action: 'submitted', tradeValue, liqMarginValue, hash: result.hash };
    }
    metrics.liquidationsLostRace?.inc();
    return { candidate, action: 'failed', reason: result.reason, tradeValue, liqMarginValue };
  }

  /**
   * @param {{ trader: `0x${string}`, pairIndex: number, index: number }[]} candidates
   */
  async function evaluateAll(candidates) {
    metrics.positionsTracked?.set(candidates.length);
    const results = [];
    for (const candidate of candidates) {
      // One bad read (a reverting view, a publisher hiccup for one feed) must cost that
      // candidate this sweep, not every candidate after it.
      try {
        results.push(await evaluateOne(candidate));
      } catch (err) {
        results.push({ candidate, action: 'error', reason: err?.message ?? String(err) });
      }
    }
    const belowMaintenance = results.filter((r) => r.action === 'submitted' || r.action === 'failed').length;
    metrics.positionsBelowMaintenance?.set(belowMaintenance);
    return results;
  }

  return { evaluateOne, evaluateAll };
}
