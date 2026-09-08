import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPositionTable } from '../src/positionTable.mjs';

const TRADER = '0x1111111111111111111111111111111111111111';

test('upsertFromOpen adds a new candidate slot', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n });
  assert.equal(table.size(), 1);
  assert.deepEqual(table.list(), [{ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n }]);
});

test('upsertFromOpen is keyed by (trader, pairIndex, index) case-insensitively on the address', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n });
  table.upsertFromOpen({ trader: TRADER.toUpperCase().replace('0X', '0x'), pairIndex: 0, index: 0, blockNumber: 200n });
  assert.equal(table.size(), 1, 'same slot, different address casing, must not double-count');
});

test('upsertFromOpen never regresses to an older block for the same slot (out-of-order delivery)', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 200n });
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n }); // arrives late, older
  assert.equal(table.list()[0].blockNumber, 200n);
});

test('remove drops a slot', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n });
  table.remove(TRADER, 0, 0);
  assert.equal(table.size(), 0);
});

test('different indexes for the same trader/pair are distinct slots', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n });
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 1, blockNumber: 100n });
  assert.equal(table.size(), 2);
});

test('pruneFromBlock drops candidates discovered at or after a reorg point, keeps earlier ones (chain reorg: must not act on orphaned state)', () => {
  const table = createPositionTable();
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 0, blockNumber: 100n }); // canonical, before the reorg
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 1, blockNumber: 250n }); // on the orphaned branch
  table.upsertFromOpen({ trader: TRADER, pairIndex: 0, index: 2, blockNumber: 300n }); // also orphaned

  table.pruneFromBlock(250n); // the reorg replaced everything from block 250 onward

  const remaining = table.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].index, 0);
});
