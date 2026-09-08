/**
 * A dead-letter queue for orders the keeper could not deliver — "keeper tx reverts ->
 * gas bump, nonce management, dead-letter queue" (design spec §7). In-memory plus
 * optional file persistence so a restart doesn't silently forget a stuck order (the
 * trader's fallback is `openTradeMarketTimeout`, but a visible dead letter is how an
 * operator finds out *before* that timeout burns).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath] if set, persisted as JSON after every add/remove
 */
export function createDeadLetterQueue({ filePath } = {}) {
  /** @type {{ orderId: string, reason: string, attempts: number, at: number }[]} */
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
    /** @param {{ orderId: bigint|string, reason: string, attempts: number }} entry */
    add(entry) {
      items.push({ ...entry, orderId: String(entry.orderId), at: Date.now() });
      persist();
    },
    list() {
      return [...items];
    },
    size() {
      return items.length;
    },
    /** @param {string} orderId */
    remove(orderId) {
      items = items.filter((i) => i.orderId !== String(orderId));
      persist();
    },
    clear() {
      items = [];
      persist();
    },
  };
}
