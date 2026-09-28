/**
 * Persists the watcher's block cursor (the next block to scan) so a restart resumes where
 * the last process stopped instead of at the head — orders requested while the keeper was
 * down would otherwise never be filled, and their collateral would sit until the trader
 * reclaims it through the timeout path.
 *
 * Written atomically (temp file + rename): a crash mid-write leaves the previous cursor,
 * never a truncated one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {string|null} filePath null disables persistence (load() is always null)
 * @param {{ onCorrupt?: (err: Error) => void }} [opts]
 */
export function createCursorStore(filePath, { onCorrupt = () => {} } = {}) {
  return {
    filePath,
    /** @returns {bigint|null} */
    load() {
      if (!filePath || !existsSync(filePath)) return null;
      try {
        const { nextBlock } = JSON.parse(readFileSync(filePath, 'utf8'));
        if (typeof nextBlock !== 'string' || !/^\d+$/.test(nextBlock)) throw new Error(`bad nextBlock ${JSON.stringify(nextBlock)}`);
        return BigInt(nextBlock);
      } catch (err) {
        onCorrupt(err);
        return null;
      }
    },
    /** @param {bigint} nextBlock */
    save(nextBlock) {
      if (!filePath) return;
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ nextBlock: nextBlock.toString(), savedAt: Date.now() }));
      renameSync(tmp, filePath);
    },
  };
}
