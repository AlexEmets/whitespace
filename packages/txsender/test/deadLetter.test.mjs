import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeadLetterStore } from '../src/deadLetter.mjs';

function tempPath(t, name = 'dead-letters.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'txsender-dlq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function lines(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('add() stamps id/type/at and returns the stored entry', () => {
  const store = createDeadLetterStore({ now: () => 1234 });
  const entry = store.add({ key: 'order-1', reason: 'reverted' });
  assert.equal(entry.type, 'dead');
  assert.equal(entry.at, 1234);
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(store.list(), [entry]);
  assert.equal(store.size(), 1);
  assert.equal(store.total, 1);
});

test('bigints are stored as decimal strings, in memory and on disk alike', (t) => {
  const filePath = tempPath(t);
  const store = createDeadLetterStore({ filePath });
  const entry = store.add({ request: { value: 10n ** 20n } });
  assert.equal(entry.request.value, '100000000000000000000');
  assert.equal(lines(filePath)[0].request.value, '100000000000000000000');
});

test('the file is JSON Lines and append-only: one line per add, one per resolve', (t) => {
  const filePath = tempPath(t);
  const store = createDeadLetterStore({ filePath });
  const a = store.add({ key: 'a' });
  store.add({ key: 'b' });
  assert.equal(store.resolve(a.id), true);
  const onDisk = lines(filePath);
  assert.deepEqual(onDisk.map((l) => l.type), ['dead', 'dead', 'resolved']);
  assert.equal(onDisk[2].id, a.id);
});

test('a restart reloads unresolved entries and drops resolved ones', (t) => {
  const filePath = tempPath(t);
  const first = createDeadLetterStore({ filePath });
  const a = first.add({ key: 'a' });
  first.add({ key: 'b' });
  first.resolve(a.id);

  const second = createDeadLetterStore({ filePath });
  assert.deepEqual(second.list().map((e) => e.key), ['b']);
  assert.equal(second.total, 2);
});

test('memory is bounded to tailSize newest entries; the file keeps everything', (t) => {
  const filePath = tempPath(t);
  const store = createDeadLetterStore({ filePath, tailSize: 3 });
  for (let i = 0; i < 5; i++) store.add({ key: `k${i}` });
  assert.deepEqual(store.list().map((e) => e.key), ['k2', 'k3', 'k4']);
  assert.equal(store.total, 5);
  assert.equal(lines(filePath).length, 5);

  const reloaded = createDeadLetterStore({ filePath, tailSize: 3 });
  assert.deepEqual(reloaded.list().map((e) => e.key), ['k2', 'k3', 'k4']);
});

test('a torn or foreign line is skipped on load instead of losing the whole file', (t) => {
  const filePath = tempPath(t);
  const store = createDeadLetterStore({ filePath });
  store.add({ key: 'ok' });
  appendFileSync(filePath, '{"type":"dead","id":"x"'); // crashed mid-write
  appendFileSync(filePath, '\n{"hello":1}\n');
  const reloaded = createDeadLetterStore({ filePath });
  assert.deepEqual(reloaded.list().map((e) => e.key), ['ok']);
  assert.equal(reloaded.skippedLines, 2);
});

test('resolve() of an unknown id is a no-op that writes nothing', (t) => {
  const filePath = tempPath(t);
  const store = createDeadLetterStore({ filePath });
  store.add({ key: 'a' });
  assert.equal(store.resolve('nope'), false);
  assert.equal(lines(filePath).length, 1);
});

test('the parent directory is created on first write', (t) => {
  const filePath = join(tempPath(t, 'nested'), 'deeper', 'dlq.jsonl');
  createDeadLetterStore({ filePath }).add({ key: 'a' });
  assert.equal(lines(filePath).length, 1);
});

test('an invalid tailSize is refused', () => {
  assert.throws(() => createDeadLetterStore({ tailSize: 0 }), /tailSize/);
  assert.throws(() => createDeadLetterStore({ tailSize: 1.5 }), /tailSize/);
});
