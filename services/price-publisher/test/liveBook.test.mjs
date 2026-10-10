import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBook } from '../src/venues/liveBook.mjs';

const T = 1_000_000;
const TICK = { bid: 10n, ask: 11n, ts: T };

test('nothing to refresh before the first tick', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.heard(T);
  assert.equal(book.refresh(T + 1), null);
});

test('re-issues the last tick with the refresh time while frames keep arriving', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.record(TICK, T);
  book.heard(T + 8_000); // e.g. a pong
  book.heard(T + 16_000);
  assert.deepEqual(book.refresh(T + 20_000), { bid: 10n, ask: 11n, ts: T + 20_000 });
});

test('the window is inclusive at exactly liveWindowMs and closed one ms later (boundary)', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.record(TICK, T);
  assert.deepEqual(book.refresh(T + 10_000), { ...TICK, ts: T + 10_000 });
  assert.equal(book.refresh(T + 10_001), null);
});

test('a later frame reopens the window for the same book', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.record(TICK, T);
  assert.equal(book.refresh(T + 15_000), null);
  book.heard(T + 15_000);
  assert.deepEqual(book.refresh(T + 15_500), { ...TICK, ts: T + 15_500 });
});

test('a new tick replaces the carried book', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.record(TICK, T);
  book.record({ bid: 20n, ask: 21n, ts: T + 5 }, T + 5);
  assert.deepEqual(book.refresh(T + 6), { bid: 20n, ask: 21n, ts: T + 6 });
});

test('reset forgets the book entirely', () => {
  const book = createLiveBook({ liveWindowMs: 10_000 });
  book.record(TICK, T);
  book.reset();
  book.heard(T + 1);
  assert.equal(book.refresh(T + 2), null);
});
