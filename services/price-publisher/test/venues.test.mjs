import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalTo18 } from '@whitespace/shared/decimal';
import * as binance from '../src/venues/binance.mjs';
import * as bybit from '../src/venues/bybit.mjs';
import * as okx from '../src/venues/okx.mjs';
import * as whitebit from '../src/venues/whitebit.mjs';

// Fixtures below are real captured payloads (2026-09-08, live sockets), not invented shapes.

test('binance.parseMessage extracts bid/ask from a real bookTicker frame and stamps receipt time', () => {
  const raw = { u: 99849560470, s: 'BTCUSDT', b: '78779.99000000', B: '1.10146000', a: '78780.00000000', A: '2.96360000' };
  const now = 1_788_882_538_000;
  const tick = binance.parseMessage(raw, now);
  assert.equal(tick.bid, parseDecimalTo18('78779.99'));
  assert.equal(tick.ask, parseDecimalTo18('78780.00'));
  assert.equal(tick.ts, now);
});

test('binance.parseMessage returns null for a non-ticker frame', () => {
  assert.equal(binance.parseMessage({ foo: 'bar' }, Date.now()), null);
  assert.equal(binance.parseMessage(null, Date.now()), null);
});

test('binance.wsUrlFor lowercases the symbol into the stream path', () => {
  assert.equal(binance.wsUrlFor('BTCUSDT'), 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker');
});

// Receipt time, not exchange time: the frames below carry exchange timestamps from 2026-09-08,
// and `now` is deliberately ten seconds away from them. With the exchange time used, every
// one of these ticks would be judged by how far apart two clocks are, not by how fresh it is.
const RECEIVED_AT = 1_788_882_610_000;

test('bybit.parseMessage extracts bid/ask from a real orderbook.1 frame and stamps receipt time', () => {
  const raw = {
    topic: 'orderbook.1.BTCUSDT',
    ts: 1_788_882_595_939,
    type: 'snapshot',
    data: { s: 'BTCUSDT', b: [['78779.7', '0.144931']], a: [['78779.8', '0.584126']], u: 94220140, seq: 113768148026 },
    cts: 1_788_882_595_937,
  };
  const tick = bybit.parseMessage(raw, RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('78779.7'));
  assert.equal(tick.ask, parseDecimalTo18('78779.8'));
  assert.equal(tick.ts, RECEIVED_AT);
});

test('bybit.parseMessage ignores the tickers channel and non-orderbook frames (no bid/ask there)', () => {
  const tickersFrame = { topic: 'tickers.BTCUSDT', ts: 1, type: 'snapshot', data: { symbol: 'BTCUSDT', lastPrice: '78781.4' } };
  assert.equal(bybit.parseMessage(tickersFrame), null);
  assert.equal(bybit.parseMessage({ success: true, op: 'subscribe' }), null);
});

test('okx.parseMessage extracts bid/ask from a real tickers frame and stamps receipt time', () => {
  const raw = {
    arg: { channel: 'tickers', instId: 'BTC-USDT' },
    data: [{ instId: 'BTC-USDT', last: '78756.4', askPx: '78760.1', askSz: '0.16525432', bidPx: '78760', bidSz: '0.66797875', ts: '1788882603169' }],
  };
  const tick = okx.parseMessage(raw, RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('78760'));
  assert.equal(tick.ask, parseDecimalTo18('78760.1'));
  assert.equal(tick.ts, RECEIVED_AT);
});

test('okx.parseMessage ignores the subscribe ack', () => {
  assert.equal(okx.parseMessage({ event: 'subscribe', arg: { channel: 'tickers', instId: 'BTC-USDT' } }), null);
});

// --- WhiteBIT: incremental order-book diff, needs a running book -------------------

test('whitebit: a full update (isFullUpdate=true) seeds both sides and yields best bid/ask', () => {
  const book = whitebit.createBook();
  const message = {
    method: 'depth_update',
    params: [
      true,
      {
        timestamp: 1_788_882_538.2248011,
        asks: [
          ['78726.35', '0.045088'],
          ['78743.51', '0.015117'],
        ],
        bids: [
          ['78726.34', '0.045088'],
          ['78723.28', '0.02067'],
        ],
        event_time: 1_788_882_538.3163829,
      },
      'BTC_USDT',
    ],
    id: null,
  };
  const tick = whitebit.parseMessage(book, message, RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('78726.34')); // highest bid
  assert.equal(tick.ask, parseDecimalTo18('78726.35')); // lowest ask
  assert.equal(tick.ts, RECEIVED_AT); // receipt time, not event_time
});

test('whitebit: a partial update (isFullUpdate=false) patches only the side it carries', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, {
    method: 'depth_update',
    params: [
      true,
      {
        asks: [['78740.00', '0.045088']], // above the new bid below: an exchange book never crosses
        bids: [
          ['78726.34', '0.045088'],
          ['78723.28', '0.02067'],
        ],
        event_time: 1,
      },
      'BTC_USDT',
    ],
  });
  // partial: only bids present, a new best bid appears above the old one
  const tick = whitebit.parseMessage(book, {
    method: 'depth_update',
    params: [false, { bids: [['78730.00', '0.1']], event_time: 2 }, 'BTC_USDT'],
  });
  assert.equal(tick.bid, parseDecimalTo18('78730.00'));
  assert.equal(tick.ask, parseDecimalTo18('78740.00')); // ask untouched by the partial update
});

test('whitebit: a zero-volume level removes that price from the book', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, {
    method: 'depth_update',
    params: [
      true,
      {
        asks: [['78726.35', '0.045088']],
        bids: [
          ['78726.34', '0.045088'],
          ['78723.28', '0.02067'],
        ],
        event_time: 1,
      },
      'BTC_USDT',
    ],
  });
  // remove the best bid (78726.34) by sending volume "0" for it
  const tick = whitebit.parseMessage(book, {
    method: 'depth_update',
    params: [false, { bids: [['78726.34', '0']] }, 'BTC_USDT'],
  });
  assert.equal(tick.bid, parseDecimalTo18('78723.28')); // next best bid after removal
});

test('whitebit.parseMessage ignores the subscribe ack', () => {
  const book = whitebit.createBook();
  assert.equal(whitebit.parseMessage(book, { error: null, result: { status: 'success' }, id: 1 }), null);
});

test('whitebit.bestOfBook returns null until both sides have at least one level', () => {
  const book = whitebit.createBook();
  assert.equal(whitebit.bestOfBook(book, 0), null);
  whitebit.applyDepthUpdate(book, [true, { bids: [['100', '1']] }, 'BTC_USDT']);
  assert.equal(whitebit.bestOfBook(book, 0), null); // no ask yet
});

test('a venue frame with no exchange timestamp still yields a tick (receipt time is enough)', () => {
  const bybitNoTs = { topic: 'orderbook.1.BTCUSDT', type: 'snapshot', data: { b: [['1', '1']], a: [['2', '1']] } };
  assert.equal(bybit.parseMessage(bybitNoTs, RECEIVED_AT).ts, RECEIVED_AT);
  const okxNoTs = { arg: { channel: 'tickers', instId: 'BTC-USDT' }, data: [{ bidPx: '1', askPx: '2' }] };
  assert.equal(okx.parseMessage(okxNoTs, RECEIVED_AT).ts, RECEIVED_AT);
});

// --- WhiteBIT: sequence (update_id / past_update_id) and crossed books ---------------

const wbFull = (updateId, bids, asks) => ({ method: 'depth_update', params: [true, { update_id: updateId, bids, asks }, 'WBT_USDT'] });
const wbDiff = (pastId, updateId, side) => ({ method: 'depth_update', params: [false, { past_update_id: pastId, update_id: updateId, ...side }, 'WBT_USDT'] });

test('whitebit: diffs that chain on update_id keep the book in sync', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, wbFull(100, [['58.40', '1']], [['58.42', '1']]), RECEIVED_AT);
  const tick = whitebit.parseMessage(book, wbDiff(100, 101, { bids: [['58.41', '2']] }), RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('58.41'));
  assert.equal(whitebit.needsResync(book), false);
  assert.equal(book.lastUpdateId, 101);
});

test('whitebit: a diff whose past_update_id skips a frame marks the book out of sync and yields no tick', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, wbFull(100, [['58.40', '1']], [['58.42', '1']]), RECEIVED_AT);
  // frame 101 was lost; 102 builds on it
  const tick = whitebit.parseMessage(book, wbDiff(101, 102, { asks: [['58.42', '0']] }), RECEIVED_AT);
  assert.equal(tick, null);
  assert.equal(whitebit.needsResync(book), true);
  // later diffs do not apply on top of a broken book
  assert.equal(whitebit.parseMessage(book, wbDiff(102, 103, { bids: [['58.41', '1']] }), RECEIVED_AT), null);
  assert.equal(book.bids.has(parseDecimalTo18('58.41').toString()), false);
});

test('whitebit: a full snapshot brings an out-of-sync book back', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, wbFull(100, [['58.40', '1']], [['58.42', '1']]), RECEIVED_AT);
  whitebit.parseMessage(book, wbDiff(105, 106, { bids: [['58.41', '1']] }), RECEIVED_AT);
  assert.equal(whitebit.needsResync(book), true);
  const tick = whitebit.parseMessage(book, wbFull(200, [['58.50', '1']], [['58.52', '1']]), RECEIVED_AT);
  assert.equal(whitebit.needsResync(book), false);
  assert.equal(tick.bid, parseDecimalTo18('58.50'));
  assert.equal(tick.ask, parseDecimalTo18('58.52'));
});

test('whitebit: a crossed book (best ask at or under best bid) yields no tick and needs a resync', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, wbFull(100, [['58.40', '1']], [['58.42', '1']]), RECEIVED_AT);
  // a bid at 58.45 with the 58.42 ask never removed: the shape a lost frame leaves behind
  const tick = whitebit.parseMessage(book, wbDiff(100, 101, { bids: [['58.45', '1']] }), RECEIVED_AT);
  assert.equal(tick, null);
  assert.equal(whitebit.needsResync(book), true);
  // a locked book (ask == bid) is just as impossible
  const locked = whitebit.createBook();
  assert.equal(whitebit.parseMessage(locked, wbFull(1, [['58.42', '1']], [['58.42', '1']]), RECEIVED_AT), null);
  assert.equal(whitebit.needsResync(locked), true);
});

test('whitebit: the same price written with a trailing zero is one level, so its removal lands', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, wbFull(100, [['58.41', '1'], ['58.40', '1']], [['58.43', '1']]), RECEIVED_AT);
  const tick = whitebit.parseMessage(book, wbDiff(100, 101, { bids: [['58.410', '0']] }), RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('58.40'));
  assert.equal(book.bids.size, 1);
});

test('whitebit: frames without update ids (older captures) still apply as before', () => {
  const book = whitebit.createBook();
  whitebit.parseMessage(book, { method: 'depth_update', params: [true, { bids: [['1', '1']], asks: [['2', '1']] }, 'X'] }, RECEIVED_AT);
  const tick = whitebit.parseMessage(book, { method: 'depth_update', params: [false, { bids: [['1.5', '1']] }, 'X'] }, RECEIVED_AT);
  assert.equal(tick.bid, parseDecimalTo18('1.5'));
  assert.equal(whitebit.needsResync(book), false);
});

test('whitebit_perp shares the resync rule', async () => {
  const perp = await import('../src/venues/whitebit_perp.mjs');
  assert.equal(perp.needsResync, whitebit.needsResync);
});
