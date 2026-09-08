import { WS_URL } from './config';
import type { WsMessage } from './types';

/**
 * Thin client for the single `/ws` endpoint (D3): one socket, many channels
 * (`price:<pairIndex>`, `positions:<address>`, `orders:<address>`,
 * `candles:<pairIndex>:<interval>`), multiplexed by subscribing per-channel. The wire
 * protocol for subscribe/unsubscribe is not specified beyond the channel name strings
 * (D3 lists channels, not a subscribe envelope), so this client uses the smallest
 * reasonable shape — `{"type":"subscribe","channel":"..."}` — and documents it here as an
 * assumption to reconcile with services/api once it exists (see
 * docs/decisions/phase-5-frontend.md).
 *
 * Every consumer must also be able to run without this socket ever connecting — real
 * networks drop WebSockets, and the design's own error-handling table (§7) treats "RPC
 * down" / venue loss as an expected, not exceptional, condition. Callers should pair this
 * with a REST poll fallback (see the `useXxx` hooks in src/hooks) rather than trusting the
 * socket alone.
 */

type Listener = (message: WsMessage) => void;

export class WsClient {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;

  constructor(private readonly url: string) {}

  connect(): void {
    if (typeof WebSocket === 'undefined') return; // SSR / non-browser
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByCaller = false;
    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      for (const channel of this.listeners.keys()) {
        this.sendSubscribe(channel);
      }
    });
    this.socket.addEventListener('message', (event) => {
      let parsed: WsMessage | null = null;
      try {
        parsed = JSON.parse(String(event.data)) as WsMessage;
      } catch {
        return;
      }
      const channelListeners = this.listeners.get(parsed.channel);
      if (channelListeners) {
        for (const listener of channelListeners) listener(parsed);
      }
    });
    this.socket.addEventListener('close', () => {
      if (!this.closedByCaller) this.scheduleReconnect();
    });
    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private sendSubscribe(channel: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'subscribe', channel }));
    }
  }

  private sendUnsubscribe(channel: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', channel }));
    }
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.sendSubscribe(channel);
    }
    set.add(listener);
    this.connect();
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listeners.delete(channel);
        this.sendUnsubscribe(channel);
      }
    };
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

let sharedClient: WsClient | null = null;

/** Lazily-constructed singleton so every hook shares one socket / subscription set. */
export function getWsClient(): WsClient {
  if (!sharedClient) {
    sharedClient = new WsClient(WS_URL);
  }
  return sharedClient;
}
