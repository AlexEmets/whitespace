/**
 * Dead-letter store for transactions the sender gave up on.
 *
 * Persisted as JSON Lines, append-only: one `{"type":"dead",...}` line per failure and
 * one `{"type":"resolved","id":...}` line when a retry later lands it. Appending never
 * rewrites what is already on disk, so a crash mid-write loses at most the line being
 * written, never the history (a torn last line is skipped on load).
 *
 * Memory is bounded: only the newest `tailSize` unresolved entries are held. Older ones
 * stay on disk for an operator to read but are not retried automatically.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TAIL_SIZE = 100;

function toJsonLine(value) {
  return `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`;
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.filePath] JSONL file; null keeps the store in memory only
 * @param {number} [opts.tailSize] max unresolved entries held in memory
 * @param {() => number} [opts.now]
 */
export function createDeadLetterStore({ filePath = null, tailSize = DEFAULT_TAIL_SIZE, now = () => Date.now() } = {}) {
  if (!Number.isInteger(tailSize) || tailSize < 1) throw new Error(`createDeadLetterStore: tailSize must be a positive integer, got ${tailSize}`);

  /** Insertion-ordered, so the first key is always the oldest. */
  const tail = new Map();
  let total = 0;
  let skippedLines = 0;

  function remember(entry) {
    tail.set(entry.id, entry);
    while (tail.size > tailSize) tail.delete(tail.keys().next().value);
  }

  if (filePath && existsSync(filePath)) {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (record?.type === 'dead' && typeof record.id === 'string') {
        total += 1;
        remember(record);
      } else if (record?.type === 'resolved') {
        tail.delete(record.id);
      } else {
        skippedLines += 1;
      }
    }
  }

  function append(record) {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, toJsonLine(record));
  }

  return {
    filePath,
    tailSize,
    /** Lines in the file that could not be parsed on load (a torn write, a hand edit). */
    get skippedLines() {
      return skippedLines;
    },
    /** Every entry ever dead-lettered, including ones since resolved or evicted. */
    get total() {
      return total;
    },
    /**
     * @param {object} entry any JSON-able payload; bigints are written as strings
     * @returns {object} the stored entry, with `id`, `type` and `at` added
     */
    add(entry) {
      const record = { ...entry, type: 'dead', id: randomUUID(), at: now() };
      // Normalise through JSON so the in-memory copy matches what a restart reads back.
      const stored = JSON.parse(toJsonLine(record));
      append(stored);
      total += 1;
      remember(stored);
      return stored;
    },
    /** Marks an entry as delivered after all; it leaves the tail and stays resolved across restarts. */
    resolve(id) {
      if (!tail.has(id)) return false;
      tail.delete(id);
      append({ type: 'resolved', id, at: now() });
      return true;
    },
    /** Unresolved entries in memory, oldest first. */
    list() {
      return [...tail.values()];
    },
    size() {
      return tail.size;
    },
  };
}
