import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '@/lib/ws';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  // test helpers, not part of the real WebSocket API
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  receive(payload: unknown) {
    this.dispatch('message', { data: JSON.stringify(payload) });
  }

  receiveRaw(raw: string) {
    this.dispatch('message', { data: raw });
  }

  private dispatch(type: string, event: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WsClient', () => {
  it('sends a subscribe message once the socket opens', () => {
    const client = new WsClient('ws://test/ws');
    client.subscribe('price:0', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(socket.sent).toContain(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
  });

  it('dispatches an incoming message only to listeners on its channel', () => {
    const client = new WsClient('ws://test/ws');
    const priceListener = vi.fn();
    const positionsListener = vi.fn();
    client.subscribe('price:0', priceListener);
    client.subscribe('positions:0xabc', positionsListener);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ channel: 'price:0', type: 'price', data: { mark: '1' } });

    expect(priceListener).toHaveBeenCalledTimes(1);
    expect(positionsListener).not.toHaveBeenCalled();
  });

  it('ignores a message that is not valid JSON instead of throwing', () => {
    const client = new WsClient('ws://test/ws');
    const listener = vi.fn();
    client.subscribe('price:0', listener);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(() => socket.receiveRaw('not json')).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing the last listener on a channel sends an unsubscribe message', () => {
    const client = new WsClient('ws://test/ws');
    const unsubscribe = client.subscribe('price:0', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    unsubscribe();
    expect(socket.sent).toContain(JSON.stringify({ type: 'unsubscribe', channel: 'price:0' }));
  });
});
