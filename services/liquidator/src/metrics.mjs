/**
 * The automation bot's metric instruments, built on the shared, service-agnostic
 * registry in packages/metrics. Metric names keep the `liquidator_` prefix: the service
 * directory and every dashboard already know it by that name.
 *
 * Labels: `kind` is LIQ | SL | TP | OPEN (or `close` for a vanished trade);
 * `endpoint` is an RPC scheme+host (never a full URL — see rpc.endpointLabel).
 */

import { createRegistry } from '@whitespace/metrics';
import { SequencerState } from './sequencerLiveness.mjs';

export function createLiquidatorMetrics() {
  const registry = createRegistry();

  const metrics = {
    positionsTracked: registry.gauge('liquidator_positions_tracked', 'Open positions read from the indexer on the last sweep'),
    limitOrdersTracked: registry.gauge('liquidator_limit_orders_tracked', 'Open LIMIT/STOP entries read from the indexer on the last sweep'),
    limitOrderTableAvailable: registry.gauge('liquidator_limit_order_table_available', '1 if the indexer has the limit_order table, 0 if entries cannot be automated yet'),
    positionsBelowMaintenance: registry.gauge('liquidator_positions_below_maintenance', 'Positions found below maintenance margin on the last sweep'),
    triggersAttempted: registry.counter('liquidator_triggers_attempted_total', 'Triggers this instance put into a performUpkeep transaction'),
    triggersSent: registry.counter('liquidator_triggers_sent_total', 'Triggers whose performUpkeep transaction was mined successfully'),
    triggersFailed: registry.counter('liquidator_triggers_failed_total', 'Triggers whose performUpkeep transaction failed or reverted'),
    batchesSent: registry.counter('liquidator_batches_total', 'performUpkeep transactions sent, by outcome'),
    lostRace: registry.counter('liquidator_lost_race_total', 'Candidates found already closed/filled on chain when re-read'),
    suppressedDegraded: registry.counter('liquidator_suppressed_degraded_total', 'Hit triggers held back because the market was degraded'),
    suppressedSequencer: registry.counter('liquidator_suppressed_sequencer_total', 'Hit triggers held back because the sequencer was stalled or recovering'),
    candidateErrors: registry.counter('liquidator_candidate_errors_total', 'Candidates skipped for one sweep because a read failed'),
    sweepErrors: registry.counter('liquidator_sweep_errors_total', 'Sweeps that could not evaluate anything, by stage'),
    oracleStalenessMs: registry.gauge('liquidator_oracle_staleness_ms', 'Age of the last successful publisher price snapshot, in milliseconds'),
    sequencerState: registry.gauge('liquidator_sequencer_state', 'Sequencer liveness state (0=LIVE, 1=STALLED, 2=RECOVERING)'),
    rpcHealthy: registry.gauge('liquidator_rpc_healthy', 'RPC endpoint health (1=last probe succeeded, 0=failed)'),
    deadLetterDepth: registry.gauge('liquidator_dead_letter_depth', 'Entries currently in the dead-letter queue'),
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
