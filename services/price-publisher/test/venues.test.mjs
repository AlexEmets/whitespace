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

test('bybit.parseMessage extracts bid/ask + exchange ts from a real orderbook.1 frame', () => {
  const raw = {
    topic: 'orderbook.1.BTCUSDT',
    ts: 1_788_882_595_939,
    type: 'snapshot',
    data: { s: 'BTCUSDT', b: [['78779.7', '0.144931']], a: [['78779.8', '0.584126']], u: 94220140, seq: 113768148026 },
    cts: 1_788_882_595_937,
  };
  const tick = bybit.parseMessage(raw);
  assert.equal(tick.bid, parseDecimalTo18('78779.7'));
  assert.equal(tick.ask, parseDecimalTo18('78779.8'));
  assert.equal(tick.ts, 1_788_882_595_939);
});

test('bybit.parseMessage ignores the tickers channel and non-orderbook frames (no bid/ask there)', () => {
  const tickersFrame = { topic: 'tickers.BTCUSDT', ts: 1, type: 'snapshot', data: { symbol: 'BTCUSDT', lastPrice: '78781.4' } };
  assert.equal(bybit.parseMessage(tickersFrame), null);
  assert.equal(bybit.parseMessage({ success: true, op: 'subscribe' }), null);
});

test('okx.parseMessage extracts bid/ask + exchange ts from a real tickers frame', () => {
  const raw = {
    arg: { channel: 'tickers', instId: 'BTC-USDT' },
    data: [{ instId: 'BTC-USDT', last: '78756.4', askPx: '78760.1', askSz: '0.16525432', bidPx: '78760', bidSz: '0.66797875', ts: '1788882603169' }],
  };
  const tick = okx.parseMessage(raw);
  assert.equal(tick.bid, parseDecimalTo18('78760'));
  assert.equal(tick.ask, parseDecimalTo18('78760.1'));
  assert.equal(tick.ts, 1_788_882_603_169);
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
  const tick = whitebit.parseMessage(book, message);
  assert.equal(tick.bid, parseDecimalTo18('78726.34')); // highest bid
  assert.equal(tick.ask, parseDecimalTo18('78726.35')); // lowest ask
  assert.equal(tick.ts, Math.round(1_788_882_538.3163829 * 1000));
});

test('whitebit: a partial update (isFullUpdate=false) patches only the side it carries', () => {
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
  // partial: only bids present, a new best bid appears above the old one
  const tick = whitebit.parseMessage(book, {
    method: 'depth_update',
    params: [false, { bids: [['78730.00', '0.1']], event_time: 2 }, 'BTC_USDT'],
  });
  assert.equal(tick.bid, parseDecimalTo18('78730.00'));
  assert.equal(tick.ask, parseDecimalTo18('78726.35')); // ask untouched by the partial update
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
