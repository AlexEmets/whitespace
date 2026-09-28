import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursorStore } from '../src/cursorStore.mjs';

function tempPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state', 'cursor.json');
}

test('load() is null before anything was saved', (t) => {
  assert.equal(createCursorStore(tempPath(t)).load(), null);
});

test('save() then load() round-trips across instances (a restart), creating the directory', (t) => {
  const path = tempPath(t);
  createCursorStore(path).save(7_437_314n);
  assert.equal(createCursorStore(path).load(), 7_437_314n);
  assert.equal(existsSync(`${path}.tmp`), false, 'the temp file was renamed into place');
});

test('a corrupt or malformed file loads as null and is reported, not thrown', (t) => {
  const path = tempPath(t);
  const store = createCursorStore(path);
  store.save(1n);
  const reported = [];
  for (const body of ['{"nextBlock":', '{"nextBlock":-5}', '{"nextBlock":"abc"}', '{}']) {
    writeFileSync(path, body);
    assert.equal(createCursorStore(path, { onCorrupt: (e) => reported.push(e) }).load(), null);
  }
  assert.equal(reported.length, 4);
});

test('a null path disables persistence', () => {
  const store = createCursorStore(null);
  store.save(5n);
  assert.equal(store.load(), null);
});
