import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_LOOKBACK_BLOCKS, loadConfig } from '../src/config.mjs';

const BASE = { KEEPER_PRICE_UPKEEP_ADDRESS: '0x6d8fa4DE0DD0aF71F044266aA630B560733efC96', HOME: '/home/x' };

test('cursor persistence is off and the lookback is the default when unset', () => {
  const config = loadConfig({ ...BASE });
  assert.equal(config.cursorPath, null);
  assert.equal(config.maxLookbackBlocks, DEFAULT_MAX_LOOKBACK_BLOCKS);
});

test('KEEPER_CURSOR_PATH and KEEPER_MAX_LOOKBACK_BLOCKS are read', () => {
  const config = loadConfig({ ...BASE, KEEPER_CURSOR_PATH: '/var/lib/k/cursor.json', KEEPER_MAX_LOOKBACK_BLOCKS: '50' });
  assert.equal(config.cursorPath, '/var/lib/k/cursor.json');
  assert.equal(config.maxLookbackBlocks, 50);
});
