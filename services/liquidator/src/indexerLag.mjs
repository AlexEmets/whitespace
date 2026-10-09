/**
 * How far the indexer is behind the chain.
 *
 * Candidates come from the indexer database (candidateSource.mjs). Every slot is re-read
 * from chain before a trigger, so a lagging indexer never causes a WRONG trigger — but it
 * silently causes MISSING ones: a position opened after the indexer's last block is not a
 * candidate at all, and cannot be liquidated until the indexer catches up. Nothing showed
 * that. This compares the indexer's `sync_status` heartbeat with the chain head the
 * liveness watcher saw, publishes the lag in blocks and seconds, and warns when it passes
 * a bound (and again when it is back under it).
 *
 * Seconds are measured on the chain's own clock (head timestamp - indexed block
 * timestamp) when the head is known, so host clock skew does not show up as lag.
 */

/** Same bound as the API's /health "degraded" (services/api/src/routes/health.ts). */
export const DEFAULT_MAX_INDEXER_LAG_SEC = 30;

/**
 * @param {object} opts
 * @param {() => Promise<{ blockNumber: bigint, blockTimestamp: number } | null>} opts.readSyncStatus
 * @param {() => ({ number: bigint, timestamp: bigint } | null)} opts.latestHead
 * @param {{ indexerLagBlocks?: { set(v: number): void }, indexerLagSeconds?: { set(v: number): void } }} [opts.metrics]
 * @param {(msg: string) => void} [opts.warn]
 * @param {(msg: string) => void} [opts.info]
 * @param {number} [opts.maxLagSec]
 * @param {() => number} [opts.now] ms
 */
export function createIndexerLagCheck({ readSyncStatus, latestHead, metrics = {}, warn = () => {}, info = () => {}, maxLagSec = DEFAULT_MAX_INDEXER_LAG_SEC, now = Date.now }) {
  let lagging = false;
  let warnedNoStatus = false;

  /** @returns {Promise<{ lagBlocks: number|null, lagSeconds: number, lagging: boolean } | null>} */
  async function check() {
    const status = await readSyncStatus();
    if (!status) {
      if (!warnedNoStatus) warn('indexer has no sync_status row: its lag cannot be measured');
      warnedNoStatus = true;
      return null;
    }
    warnedNoStatus = false;
    const head = latestHead();
    const lagBlocks = head ? Math.max(0, Number(head.number - status.blockNumber)) : null;
    const clockSec = head ? Number(head.timestamp) : Math.floor(now() / 1000);
    const lagSeconds = Math.max(0, clockSec - status.blockTimestamp);

    if (lagBlocks !== null) metrics.indexerLagBlocks?.set(lagBlocks);
    metrics.indexerLagSeconds?.set(lagSeconds);

    const nowLagging = lagSeconds > maxLagSec;
    if (nowLagging && !lagging) {
      warn(`indexer is ${lagSeconds}s${lagBlocks !== null ? ` / ${lagBlocks} blocks` : ''} behind the chain (bound ${maxLagSec}s): positions opened since are not candidates yet`);
    } else if (!nowLagging && lagging) {
      info(`indexer caught up (${lagSeconds}s behind)`);
    }
    lagging = nowLagging;
    return { lagBlocks, lagSeconds, lagging };
  }

  return { check };
}
