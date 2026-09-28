import { getAddress, type Address } from 'viem';

/**
 * Single in-memory source of truth shared between the mock chain (tests/e2e/mockChain.ts,
 * answers window.ethereum.request calls) and the mock backend (tests/e2e/mockBackend.ts,
 * answers services/api HTTP routes via page.route). Both run in the Playwright/Node test
 * process, not the browser, so a plain shared object is enough — no IPC needed.
 *
 * This models the real architecture's separation faithfully: writes go straight to the
 * (mock) chain; the two-phase order/position state the UI reads comes from the (mock)
 * API, not from chain state — exactly as design §5.1 and the phase-5 brief specify.
 */

export const MOCK_TRADER_ADDRESS: Address = getAddress(`0x${'f1'.repeat(20)}`);
export const MOCK_PAIR_INDEX = 0;

export interface MockOrder {
  orderId: string;
  pairIndex: number;
  trader: string;
  buy: boolean;
  collateral: string;
  leverage: string;
  requestedAt: number;
  status: 'pending' | 'executed' | 'cancelled';
  cancelReason?: string;
  tradeId?: string;
  executedAt?: number;
}

export interface MockPosition {
  pairIndex: number;
  index: number;
  buy: boolean;
  collateral: string;
  leverage: string;
  openPrice: string;
  tp: string;
  sl: string;
  openedAt: number;
  tradeId: string;
}

export interface MockLimitOrder {
  pairIndex: number;
  index: number;
  orderType: 'LIMIT' | 'STOP';
  buy: boolean;
  collateral: string;
  leverage: string;
  triggerPrice: string;
  tp: string;
  sl: string;
  placedAt: number;
  updatedAt: number;
}

export interface MockFee {
  id: string;
  tradeId: string | null;
  pairIndex: number | null;
  kind: string;
  /** raw 1e6, signed */
  amount: string;
  at: number;
  txHash: string;
}

/** A decoded wallet-signed call to Trading, recorded so tests can assert exactly what was signed. */
export interface SentCall {
  functionName: string;
  args: readonly unknown[];
}

export class TestState {
  usdwBalance = 10_000_000_000n; // 10,000.00 USDW
  /** spender (lowercased address) -> approved amount */
  allowances = new Map<string, bigint>();
  vaultSettlementId = 1;
  /** settlementId -> RequestStatus index (0 NONE, 1 PENDING, 2 CLAIMABLE, 3 RECLAIMABLE) */
  depositStatus = new Map<number, number>();
  vaultShareBalance = 0n;
  orders: MockOrder[] = [];
  positions: MockPosition[] = [];
  nextOrderId = 100n;
  nextTradeId = 900n;
  markPrice = '65001000000000000000000'; // 65,001.00, 18 decimals — matches the real
  // deployments/1874-operational.json proof trade's open price.
  indexPrice = '65000000000000000000000';
  degraded = false;
  /** PairInfos priceImpactK (PRECISION_18-scaled). 0 = no size-dependent impact. */
  priceImpactK = 0n;
  /** Oracle bid/ask half-spread around the mark, raw 1e18. The real API always sends both. */
  halfSpread = 0n;
  limitOrders: MockLimitOrder[] = [];
  fees: MockFee[] = [];
  sentTrading: SentCall[] = [];
  /** Per-block funding rate, PRECISION_18, positive when longs pay. */
  fundingRatePerBlock = 0n;
  /** GET /points/:address payload (address is filled in by the mock backend); undefined
   * serves a genuine zero. Points figures are decimal strings, like the real API. */
  points?: {
    missions: string;
    time: string;
    streak: string;
    lp: string;
    total: string;
    rank: number | null;
    streakDays: number;
    streakLongest: number;
    completedMissions: string[];
    updatedAt: number | null;
    lpBalance: string;
    lpSince: number | null;
  };
  /** GET /points/leaderboard payload. */
  leaderboard?: Array<{
    rank: number;
    address: string;
    missions: string;
    time: string;
    streak: string;
    lp: string;
    total: string;
  }>;
}
