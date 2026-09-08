/**
 * The liquidator's specific metric instruments, built on the shared, service-agnostic
 * registry in packages/metrics (not under services/liquidator, specifically so
 * services/keeper and services/price-publisher can depend on @whitespace/metrics too,
 * without depending on the liquidator — see packages/metrics/src/registry.mjs and
 * docs/decisions/phase-6-liquidator.md for the additive, not-yet-made integration those
 * two services would need).
 *
 * Covers every signal the task asked for: positions tracked, positions below
 * maintenance, liquidations attempted/won/lost, oracle staleness, sequencer state, RPC
 * health, dead-letter depth.
 */

import { createRegistry } from '@whitespace/metrics';
import { SequencerState } from './sequencerLiveness.mjs';

export function createLiquidatorMetrics() {
  const registry = createRegistry();

  const metrics = {
    positionsTracked: registry.gauge('liquidator_positions_tracked', 'Candidate positions currently in the position table'),
    positionsBelowMaintenance: registry.gauge('liquidator_positions_below_maintenance', 'Positions found below maintenance margin on the last sweep'),
    liquidationsAttempted: registry.counter('liquidator_liquidations_attempted_total', 'Liquidation triggers submitted by this instance'),
    liquidationsWon: registry.counter('liquidator_liquidations_won_total', 'Liquidation triggers this instance submitted successfully'),
    liquidationsLostRace: registry.counter('liquidator_liquidations_lost_race_total', 'Candidates found already closed, or whose submission failed, before/because another party liquidated first'),
    liquidationsSuppressedDegraded: registry.counter('liquidator_liquidations_suppressed_degraded_total', 'Liquidatable candidates skipped because the market was in degraded mode (< MIN_HEALTHY_VENUES)'),
    liquidationsSuppressedSequencer: registry.counter('liquidator_liquidations_suppressed_sequencer_total', 'Liquidatable candidates skipped because the sequencer was not LIVE (stalled or still in its recovery window)'),
    oracleStalenessMs: registry.gauge('liquidator_oracle_staleness_ms', 'Age of the last successfully read index/mark price, in milliseconds'),
    sequencerState: registry.gauge('liquidator_sequencer_state', 'Sequencer liveness state (0=LIVE, 1=STALLED, 2=RECOVERING)'),
    rpcHealthy: registry.gauge('liquidator_rpc_healthy', 'RPC endpoint health (1=last call succeeded, 0=failed)'),
    deadLetterDepth: registry.gauge('liquidator_dead_letter_depth', 'Entries currently in the liquidator dead-letter queue'),
  };

  const SEQUENCER_STATE_CODE = { [SequencerState.LIVE]: 0, [SequencerState.STALLED]: 1, [SequencerState.RECOVERING]: 2 };

  return {
    registry,
    ...metrics,
    /** @param {typeof SequencerState[keyof typeof SequencerState]} state */
    setSequencerState(state) {
      metrics.sequencerState.set(SEQUENCER_STATE_CODE[state] ?? -1);
    },
    /** @param {string} endpoint @param {boolean} healthy */
    setRpcHealth(endpoint, healthy) {
      metrics.rpcHealthy.set(healthy ? 1 : 0, { endpoint });
    },
    render() {
      return registry.render();
    },
  };
}
