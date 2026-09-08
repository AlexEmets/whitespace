import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeadLetterQueue } from '../src/deadLetter.mjs';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dlq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'dead-letters.json');
}

test('add() records an entry with a string orderId and a timestamp', () => {
  const dlq = createDeadLetterQueue();
  dlq.add({ orderId: 42n, reason: 'tx reverted', attempts: 4 });
  assert.equal(dlq.size(), 1);
  const [entry] = dlq.list();
  assert.equal(entry.orderId, '42');
  assert.equal(entry.reason, 'tx reverted');
  assert.equal(typeof entry.at, 'number');
});

test('remove() drops only the matching orderId', () => {
  const dlq = createDeadLetterQueue();
  dlq.add({ orderId: 1n, reason: 'a', attempts: 1 });
  dlq.add({ orderId: 2n, reason: 'b', attempts: 1 });
  dlq.remove('1');
  assert.deepEqual(
    dlq.list().map((e) => e.orderId),
    ['2'],
  );
});

test('clear() empties the queue', () => {
  const dlq = createDeadLetterQueue();
  dlq.add({ orderId: 1n, reason: 'a', attempts: 1 });
  dlq.clear();
  assert.equal(dlq.size(), 0);
});

test('with a filePath, entries survive a fresh createDeadLetterQueue() call (restart-safe)', (t) => {
  const filePath = tempFile(t);
  const first = createDeadLetterQueue({ filePath });
  first.add({ orderId: 99n, reason: 'gas too low', attempts: 3 });

  const second = createDeadLetterQueue({ filePath });
  assert.equal(second.size(), 1);
  assert.equal(second.list()[0].orderId, '99');

  const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.length, 1);
});
