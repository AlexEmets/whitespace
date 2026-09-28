/**
 * A dead-letter queue for liquidation triggers this instance could not deliver after
 * exhausting retries. Same shape and rationale as services/keeper/src/deadLetter.mjs
 * (not imported from there — services do not depend on each other in this workspace,
 * only on packages/*; this is a small, independent module for a different failure
 * domain: submission of a liquidation trigger, not delivery of a price report).
 *
 * A dead-lettered liquidation is NOT a stuck fund the way a dead-lettered keeper order
 * is — liquidation is permissionless (design spec §5.3): another party's liquidator, or
 * this instance's next sweep, can still pick it up. This queue exists purely for
 * operator visibility ("liquidator down -> alert", design spec §7), not for recovery
 * machinery.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath] if set, persisted as JSON after every add/remove
 */
export function createDeadLetterQueue({ filePath } = {}) {
  /** @type {{ trades: { trader: string, pairIndex: number, index: number, limitOrder: number }[], timestamp: number, reason: string, attempts: number, at: number }[]} */
  let items = [];

  if (filePath && existsSync(filePath)) {
    try {
      items = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      items = [];
    }
  }

  function persist() {
    if (filePath) writeFileSync(filePath, JSON.stringify(items, null, 2));
  }

  return {
    /** @param {{ trades: { trader: string, pairIndex: number, index: number, limitOrder: number }[], timestamp: number, reason: string, attempts: number }} entry */
    add(entry) {
      items.push({ ...entry, at: Date.now() });
      persist();
    },
    list() {
      return [...items];
    },
    size() {
      return items.length;
    },
    clear() {
      items = [];
      persist();
    },
  };
}
