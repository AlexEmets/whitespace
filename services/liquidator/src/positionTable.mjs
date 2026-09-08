/**
 * Candidate position table: which (trader, pairIndex, index) slots are worth polling
 * for a live margin check.
 *
 * services/indexer (design spec §4.1's "position table from the indexer", §5.3) does
 * not exist yet in this repo (phase 4 is still in progress alongside this phase, per
 * docs/superpowers/plans/2026-09-08-phases-2-7-full-product.md's phase table) — there is
 * nothing to read a position table from. This module is the liquidator's own stand-in:
 * a log-based candidate discovery (matching design spec §2.4's constraint that the
 * public RPC has no `debug_traceTransaction`/`trace_block`, so all indexing here must be
 * log-based) that a real indexer/API can later replace by feeding this same
 * upsertFromOpen/remove interface, or by being queried directly instead.
 *
 * Deliberately NOT the source of truth for whether a position is still open or what its
 * live collateral/leverage are — that would require either replaying every fee-relevant
 * event correctly (fragile) or accepting staleness between polls (dangerous for
 * liquidation, where stale-favorable-to-the-trader is safe but stale-favorable-to-us is
 * not). Instead this table only tracks WHICH slots to ask the chain about;
 * services/liquidator/src/chainReader.mjs re-reads each candidate's live Trade struct
 * from the contract immediately before any margin decision. That re-read is also what
 * makes this table reorg-safe by construction: a candidate discovered from a log that
 * later turns out to be on an orphaned fork simply reads back `leverage === 0` (an empty
 * slot) on the next live poll and is quietly dropped — it can never cause a wrongful
 * liquidation, only a wasted poll. `pruneFromBlock` additionally drops candidates
 * discovered at or after a detected reorg point proactively, so a long-orphaned branch
 * doesn't linger in the poll set forever.
 */

function keyOf(trader, pairIndex, index) {
  return `${trader.toLowerCase()}:${pairIndex}:${index}`;
}

export function createPositionTable() {
  /** @type {Map<string, { trader: `0x${string}`, pairIndex: number, index: number, blockNumber: bigint }>} */
  const positions = new Map();

  /**
   * Records (or refreshes) a candidate slot discovered from a MarketOpenExecuted /
   * LimitOpenExecuted log. Ignores an event whose block is older than one already
   * recorded for the same slot (out-of-order delivery must never regress a newer
   * observation).
   * @param {{ trader: `0x${string}`, pairIndex: number, index: number, blockNumber: bigint }} event
   */
  function upsertFromOpen(event) {
    const key = keyOf(event.trader, event.pairIndex, event.index);
    const existing = positions.get(key);
    if (existing && existing.blockNumber > event.blockNumber) return;
    positions.set(key, { trader: event.trader, pairIndex: event.pairIndex, index: event.index, blockNumber: event.blockNumber });
  }

  /** @param {`0x${string}`} trader @param {number} pairIndex @param {number} index */
  function remove(trader, pairIndex, index) {
    positions.delete(keyOf(trader, pairIndex, index));
  }

  function list() {
    return [...positions.values()];
  }

  function size() {
    return positions.size;
  }

  /**
   * Drops every candidate discovered at or after `reorgBlockNumber` — the state that
   * introduced them may no longer be canonical. Never itself a source of a wrongful
   * liquidation (see file header): the live re-read before any decision is the actual
   * safety property; this is defense in depth that also keeps the poll set from
   * accumulating orphaned entries indefinitely.
   * @param {bigint} reorgBlockNumber
   */
  function pruneFromBlock(reorgBlockNumber) {
    for (const [key, pos] of positions) {
      if (pos.blockNumber >= reorgBlockNumber) positions.delete(key);
    }
  }

  return { upsertFromOpen, remove, list, size, pruneFromBlock };
}
