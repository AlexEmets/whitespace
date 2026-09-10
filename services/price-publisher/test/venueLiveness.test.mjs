/**
 * The half-open socket regression.
 *
 * A venue whose peer disappears without sending a FIN or an RST leaves a TCP connection
 * that stays `ESTABLISHED` forever. `ws` emits neither `error` nor `close` for it, so the
 * original reconnect loop — which was armed only on those two events — had no path back
 * to `connect()`. On this stack that produced a nine-hour total outage: four venue sockets
 * open, `healthyCount: 0`, not one tick published, and nothing able to recover it. With no
 * signed price report the keeper cannot fill any order, so the whole product was down.
 *
 * These tests are deliberately I/O tests against a real local WebSocket server, because
 * the bug lived entirely in socket lifecycle behaviour — a mocked socket would have
 * happily emitted the `close` that the real failure never sends. The silent server below
 * IS the failure mode: it completes the handshake, then says nothing forever.
 *
 * `connectVenue` selects a parser via `VENUE_MODULES`, which is exported, so a test-only
 * entry can be registered rather than reaching into the module's internals.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { VENUE_MODULES, connectVenue } from '../src/venues/index.mjs';

/** Parses the trivial `{bid, ask}` frames the chatty server below sends. */
const testVenue = {
  wsUrl: '',
  wsUrlFor: (symbol) => symbol, // the "symbol" IS the url in these tests
  subscribePayload: () => null,
  parseMessage: (message, ts) =>
    message && message.bid !== undefined ? { bid: BigInt(message.bid), ask: BigInt(message.ask), ts } : null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A server that accepts connections and then behaves in one of two ways:
 *  - 'silent'  — completes the handshake and sends nothing, ever. It also answers no
 *                pings, because `ws` auto-replies to pings at the protocol level and an
 *                auto-pong would (correctly) count as liveness. Disabling that is what
 *                makes this a black hole rather than a quiet peer.
 *  - 'chatty'  — sends a frame every 50ms.
 * Counts how many times it has been connected to, which is how the tests observe a
 * reconnect having happened at all.
 */
async function startServer(mode) {
  // `autoPong: false` is what makes 'silent' genuinely silent. `ws` answers pings at the
  // protocol level on its own, regardless of any 'ping' listener — so without this the
  // "dead" peer keeps ponging, the client's watchdog correctly sees liveness, and the
  // test proves nothing. (It failed exactly that way first: a quiet-but-answering peer is
  // not the failure being reproduced.) A truly half-open socket answers with nothing.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: mode !== 'silent' });
  // `address()` is null until the underlying server is actually listening; reading the
  // port synchronously after construction yields a TypeError, not a port.
  await new Promise((resolve) => wss.once('listening', resolve));
  const state = { connections: 0, sockets: [] };

  wss.on('connection', (socket) => {
    state.connections += 1;
    state.sockets.push(socket);
    // 'silent': accept the handshake and then do nothing at all — no data, no pong, no
    // close. This is the half-open shape: a connection the OS still calls ESTABLISHED
    // with a peer that will never speak again.
    if (mode === 'silent') return;
    const timer = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ bid: '1', ask: '2' }));
    }, 50);
    socket.on('close', () => clearInterval(timer));
  });

  state.url = `ws://127.0.0.1:${wss.address().port}`;
  state.close = () =>
    new Promise((resolve) => {
      for (const s of state.sockets) s.terminate();
      wss.close(() => resolve());
    });
  return state;
}

describe('venue socket liveness', () => {
  before(() => {
    VENUE_MODULES.__test = testVenue;
  });
  after(() => {
    delete VENUE_MODULES.__test;
  });

  it('reconnects to a peer that completes the handshake and then goes permanently silent', async () => {
    const server = await startServer('silent');
    const errors = [];
    const stop = connectVenue('__test', server.url, () => {}, (err) => errors.push(err.message));

    try {
      // IDLE_TIMEOUT_MS is 20s and the watchdog runs at half that, so the first eviction
      // lands by ~30s. Waited out in full rather than shortened via an injected timeout,
      // because the point of this test is the real timer wiring, not a parameter.
      await sleep(34_000);

      assert.ok(
        server.connections >= 2,
        `expected a reconnect after the silent peer stalled, saw ${server.connections} connection(s). ` +
          'Before the fix this stayed at 1 forever.',
      );
      assert.ok(
        errors.some((m) => m.includes('half-open')),
        `expected the watchdog to report why it gave up, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      stop();
      await server.close();
    }
  });

  it('does NOT reconnect a peer that is sending normally', async () => {
    const server = await startServer('chatty');
    const ticks = [];
    const stop = connectVenue('__test', server.url, (tick) => ticks.push(tick), () => {});

    try {
      await sleep(34_000);
      assert.equal(server.connections, 1, 'a healthy socket must not be recycled by the idle watchdog');
      assert.ok(ticks.length > 0, 'expected ticks to have flowed');
      assert.equal(ticks[0].venue, '__test');
    } finally {
      stop();
      await server.close();
    }
  });

  it('stops for good once stopped, and does not resurrect itself', async () => {
    const server = await startServer('silent');
    const stop = connectVenue('__test', server.url, () => {}, () => {});
    await sleep(500);
    stop();
    const atStop = server.connections;

    await sleep(34_000);
    assert.equal(server.connections, atStop, 'a stopped venue must not reconnect');

    await server.close();
  });
});
