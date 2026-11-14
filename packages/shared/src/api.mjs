// The public API, described once.
//
// The /docs/api page renders from this list, and services/api's own test suite checks it
// against the routes the server actually registers, the limits the handlers enforce and the
// channels the WebSocket accepts. A route added to the server without a line here fails that
// test, so the published reference cannot quietly fall behind the API it describes.

/** @type {import('./api.d.ts').ApiGroup[]} */
export const API_GROUPS = [
  { id: 'markets', title: 'Markets & prices' },
  { id: 'wallets', title: 'Wallets' },
  { id: 'points', title: 'Points' },
  { id: 'vault', title: 'LP vault' },
  { id: 'status', title: 'Status' },
];

const PAIR_INDEX = {
  name: 'pairIndex',
  in: 'path',
  description: 'The market, as listed by GET /markets: 0 is BTC.',
};

const ADDRESS = {
  name: 'address',
  in: 'path',
  description: 'A wallet: 0x and 40 hex characters, in any case.',
};

/** @type {import('./api.d.ts').ApiEndpoint[]} */
export const API_ENDPOINTS = [
  {
    method: 'GET',
    path: '/markets',
    group: 'markets',
    summary: 'Every market: its pair, maximum leverage, open-interest cap and the open interest on each side.',
    params: [],
    example: '/markets',
  },
  {
    method: 'GET',
    path: '/markets/:pairIndex',
    group: 'markets',
    summary: 'One market, in the same shape.',
    params: [PAIR_INDEX],
    example: '/markets/0',
  },
  {
    method: 'GET',
    path: '/markets/:pairIndex/candles',
    group: 'markets',
    summary:
      'Price candles, oldest first: t (bucket start), o, h, l, c. Without a range you get the latest 500; a range returns at most 5,000.',
    params: [
      PAIR_INDEX,
      { name: 'interval', in: 'query', description: '1m, 5m, 15m, 1h, 4h or 1d. Default 1h.' },
      { name: 'from', in: 'query', description: 'Range start, unix seconds.' },
      { name: 'to', in: 'query', description: 'Range end, unix seconds. Default now.' },
    ],
    example: '/markets/0/candles?interval=1d',
  },
  {
    method: 'GET',
    path: '/price/:pairIndex',
    group: 'markets',
    summary:
      'The live index and mark price, the bid and ask behind them, and which exchanges are feeding the oracle. source says whether the live oracle answered or, failing that, the last price settled on chain.',
    params: [PAIR_INDEX],
    example: '/price/0',
  },
  {
    method: 'GET',
    path: '/positions/:address',
    group: 'wallets',
    summary: 'Open positions, newest first: market, side, collateral, leverage, entry, TP and SL.',
    params: [ADDRESS],
    example: '/positions/:address',
  },
  {
    method: 'GET',
    path: '/positions/:address/history',
    group: 'wallets',
    summary: 'Every close that realised PnL, partial closes included, with its reason (close, tp, sl, liq) and realised PnL.',
    params: [ADDRESS],
    limit: { default: 500, max: 1000 },
    example: '/positions/:address/history?limit=5',
  },
  {
    method: 'GET',
    path: '/orders/:address',
    group: 'wallets',
    summary: 'Orders waiting for the oracle, plus those resolved in the last hour.',
    params: [ADDRESS],
    example: '/orders/:address',
  },
  {
    method: 'GET',
    path: '/orders/:address/history',
    group: 'wallets',
    summary: 'Every order the wallet ever sent, newest first, with how it ended: executed, cancelled and why.',
    params: [ADDRESS],
    limit: { default: 100, max: 500 },
    example: '/orders/:address/history?limit=5',
  },
  {
    method: 'GET',
    path: '/limit-orders/:address',
    group: 'wallets',
    summary: 'Resting limit and stop orders that have not filled yet.',
    params: [ADDRESS],
    example: '/limit-orders/:address',
  },
  {
    method: 'GET',
    path: '/fees/:address',
    group: 'wallets',
    summary: 'Every fee charged, newest first: oracle, opening, rollover, funding and the rest. Funding is signed; negative was paid to the trader.',
    params: [ADDRESS],
    limit: { default: 200, max: 1000 },
    example: '/fees/:address?limit=5',
  },
  {
    method: 'GET',
    path: '/pnl/:address',
    group: 'wallets',
    summary: 'Totals over every close: realised PnL, fees, funding and how many trades realised anything.',
    params: [ADDRESS],
    example: '/pnl/:address',
  },
  {
    method: 'GET',
    path: '/points/leaderboard',
    group: 'points',
    summary: 'The Season One table, highest total first, with each wallet’s missions, time, streak and LP points.',
    params: [],
    limit: { default: 100, max: 500 },
    example: '/points/leaderboard?limit=5',
  },
  {
    method: 'GET',
    path: '/points/:address',
    group: 'points',
    summary: 'One wallet’s points by component, its rank, streak and completed missions.',
    params: [ADDRESS],
    example: '/points/:address',
  },
  {
    method: 'GET',
    path: '/vault/settlements',
    group: 'vault',
    summary: 'Vault settlements, newest first: total assets, share price, open and closed trader PnL, deposits and withdrawals.',
    params: [],
    limit: { default: 50, max: 500 },
    example: '/vault/settlements?limit=3',
  },
  {
    method: 'GET',
    path: '/vault/performance',
    group: 'vault',
    summary:
      'What an LP earned: the share price now, its change and APR over 7 days, 30 days and since the first settlement, and one share price per UTC day for a chart. APR is the change annualised without compounding; a window is null while the vault is younger than it.',
    params: [],
    example: '/vault/performance',
  },
  {
    method: 'GET',
    path: '/health',
    group: 'status',
    summary: 'The newest indexed block and how far behind the chain it is. status is ok, degraded (over 30 s behind) or down (over 5 min).',
    params: [],
    example: '/health',
  },
  {
    // Sends real WBT from a funded server wallet to new wallets. The app calls it; it is
    // not something to invite scripts to call, so the reference leaves it out.
    method: 'POST',
    path: '/faucet/wbt',
    group: 'status',
    summary: 'Gas for a new wallet. Used by the app’s faucet page.',
    params: [],
    internal: true,
  },
];

/** @type {import('./api.d.ts').WsChannel[]} */
export const WS_CHANNELS = [
  {
    kind: 'price',
    pattern: 'price:<pairIndex>',
    example: 'price:0',
    summary: 'The same payload as GET /price/:pairIndex.',
  },
  {
    kind: 'candles',
    pattern: 'candles:<pairIndex>:<interval>',
    example: 'candles:0:1m',
    summary: 'The newest candle of that interval, as it forms.',
  },
  {
    kind: 'positions',
    pattern: 'positions:<address>',
    example: 'positions:0x0000000000000000000000000000000000000001',
    summary: 'The same list as GET /positions/:address.',
  },
  {
    kind: 'orders',
    pattern: 'orders:<address>',
    example: 'orders:0x0000000000000000000000000000000000000001',
    summary: 'The same list as GET /orders/:address.',
  },
  {
    kind: 'limitOrders',
    pattern: 'limitOrders:<address>',
    example: 'limitOrders:0x0000000000000000000000000000000000000001',
    summary: 'The same list as GET /limit-orders/:address.',
  },
  {
    kind: 'fees',
    pattern: 'fees:<address>',
    example: 'fees:0x0000000000000000000000000000000000000001',
    summary: 'The same list as GET /fees/:address.',
  },
];

/** What one client may hold open on the WebSocket, and how often it is refreshed. */
export const WS_LIMITS = {
  pollIntervalMs: 2000,
  subscriptionsPerSocket: 64,
  connectionsPerIp: 20,
};

/** The endpoints the public reference lists. */
export function publicEndpoints() {
  return API_ENDPOINTS.filter((e) => !e.internal);
}
