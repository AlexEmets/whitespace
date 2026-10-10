type Hex = `0x${string}`;

export interface TxRequest {
  to: Hex;
  data: Hex;
  value?: bigint;
  gas?: bigint;
  /** Caller's identifier, e.g. `order-42`; logged and stored on a dead letter. */
  key?: string;
  /** Anything JSON-able the caller wants back on the dead letter. */
  meta?: Record<string, unknown>;
  /** Epoch ms after which nothing is broadcast or retried; the send then resolves `expired`. */
  deadlineMs?: number;
}

export interface SendSuccess {
  ok: true;
  hash: Hex;
  receipt: { status: 'success'; [k: string]: unknown };
  nonce: number;
  replacements: number;
  attempts: number;
}

export interface SendFailure {
  ok: false;
  reason: string;
  attempts: number;
  reverted?: boolean;
  hash?: Hex;
  deadLettered?: boolean;
  deadLetterId?: string;
  /** The request's deadline passed; it was not dead-lettered. */
  expired?: boolean;
}

export type SendResult = SendSuccess | SendFailure;

export interface DeadLetterEntry {
  type: 'dead';
  id: string;
  at: number;
  key: string | null;
  meta: Record<string, unknown> | null;
  request: { to: Hex; data: Hex; value?: string; gas?: string };
  reason: string;
  attempts: number;
  [k: string]: unknown;
}

export interface DeadLetterStore {
  readonly filePath: string | null;
  readonly tailSize: number;
  readonly skippedLines: number;
  readonly total: number;
  add(entry: Record<string, unknown>): DeadLetterEntry;
  resolve(id: string): boolean;
  list(): DeadLetterEntry[];
  size(): number;
}

export const DEFAULT_TAIL_SIZE: number;

export function createDeadLetterStore(opts?: {
  filePath?: string | null;
  tailSize?: number;
  now?: () => number;
}): DeadLetterStore;

export const DEFAULTS: Readonly<{
  receiptTimeoutMs: number;
  receiptPollMs: number;
  maxBumps: number;
  maxRetries: number;
  bumpNumerator: bigint;
  bumpDenominator: bigint;
  retryOnRevert: boolean;
}>;

export interface Counter {
  inc(value?: number, labels?: Record<string, string>): void;
  value(labels?: Record<string, string>): number;
}
export interface Gauge extends Counter {
  set(value: number, labels?: Record<string, string>): void;
}

export interface TxSender {
  send(req: TxRequest): Promise<SendResult>;
  retryDeadLetters(opts?: { filter?: (entry: DeadLetterEntry) => boolean }): Promise<{
    retried: number;
    delivered: number;
    failed: number;
    results: (SendResult & { id: string })[];
  }>;
  resync(): Promise<number>;
  readonly deadLetter: DeadLetterStore;
  readonly registry: { render(): string };
  readonly counters: {
    sent: Counter;
    replaced: Counter;
    confirmed: Counter;
    reverted: Counter;
    nonceResyncs: Counter;
    deadLettered: Counter;
    expired: Counter;
  };
  readonly gauges: { deadLetterDepth: Gauge; queueDepth: Gauge };
  readonly nonce: number | null;
  readonly queued: number;
}

export function createTxSender(opts: {
  publicClient: {
    getTransactionCount(args: { address: Hex; blockTag: 'pending' }): Promise<number | bigint>;
    getGasPrice(): Promise<bigint>;
    getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted' } | null>;
    /** Only used with `gasHeadroomPercent`. */
    estimateGas?(args: { account: { address: Hex }; to: Hex; data: Hex; value?: bigint }): Promise<bigint>;
  };
  walletClient: { sendTransaction(args: Record<string, unknown>): Promise<Hex> };
  account: { address: Hex };
  deadLetter?: DeadLetterStore;
  /** A @whitespace/metrics registry to register the counters on. */
  registry?: { counter(name: string, help: string): Counter; gauge(name: string, help: string): Gauge; render(): string };
  metricsPrefix?: string;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  maxBumps?: number;
  maxRetries?: number;
  bumpNumerator?: bigint;
  bumpDenominator?: bigint;
  retryOnRevert?: boolean;
  /** Wait for receipts outside the queue, so sends overlap. See txSender.mjs. */
  pipeline?: boolean;
  /** Estimate requests without `gas` and add this percent; 0 leaves estimation to the wallet client. */
  gasHeadroomPercent?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'warn' | 'error', message: string) => void;
}): TxSender;

export function isNonceTooLow(err: unknown): boolean;
export function isAlreadyKnown(err: unknown): boolean;
export function isUnderpriced(err: unknown): boolean;
export function reasonOf(err: unknown): string;
