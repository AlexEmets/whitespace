#!/usr/bin/env node
// Load test: N traders trading at once against a live deployment, the way the web app does.
//
// Every trader is a fresh wallet funded by LOAD_FUNDER_KEY (the USDW owner mints; anything
// else transfers). Half of them trade one-click (a session key calling delegatedAction), half
// sign their own transactions. Each runs LOAD_ROUNDS rounds of: market open, hold, close
// (a partial close first on every other round). Round one starts in the same second for all
// of them — the burst a keeper has to clear inside the report window.
//
// Meanwhile every trader polls the API at the web app's own intervals and keeps a WebSocket
// subscribed to its orders/positions channels, so the API and indexer see real read load.
//
// It reports fill latency, cancellations, fills that never came, API errors and latency, the
// worst indexer lag seen, and finally checks the API agrees with the chain for every trader.
//
// Env: LOAD_FUNDER_KEY (json file with private_key; mints or sends USDW), LOAD_GAS_KEY
//      (optional, sends the native gas instead; leftovers are swept back to it), LOAD_RPC_URL, LOAD_API_URL,
//      LOAD_WS_URL, LOAD_PUBLISHER_URL, LOAD_USERS (20), LOAD_ROUNDS (3).
// The harness's own RPC traffic is kept low (one block/log watcher shared by all traders,
// fixed gas limits, local nonces) so the numbers measure the deployment, not this machine's
// RPC budget.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../services/keeper/package.json', import.meta.url));
const viemMain = require.resolve('viem');
const viem = await import(pathToFileURL(viemMain).href);
const { privateKeyToAccount, generatePrivateKey } = await import(pathToFileURL(join(dirname(viemMain), 'accounts', 'index.js')).href);
const { createPublicClient, http, parseAbi, parseEther, defineChain, decodeEventLog, encodeFunctionData, keccak256 } = viem;

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const RPC_URL = env.LOAD_RPC_URL ?? 'https://rpc.testnet.whitechain.io';
const API_URL = (env.LOAD_API_URL ?? 'https://www.whitespace.finance/api').replace(/\/$/, '');
const WS_URL = env.LOAD_WS_URL ?? 'wss://www.whitespace.finance/ws';
const PUBLISHER_URL = (env.LOAD_PUBLISHER_URL ?? 'http://127.0.0.1:18787').replace(/\/$/, '');
const USERS = Number(env.LOAD_USERS ?? 20);
const ROUNDS = Number(env.LOAD_ROUNDS ?? 3);
const FILL_TIMEOUT_MS = 60_000;
const manifest = JSON.parse(readFileSync(join(REPO, 'deployments/1874.json'), 'utf8'));
const C = manifest.contracts;
const keyFrom = (path) => privateKeyToAccount(JSON.parse(readFileSync(path, 'utf8')).private_key);
const funder = keyFrom(env.LOAD_FUNDER_KEY);
// Gas may come from another wallet (the faucet holds the native token; the USDW owner may not).
const gasFunder = env.LOAD_GAS_KEY ? keyFrom(env.LOAD_GAS_KEY) : funder;

const TRADE = '(uint256 collateral,uint192 openPrice,uint192 tp,uint192 sl,address trader,uint32 leverage,uint16 pairIndex,uint8 index,bool buy,bool isDayTrade)';
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function owner() view returns (address)', 'function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)']);
const TRADING = parseAbi([
  `function openTrade(${TRADE} t, (address builder,uint32 builderFee) bf, uint8 orderType, uint256 slippageP)`,
  'function closeTradeMarket(uint16 pairIndex, uint8 index, uint16 closePercentage, uint192 marketPrice, uint32 slippageP)',
  'function setDelegate(address delegate)',
  'function delegatedAction(address trader, bytes call_data) returns (bytes)',
  'event MarketOpenOrderInitiated(uint256 indexed orderId, address indexed trader, uint16 indexed pairIndex)',
  'event MarketCloseOrderInitiatedV2(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint16 closePercentage)',
]);
const CALLBACKS = parseAbi([
  `event MarketOpenExecuted(uint256 indexed orderId, ${TRADE} t, uint256 priceImpactP, uint256 tradeNotional)`,
  'event MarketCloseExecutedV2(uint256 indexed orderId, uint256 indexed tradeId, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 percentageClosed)',
  'event MarketOpenCanceled(uint256 indexed orderId, address indexed trader, uint256 indexed pairIndex, uint8 cancelReason)',
  'event MarketCloseCanceled(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint256 pairIndex, uint256 index, uint8 cancelReason)',
]);
const CANCEL_REASONS = ['NONE', 'PAUSED', 'MARKET_CLOSED', 'SLIPPAGE', 'TP_REACHED', 'SL_REACHED', 'EXPOSURE_LIMITS', 'PRICE_IMPACT', 'MAX_LEVERAGE', 'NO_TRADE', 'UNDER_LIQUIDATION', 'NOT_HIT', 'GAIN_LOSS', 'DAY_TRADE_NOT_ALLOWED', 'CLOSE_DAY_TRADE_NOT_ALLOWED', 'WRONG_TRADE'];
const E6 = 10n ** 6n;
const ZERO = '0x0000000000000000000000000000000000000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'native', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 6, retryDelay: 500 }) });
const gasPrice = await pub.getGasPrice();

const stats = {
  harnessRpcErrors: 0,
  txReverted: [],
  fills: { open: [], close: [] },
  cancels: [],
  neverFilled: [],
  api: { calls: 0, errors: 0, byStatus: {}, latency: [], errorSamples: [] },
  ws: { opened: 0, messages: 0, closedUnexpectedly: 0, closeCodes: {}, errors: 0 },
  maxLagSeconds: 0,
  lagSamples: [],
};

// ── one shared watcher: receipts for our transactions, callback events for our orders ────────
const pendingTx = new Map(); // hash -> {resolve}
const pendingOrders = new Map(); // orderId -> {resolve, sentAt}
const earlyEvents = new Map(); // orderId -> decoded event seen before anyone waited for it
let watching = true;
let cursor = await pub.getBlockNumber();

async function watcher() {
  while (watching) {
    try {
      const head = await pub.getBlockNumber();
      if (head > cursor) {
        const from = cursor + 1n;
        const to = head;
        for (let b = from; b <= to; b++) {
          if (pendingTx.size === 0) break;
          const block = await pub.getBlock({ blockNumber: b });
          for (const h of block.transactions) {
            const p = pendingTx.get(h);
            if (!p) continue;
            pendingTx.delete(h);
            pub.getTransactionReceipt({ hash: h }).then(p.resolve, p.reject);
          }
        }
        const logs = await pub.getLogs({ address: C.callbacks, fromBlock: from, toBlock: to });
        for (const log of logs) {
          let ev;
          try {
            ev = decodeEventLog({ abi: CALLBACKS, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          const id = ev.args.orderId;
          const waiter = pendingOrders.get(id);
          if (waiter) {
            pendingOrders.delete(id);
            waiter.resolve(ev);
          } else earlyEvents.set(id, ev);
        }
        cursor = to;
      }
    } catch (err) {
      stats.harnessRpcErrors++;
    }
    await sleep(1000);
  }
}

function awaitReceipt(hash) {
  return new Promise((resolve, reject) => {
    pendingTx.set(hash, { resolve, reject });
    // The block scan can miss a transaction mined before it was registered; after 15 s ask
    // for the receipt directly.
    const started = Date.now();
    const fallback = async () => {
      if (!pendingTx.has(hash)) return;
      const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
      if (r && pendingTx.delete(hash)) return resolve(r);
      if (Date.now() - started > 120_000 && pendingTx.delete(hash)) return reject(new Error(`tx ${hash} not mined in 120 s`));
      setTimeout(fallback, 3000);
    };
    setTimeout(fallback, 15_000);
  });
}

function awaitOrder(orderId) {
  if (earlyEvents.has(orderId)) {
    const ev = earlyEvents.get(orderId);
    earlyEvents.delete(orderId);
    return Promise.resolve(ev);
  }
  return new Promise((resolve) => {
    pendingOrders.set(orderId, { resolve });
    setTimeout(() => {
      if (pendingOrders.delete(orderId)) resolve(null);
    }, FILL_TIMEOUT_MS);
  });
}

// ── signing with local nonces and fixed gas: no estimate / nonce round trip per tx ─────────
// Each account broadcasts in nonce order through its own queue. Sent concurrently, a
// funder's transactions reached the node out of order and the later nonces sat queued behind
// a gap — the run then waited on receipts that never came.
const queues = new Map();
function broadcastInOrder(account, build) {
  const prev = queues.get(account.address) ?? pub.getTransactionCount({ address: account.address, blockTag: 'pending' }).then((n) => ({ next: n }));
  const done = prev.then(async ({ next }) => {
    const raw = await build(next);
    for (let attempt = 0; ; attempt++) {
      try {
        await pub.request({ method: 'eth_sendRawTransaction', params: [raw] });
        break;
      } catch (err) {
        // A retried broadcast of a transaction the node already took is not a failure.
        const msg = `${err.details ?? ''} ${err.message ?? ''}`;
        if (/already known/i.test(msg)) break;
        if (attempt >= 5) {
          console.error(`broadcast from ${account.address} nonce ${next} failed: ${msg.slice(0, 200)}`);
          throw err;
        }
        await sleep(1000 * (attempt + 1));
      }
    }
    return { next: next + 1, raw };
  });
  // A failed broadcast must not wedge the queue: the nonce it held is reused.
  queues.set(account.address, done.catch(() => prev));
  return done.then(({ raw }) => raw);
}
async function sendTx(account, to, data, { value = 0n, gas = 2_000_000n } = {}) {
  const raw = await broadcastInOrder(account, (nonce) => account.signTransaction({ to, data, value, gas, gasPrice, nonce, chainId, type: 'legacy' }));
  const hash = keccak256(raw);
  const receipt = await awaitReceipt(hash);
  if (receipt.status !== 'success') {
    stats.txReverted.push(hash);
    throw new Error(`reverted ${hash}`);
  }
  return receipt;
}

function eventIn(receipt, name) {
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: TRADING, data: log.data, topics: log.topics });
      if (ev.eventName === name) return ev;
    } catch {}
  }
  return null;
}

async function mark(pair) {
  const res = await fetch(`${PUBLISHER_URL}/status`);
  const body = await res.json();
  return BigInt(body.feeds[manifest.markets[pair].feedId].mark);
}

// ── API / WS read load at the web app's intervals ───────────────────────────────────────
async function apiGet(path) {
  const t0 = performance.now();
  stats.api.calls++;
  try {
    const res = await fetch(`${API_URL}${path}`);
    await res.arrayBuffer();
    stats.api.latency.push(performance.now() - t0);
    stats.api.byStatus[res.status] = (stats.api.byStatus[res.status] ?? 0) + 1;
    if (res.status !== 200) {
      stats.api.errors++;
      if (stats.api.errorSamples.length < 10) stats.api.errorSamples.push(`${res.status} ${path}`);
    }
  } catch (err) {
    stats.api.errors++;
    if (stats.api.errorSamples.length < 10) stats.api.errorSamples.push(`${err.message} ${path}`);
  }
}

function startReader(user) {
  const a = user.trader.address;
  const timers = [
    setInterval(() => { apiGet(`/orders/${a}`); apiGet(`/price/${user.pair}`); }, 3000),
    setInterval(() => { apiGet(`/positions/${a}`); apiGet('/markets'); }, 5000),
    setInterval(() => {
      apiGet(`/orders/${a}/history?limit=100`);
      apiGet(`/positions/${a}/history`);
      apiGet(`/fees/${a}?limit=200`);
      apiGet(`/pnl/${a}`);
      apiGet(`/limit-orders/${a}`);
    }, 15000),
  ];
  let ws;
  let stopping = false;
  const connect = () => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      stats.ws.opened++;
      for (const ch of [`orders:${a}`, `positions:${a}`, `limitOrders:${a}`, `fees:${a}`, `price:${user.pair}`]) ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
    };
    ws.onmessage = () => stats.ws.messages++;
    ws.onerror = () => stats.ws.errors++;
    ws.onclose = (e) => {
      if (stopping) return;
      // 1013 is the API's per-address connection cap: every simulated trader shares this
      // machine's address, which real traders do not, so it is reported apart from drops.
      stats.ws.closeCodes[e.code] = (stats.ws.closeCodes[e.code] ?? 0) + 1;
      if (e.code === 1013) return;
      stats.ws.closedUnexpectedly++;
      setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    stopping = true;
    timers.forEach(clearInterval);
    ws.close();
  };
}

async function health() {
  while (watching) {
    try {
      const res = await fetch(`${API_URL}/health`);
      const h = await res.json();
      if (typeof h.lagSeconds === 'number') {
        stats.lagSamples.push(h.lagSeconds);
        stats.maxLagSeconds = Math.max(stats.maxLagSeconds, h.lagSeconds);
      }
    } catch {}
    await sleep(5000);
  }
}

// ── trading ─────────────────────────────────────────────────────────────────────────────
function tradingCall(user, functionName, args) {
  const data = encodeFunctionData({ abi: TRADING, functionName, args });
  if (!user.session) return sendTx(user.trader, C.trading, data);
  return sendTx(user.session, C.trading, encodeFunctionData({ abi: TRADING, functionName: 'delegatedAction', args: [user.trader.address, data] }));
}

async function openPosition(user, round) {
  const pair = user.pair;
  const buy = Math.random() < 0.5;
  const collateral = BigInt(rand(20, 60)) * E6;
  const leverage = rand(2, 20) * 100;
  const t = { collateral, openPrice: await mark(pair), tp: 0n, sl: 0n, trader: user.trader.address, leverage, pairIndex: pair, index: 0, buy, isDayTrade: false };
  const sentAt = Date.now();
  const receipt = await tradingCall(user, 'openTrade', [t, { builder: ZERO, builderFee: 0 }, 0, 100n]);
  const req = eventIn(receipt, 'MarketOpenOrderInitiated');
  const ev = await awaitOrder(req.args.orderId);
  const tag = { user: user.n, round, kind: 'open', orderId: req.args.orderId.toString() };
  if (!ev) return void stats.neverFilled.push(tag);
  if (ev.eventName === 'MarketOpenCanceled') return void stats.cancels.push({ ...tag, reason: CANCEL_REASONS[ev.args.cancelReason] });
  stats.fills.open.push(Date.now() - sentAt);
  user.orderIds.push(tag.orderId);
  return { pair, index: ev.args.t.index };
}

async function closePosition(user, pos, round, percentage) {
  const sentAt = Date.now();
  const receipt = await tradingCall(user, 'closeTradeMarket', [pos.pair, pos.index, percentage, await mark(pos.pair), 200]);
  const req = eventIn(receipt, 'MarketCloseOrderInitiatedV2');
  const ev = await awaitOrder(req.args.orderId);
  const tag = { user: user.n, round, kind: percentage === 10_000 ? 'close' : 'partial', orderId: req.args.orderId.toString() };
  if (!ev) return void stats.neverFilled.push(tag);
  if (ev.eventName === 'MarketCloseCanceled') return void stats.cancels.push({ ...tag, reason: CANCEL_REASONS[ev.args.cancelReason] });
  stats.fills.close.push(Date.now() - sentAt);
  user.orderIds.push(tag.orderId);
  return true;
}

async function trade(user, startAt) {
  for (let round = 1; round <= ROUNDS; round++) {
    if (round === 1) await sleep(Math.max(0, startAt - Date.now()));
    else await sleep(rand(1000, 8000));
    try {
      const pos = await openPosition(user, round);
      if (!pos) continue;
      await sleep(rand(3000, 10000));
      if (round % 2 === 0) await closePosition(user, pos, round, 5000);
      let closed = await closePosition(user, pos, round, 10_000);
      // A close that did not fill leaves the position open; retry once so the run ends flat.
      if (!closed) closed = await closePosition(user, pos, round, 10_000);
      if (!closed) user.leftOpen.push(pos);
    } catch (err) {
      user.errors.push(`round ${round}: ${err.shortMessage ?? err.message}`);
    }
  }
}

// ── setup ───────────────────────────────────────────────────────────────────────────────
async function setup() {
  const users = Array.from({ length: USERS }, (_, i) => ({
    n: i,
    trader: privateKeyToAccount(generatePrivateKey()),
    session: i % 2 === 0 ? privateKeyToAccount(generatePrivateKey()) : null,
    pair: i % 3, // BTC, ETH, SOL
    orderIds: [],
    errors: [],
    leftOpen: [],
  }));
  const owner = await pub.readContract({ address: C.collateral, abi: ERC20, functionName: 'owner' }).catch(() => null);
  const mints = owner?.toLowerCase() === funder.address.toLowerCase();
  // Funder transactions are pipelined with consecutive nonces, then awaited together.
  const sends = [];
  for (const u of users) {
    sends.push(sendTx(gasFunder, u.trader.address, '0x', { value: parseEther('0.08'), gas: 21_000n }));
    if (u.session) sends.push(sendTx(gasFunder, u.session.address, '0x', { value: parseEther('0.08'), gas: 21_000n }));
    const data = encodeFunctionData({ abi: ERC20, functionName: mints ? 'mint' : 'transfer', args: [u.trader.address, 1_000n * E6] });
    sends.push(sendTx(funder, C.collateral, data, { gas: 150_000n }));
  }
  await Promise.all(sends);
  await Promise.all(
    users.map(async (u) => {
      await sendTx(u.trader, C.collateral, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [C.tradingStorage, 2n ** 255n] }), { gas: 100_000n });
      if (u.session) await sendTx(u.trader, C.trading, encodeFunctionData({ abi: TRADING, functionName: 'setDelegate', args: [u.session.address] }), { gas: 200_000n });
    }),
  );
  return users;
}

// ── consistency: the API must agree with what the chain did ─────────────────────────────
async function consistency(users) {
  const problems = [];
  const deadline = Date.now() + 90_000;
  for (const u of users) {
    const a = u.trader.address;
    for (;;) {
      const [positions, orders, history] = await Promise.all(
        [`/positions/${a}`, `/orders/${a}`, `/orders/${a}/history?limit=500`].map((p) => fetch(`${API_URL}${p}`).then((r) => r.json())),
      );
      const issues = [];
      const expectOpen = u.leftOpen.length;
      if (positions.length !== expectOpen) issues.push(`${positions.length} open positions in the API, expected ${expectOpen}`);
      const pending = orders.filter((o) => o.status === 'pending');
      if (pending.length) issues.push(`${pending.length} orders still pending`);
      for (const id of u.orderIds) {
        const row = history.find((h) => h.orderId === id);
        if (!row) issues.push(`order ${id} missing from history`);
        else if (row.status !== 'executed') issues.push(`order ${id} is ${row.status} in history`);
        else if (row.price === null || row.buy === null || row.leverage === null) issues.push(`order ${id} history row lacks price/side/leverage`);
      }
      if (!issues.length) break;
      if (Date.now() > deadline) {
        problems.push({ user: u.n, address: a, issues });
        break;
      }
      await sleep(3000);
    }
  }
  return problems;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
watcher();
console.log(`load: ${USERS} traders × ${ROUNDS} rounds, rpc ${RPC_URL}, api ${API_URL}`);
const users = await setup();
console.log(`setup done in ${((Date.now() - t0) / 1000).toFixed(0)} s (funded, approved, ${users.filter((u) => u.session).length} one-click sessions)`);

const stopReaders = users.map(startReader);
health();
const startAt = Date.now() + 3000;
const tradeStart = Date.now();
await Promise.all(users.map((u) => trade(u, startAt)));
const tradeSeconds = (Date.now() - tradeStart) / 1000;
await sleep(5000);
stopReaders.forEach((s) => s());

const problems = await consistency(users);

// Return what gas is left to the wallet that paid it, so repeated runs do not drain it.
async function sweep(account) {
  const balance = await pub.getBalance({ address: account.address });
  // Twice the L2 fee: on this OP Stack chain an L1 data fee comes on top of gas × price.
  const fee = 2n * 21_000n * gasPrice;
  if (balance <= fee) return;
  await sendTx(account, gasFunder.address, '0x', { value: balance - fee, gas: 21_000n }).catch(() => {});
}
await Promise.all(users.flatMap((u) => [u.trader, u.session].filter(Boolean)).map(sweep));
watching = false;

const ms = (x) => (x === null ? '—' : `${(x / 1000).toFixed(1)} s`);
const report = {
  traders: USERS,
  rounds: ROUNDS,
  tradingSeconds: Math.round(tradeSeconds),
  fills: {
    open: { n: stats.fills.open.length, p50: ms(pct(stats.fills.open, 50)), p95: ms(pct(stats.fills.open, 95)), max: ms(pct(stats.fills.open, 100)) },
    close: { n: stats.fills.close.length, p50: ms(pct(stats.fills.close, 50)), p95: ms(pct(stats.fills.close, 95)), max: ms(pct(stats.fills.close, 100)) },
  },
  cancels: stats.cancels,
  neverFilled: stats.neverFilled,
  txReverted: stats.txReverted,
  traderErrors: users.flatMap((u) => u.errors.map((e) => `user ${u.n}: ${e}`)),
  leftOpen: users.flatMap((u) => u.leftOpen.map((p) => ({ user: u.n, ...p }))),
  api: {
    calls: stats.api.calls,
    errors: stats.api.errors,
    byStatus: stats.api.byStatus,
    p50ms: Math.round(pct(stats.api.latency, 50) ?? 0),
    p95ms: Math.round(pct(stats.api.latency, 95) ?? 0),
    maxms: Math.round(pct(stats.api.latency, 100) ?? 0),
    errorSamples: stats.api.errorSamples,
  },
  ws: stats.ws,
  indexerLag: { max: stats.maxLagSeconds, p95: pct(stats.lagSamples, 95) },
  harnessRpcErrors: stats.harnessRpcErrors,
  consistencyProblems: problems,
};
console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
const failed = stats.neverFilled.length || stats.txReverted.length || problems.length || report.traderErrors.length || stats.api.errors;
process.exit(failed ? 1 : 0);
