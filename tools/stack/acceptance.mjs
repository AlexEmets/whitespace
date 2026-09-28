#!/usr/bin/env node
/**
 * Acceptance run for spec 2026-09-28-testnet-perfect-design.md §2: drives every user-facing
 * feature against a running stack (chain + keeper + publisher + indexer + api + automation
 * bots) and VERIFIES each by reading state back from the chain and from the API. A mined
 * transaction is never counted as evidence.
 *
 * Works against a local anvil (see docs/runbooks/redeploy-testnet-1874.md "Acceptance run")
 * and against 1874 itself. Every run trades from a fresh random wallet funded by
 * ACCEPT_FUNDER_KEY, so the API's per-address history holds exactly this run's actions and
 * can be compared one for one. The wallet's key lives in memory only.
 *
 * Env:
 *   ACCEPT_RPC_URL        JSON-RPC                                (default http://127.0.0.1:8545)
 *   ACCEPT_API_URL        services/api base URL                   (default http://127.0.0.1:4000)
 *   ACCEPT_PUBLISHER_URL  services/price-publisher base URL       (default http://127.0.0.1:8787)
 *   ACCEPT_MANIFEST       deployment manifest                     (default deployments/1874.json)
 *   ACCEPT_FUNDER_KEY     REQUIRED role-key file: pays gas to the test wallets and mints USDW
 *                         (the USDW owner) or, failing that, transfers its own USDW
 *   ACCEPT_GAS_AMOUNT     native coin sent to each test wallet    (default 0.05)
 *   ACCEPT_GOV_KEY        role-key file of registry gov: the vault item settles with
 *                         forceSettlement(). Without it the item waits for the interval and
 *                         calls tryNewSettlement() (up to maxSettlementInterval)
 *   ACCEPT_HOOKS          executable called as `$ACCEPT_HOOKS <action> [args]` for the items
 *                         that need the stack itself changed:
 *                           keeper-stop | keeper-start        (timeout reclaim)
 *                           degrade | restore                 (degraded mode)
 *                           shift <feed> <bps> | unshift      (liquidation, anvil only)
 *                         Items whose hook is missing are SKIPPED, never passed.
 *   ACCEPT_LIQ_PAIR       pair index for the liquidation item     (default 2, SOL/USD)
 *   ACCEPT_LIQ_WAIT_S     seconds to wait for a natural liquidating move before the
 *                         `shift` hook is used                    (default 120)
 *   ACCEPT_ONLY           comma list of item ids to run (history always needs the others)
 *   ACCEPT_OUT            write the results as JSON here
 *
 * Exit code: 0 when nothing FAILED, 1 otherwise.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// viem is not a root dependency; borrow the keeper's copy (same as tools/deploy/manifest.mjs).
const require = createRequire(new URL('../../services/keeper/package.json', import.meta.url));
const viemMain = require.resolve('viem');
const viem = await import(pathToFileURL(viemMain).href);
const { privateKeyToAccount, generatePrivateKey } = await import(
  pathToFileURL(join(dirname(viemMain), 'accounts', 'index.js')).href
);
const { createPublicClient, createWalletClient, http, parseAbi, parseEther, defineChain, decodeEventLog } = viem;

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const RPC_URL = env.ACCEPT_RPC_URL ?? 'http://127.0.0.1:8545';
const API_URL = (env.ACCEPT_API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const PUBLISHER_URL = (env.ACCEPT_PUBLISHER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(env.ACCEPT_MANIFEST ?? join(REPO, 'deployments/1874.json'), 'utf8'));
const C = manifest.contracts;
const ONLY = env.ACCEPT_ONLY ? new Set(env.ACCEPT_ONLY.split(',').map((s) => s.trim())) : null;
const LIQ_PAIR = Number(env.ACCEPT_LIQ_PAIR ?? 2);
const LIQ_WAIT_S = Number(env.ACCEPT_LIQ_WAIT_S ?? 120);

function loadKey(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const e = Array.isArray(raw) ? raw[0] : raw;
  return privateKeyToAccount(e.private_key);
}
if (!env.ACCEPT_FUNDER_KEY) {
  console.error('ACCEPT_FUNDER_KEY is required');
  process.exit(2);
}
const funder = loadKey(env.ACCEPT_FUNDER_KEY);
const gov = env.ACCEPT_GOV_KEY ? loadKey(env.ACCEPT_GOV_KEY) : null;

// ---------------------------------------------------------------------------------------
// ABIs — transcribed from contracts/src/vendor/ostium/interfaces (same shapes as apps/web/src/lib/abi.ts)
// ---------------------------------------------------------------------------------------

const TRADE = '(uint256 collateral,uint192 openPrice,uint192 tp,uint192 sl,address trader,uint32 leverage,uint16 pairIndex,uint8 index,bool buy,bool isDayTrade)';
const PMO = `(uint256 block,uint192 wantedPrice,uint32 slippageP,${TRADE} trade,uint16 percentage)`;
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function owner() view returns (address)',
  'function mint(address,uint256)',
]);
const TRADING = parseAbi([
  `function openTrade(${TRADE} t, (address builder,uint32 builderFee) bf, uint8 orderType, uint256 slippageP)`,
  'function closeTradeMarket(uint16 pairIndex, uint8 index, uint16 closePercentage, uint192 marketPrice, uint32 slippageP)',
  'function openTradeMarketTimeout(uint256 _order)',
  'function closeTradeMarketTimeout(uint256 _order, bool retry)',
  'function marketOrdersTimeout() view returns (uint16)',
  'function updateTp(uint16 pairIndex, uint8 index, uint192 newTp)',
  'function updateSl(uint16 pairIndex, uint8 index, uint192 newSl)',
  'function topUpCollateral(uint16 pairIndex, uint8 index, uint256 topUpAmount)',
  'function removeCollateral(uint16 pairIndex, uint8 index, uint256 removeAmount)',
  'function updateOpenLimitOrder(uint16 pairIndex, uint8 index, uint192 price, uint192 tp, uint192 sl)',
  'function cancelOpenLimitOrder(uint16 pairIndex, uint8 index)',
  'event MarketOpenOrderInitiated(uint256 indexed orderId, address indexed trader, uint16 indexed pairIndex)',
  'event MarketCloseOrderInitiatedV2(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint16 closePercentage)',
  `event OpenLimitPlacedV2(address indexed trader, uint16 indexed pairIndex, uint8 index, ${TRADE} trade, uint8 orderType, (address builder,uint32 builderFee) builderFee)`,
  'event OpenLimitUpdated(address indexed trader, uint16 indexed pairIndex, uint8 index, uint192 newPrice, uint192 newTp, uint192 newSl)',
  'event OpenLimitCanceled(address indexed trader, uint16 indexed pairIndex, uint8 index)',
  'event AutomationOpenOrderInitiated(uint256 indexed orderId, address indexed trader, uint16 indexed pairIndex, uint8 index)',
  'event AutomationCloseOrderInitiated(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint8 orderType)',
  `event MarketOpenTimeoutExecutedV2(uint256 indexed orderId, ${PMO} order)`,
  `event MarketCloseTimeoutExecutedV2(uint256 indexed orderId, uint256 indexed tradeId, ${PMO} order)`,
  'event RemoveCollateralInitiated(uint256 indexed tradeId, uint256 indexed orderId, address indexed trader, uint16 pairIndex, uint256 removeAmount)',
  'event OracleFeeCharged(uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint256 amount)',
  'event OracleFeeChargedLimitCancelled(address indexed trader, uint16 pairIndex, uint256 amount)',
]);
const CALLBACKS = parseAbi([
  `event MarketOpenExecuted(uint256 indexed orderId, ${TRADE} t, uint256 priceImpactP, uint256 tradeNotional)`,
  'event MarketCloseExecutedV2(uint256 indexed orderId, uint256 indexed tradeId, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 percentageClosed)',
  `event LimitOpenExecuted(uint256 indexed orderId, uint256 limitIndex, ${TRADE} t, uint256 priceImpactP, uint256 tradeNotional)`,
  'event LimitCloseExecuted(uint256 indexed orderId, uint256 indexed tradeId, uint8 orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader)',
  'event MarketOpenCanceled(uint256 indexed orderId, address indexed trader, uint256 indexed pairIndex, uint8 cancelReason)',
  'event MarketCloseCanceled(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint256 pairIndex, uint256 index, uint8 cancelReason)',
  'event AutomationOpenOrderCanceled(uint256 indexed orderId, address indexed trader, uint256 indexed pairIndex, uint8 cancelReason)',
  'event AutomationCloseOrderCanceled(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint256 pairIndex, uint8 orderType, uint8 cancelReason)',
  'event RemoveCollateralExecuted(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint256 removeAmount, uint32 leverage, uint192 tp, uint192 sl)',
  'event RemoveCollateralRejected(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint16 pairIndex, uint256 removeAmount, uint8 reason)',
  'event DevFeeCharged(uint256 indexed tradeId, address indexed trader, uint256 amount)',
  'event OracleFeeCharged(uint256 indexed tradeId, address indexed trader, uint256 amount)',
  'event OracleFeeBondCharged(uint256 indexed tradeId, address indexed trader, uint256 collateral, uint32 leverage, uint192 tp, uint192 sl)',
  'event VaultOpeningFeeCharged(uint256 indexed tradeId, address indexed trader, uint256 amount)',
  'event VaultLiqFeeCharged(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, uint256 amount)',
  'event FeesChargedV2(uint256 indexed orderId, uint256 indexed tradeId, address indexed trader, int256 rolloverFees, int256 fundingFees)',
]);
const STORAGE = parseAbi([
  `function getOpenTrade(address, uint16, uint8) view returns (${TRADE})`,
  'function getOpenTradeInfo(address, uint16, uint8) view returns ((uint256 tradeId,uint256 oiNotional,uint32 initialLeverage,uint32 tpLastUpdated,uint32 slLastUpdated,uint32 createdAt,bool deprecatedBeingMarketClosed))',
  'function hasOpenLimitOrder(address, uint16, uint8) view returns (bool)',
  'function getOpenLimitOrder(address, uint16, uint8) view returns ((uint256 collateral,uint192 targetPrice,uint192 tp,uint192 sl,address trader,uint32 leverage,uint32 createdAt,uint32 lastUpdated,uint16 pairIndex,uint8 orderType,uint8 index,bool buy,bool isDayTrade))',
  `function reqID_pendingMarketOrder(uint256) view returns (uint256 block, uint192 wantedPrice, uint32 slippageP, ${TRADE} trade, uint16 percentage)`,
  'function maxTradesPerPair() view returns (uint8)',
  'function openLimitOrdersCount(address, uint16) view returns (uint8)',
]);
const PAIRS = parseAbi(['function pairMaxLeverage(uint16) view returns (uint256)', 'function pairOracleFee(uint16) view returns (uint256)']);
const VAULT = parseAbi([
  'function requestDeposit(uint256 assets)',
  'function requestWithdraw(uint256 shares)',
  'function cancelRequestDeposit(uint32 settlementId, uint256 assets)',
  'function claimDeposit(uint32 settlementId)',
  'function claimWithdraw(uint32 settlementId)',
  'function targetSettlementId(bool isDeposit) view returns (uint32)',
  'function getDepositStatus(address owner, uint32 settlementId) view returns (uint8)',
  'function getWithdrawStatus(address owner, uint32 settlementId) view returns (uint8)',
  'function pendingDepositRequest(address, uint32) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function forceSettlement()',
  'function reclaimDeposit(uint32 settlementId)',
  'function effectiveAccPnlPerTokenUsed() view returns (int256)',
  'function tryNewSettlement()',
  'function lastSettlementId() view returns (uint32)',
  'function lastSettlementTs() view returns (uint32)',
  'function maxSettlementInterval() view returns (uint32)',
  'function settlementShareToAssetsPrice(uint32) view returns (uint256)',
]);
const REQ = ['NONE', 'PENDING', 'CLAIMABLE', 'RECLAIMABLE'];
const CANCEL_REASONS = ['NONE', 'PAUSED', 'MARKET_CLOSED', 'SLIPPAGE', 'TP_REACHED', 'SL_REACHED', 'EXPOSURE_LIMITS', 'PRICE_IMPACT', 'MAX_LEVERAGE', 'NO_TRADE', 'UNDER_LIQUIDATION', 'NOT_HIT', 'GAIN_LOSS', 'DAY_TRADE_NOT_ALLOWED', 'CLOSE_DAY_TRADE_NOT_ALLOWED', 'WRONG_TRADE'];
const LIMIT_KIND = ['TP', 'SL', 'LIQ', 'OPEN'];
const MARKET = 0, LIMIT = 1, STOP = 2;

// ---------------------------------------------------------------------------------------
// Chain plumbing
// ---------------------------------------------------------------------------------------

const probe = createPublicClient({ transport: http(RPC_URL) });
const chainId = await probe.getChainId();
if (chainId !== manifest.chainId) throw new Error(`RPC is chain ${chainId}, manifest is ${manifest.chainId}`);
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'native', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 500 });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC_URL) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

/** Simulate (for a readable revert), send as a legacy tx, wait, require success.
 *
 * Gas is the estimate plus 30%. An estimate is run against the LATEST block, and several
 * calls here write `block.timestamp` (updateTp/updateSl store tpLastUpdated/slLastUpdated):
 * sent in the same second the trade was opened, the estimate sees a same-value SSTORE and
 * comes out ~2.9k gas short of the real inclusion one block later — observed as an
 * out-of-gas updateTp on the anvil run. */
async function send(account, address, abi, functionName, args = []) {
  await pub.simulateContract({ account, address, abi, functionName, args });
  const estimate = await pub.estimateContractGas({ account, address, abi, functionName, args });
  const hash = await wallet(account).writeContract({ address, abi, functionName, args, type: 'legacy', gas: (estimate * 13n) / 10n, gasPrice: await pub.getGasPrice() });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
  return receipt;
}

function decodeLogs(receipt, abi) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      out.push({ ...decodeEventLog({ abi, data: log.data, topics: log.topics }), log });
    } catch {}
  }
  return out;
}

async function logsSince(address, abi, fromBlock) {
  const logs = await pub.getLogs({ address, fromBlock, toBlock: 'latest' });
  return decodeLogs({ logs }, abi);
}

async function waitFor(what, fn, timeoutMs = 60_000, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

async function waitBlocks(n) {
  const target = (await pub.getBlockNumber()) + BigInt(n);
  await waitFor(`block ${target}`, async () => (await pub.getBlockNumber()) >= target, 20_000 + n * 3000);
}

// ---------------------------------------------------------------------------------------
// Off-chain reads
// ---------------------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function api(path) {
  const { status, body } = await getJson(`${API_URL}${path}`);
  if (status !== 200) throw new Error(`GET ${path} -> ${status} ${JSON.stringify(body)}`);
  return body;
}
const feedOf = (pair) => manifest.markets[pair].feedId;
async function quote(pair) {
  const { body } = await getJson(`${PUBLISHER_URL}/status`);
  const f = body.feeds[feedOf(pair)];
  if (!f?.mark) throw new Error(`publisher has no mark for ${feedOf(pair)}`);
  return { mark: BigInt(f.mark), bid: BigInt(f.indexBid ?? f.mark), ask: BigInt(f.indexAsk ?? f.mark), degraded: f.degraded };
}

/** "123.456" (API decimal string) -> bigint in `decimals` units. */
function units(s, decimals) {
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return neg ? -v : v;
}
const bps = (x, b) => (x * BigInt(10_000 + b)) / 10_000n;
const usd = (v) => `${Number(v) / 1e6}`;
const px = (v) => `${Number(v / 10n ** 12n) / 1e6}`;

// ---------------------------------------------------------------------------------------
// Trader actions (each returns only once the chain has resolved it)
// ---------------------------------------------------------------------------------------

const ctx = { ledger: [], opens: [] };

async function openMarket(account, { pair, buy = true, collateral, leverage, tp = 0n, sl = 0n, slippageP = 100 }) {
  const { mark } = await quote(pair);
  const t = { collateral, openPrice: mark, tp, sl, trader: account.address, leverage, pairIndex: pair, index: 0, buy, isDayTrade: false };
  const receipt = await send(account, C.trading, TRADING, 'openTrade', [t, { builder: '0x0000000000000000000000000000000000000000', builderFee: 0 }, MARKET, BigInt(slippageP)]);
  const ev = decodeLogs(receipt, TRADING).find((e) => e.eventName === 'MarketOpenOrderInitiated');
  return { orderId: ev.args.orderId, tx: receipt.transactionHash, block: receipt.blockNumber, wanted: mark, slippageP };
}

/** Waits for the callback of a market open; returns the stored trade or throws with the cancel reason. */
async function awaitOpen(account, req, timeoutMs = 45_000) {
  const res = await waitFor(`open order ${req.orderId}`, async () => {
    const evs = await logsSince(C.callbacks, CALLBACKS, req.block);
    return evs.find((e) => e.args.orderId === req.orderId && (e.eventName === 'MarketOpenExecuted' || e.eventName === 'MarketOpenCanceled'));
  }, timeoutMs);
  if (res.eventName === 'MarketOpenCanceled') throw new Error(`open ${req.orderId} cancelled: ${CANCEL_REASONS[res.args.cancelReason]}`);
  const t = res.args.t;
  const info = await read(C.tradingStorage, STORAGE, 'getOpenTradeInfo', [account.address, t.pairIndex, t.index]);
  const trade = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [account.address, t.pairIndex, t.index]);
  if (trade.leverage === 0) throw new Error(`open ${req.orderId} executed but no trade stored at index ${t.index}`);
  ctx.opens.push({ orderId: req.orderId, wanted: req.wanted, slippageP: req.slippageP, buy: t.buy, openPrice: t.openPrice, fillTx: res.log.transactionHash });
  return { ...trade, tradeId: info.tradeId, fillTx: res.log.transactionHash };
}

async function open(account, spec) {
  return awaitOpen(account, await openMarket(account, spec));
}

async function requestClose(account, trade, pct = 10_000) {
  const { mark } = await quote(trade.pairIndex);
  const receipt = await send(account, C.trading, TRADING, 'closeTradeMarket', [trade.pairIndex, trade.index, pct, mark, 200]);
  const ev = decodeLogs(receipt, TRADING).find((e) => e.eventName === 'MarketCloseOrderInitiatedV2');
  return { orderId: ev.args.orderId, tx: receipt.transactionHash, block: receipt.blockNumber };
}

/** Full or partial market close; records the realised row in the ledger. */
async function close(account, trade, pct = 10_000) {
  const before = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [account.address, trade.pairIndex, trade.index]);
  const req = await requestClose(account, trade, pct);
  const res = await waitFor(`close order ${req.orderId}`, async () => {
    const evs = await logsSince(C.callbacks, CALLBACKS, req.block);
    return evs.find((e) => e.args.orderId === req.orderId && (e.eventName === 'MarketCloseExecutedV2' || e.eventName === 'MarketCloseCanceled'));
  }, 45_000);
  if (res.eventName === 'MarketCloseCanceled') throw new Error(`close ${req.orderId} cancelled: ${CANCEL_REASONS[res.args.cancelReason]}`);
  const closed = pct === 10_000 ? before.collateral : (before.collateral * BigInt(pct)) / 10_000n;
  ctx.ledger.push({ tradeId: trade.tradeId, closeOrderId: req.orderId, collateralClosed: closed, usdcSent: res.args.usdcSentToTrader, reason: 'close', partial: pct !== 10_000 });
  return { ...req, fillTx: res.log.transactionHash, usdcSent: res.args.usdcSentToTrader, closePrice: res.args.price };
}

/** Waits for the automation bots to close a trade (TP/SL/LIQ) and records it. */
async function awaitAutomationClose(account, trade, kind, fromBlock, timeoutMs) {
  const before = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [account.address, trade.pairIndex, trade.index]);
  const ev = await waitFor(`${kind} close of trade ${trade.tradeId}`, async () => {
    const evs = await logsSince(C.callbacks, CALLBACKS, fromBlock);
    return evs.find((e) => e.eventName === 'LimitCloseExecuted' && e.args.tradeId === trade.tradeId);
  }, timeoutMs, 1500);
  const got = LIMIT_KIND[ev.args.orderType];
  ctx.ledger.push({ tradeId: trade.tradeId, closeOrderId: ev.args.orderId, collateralClosed: before.collateral, usdcSent: ev.args.usdcSentToTrader, reason: got.toLowerCase(), partial: false });
  const upkeepTx = await pub.getTransaction({ hash: (await findAutomationRequestTx(ev.args.orderId, fromBlock)) });
  return { orderId: ev.args.orderId, kind: got, fillTx: ev.log.transactionHash, usdcSent: ev.args.usdcSentToTrader, price: ev.args.price, triggeredBy: upkeepTx.from };
}

async function findAutomationRequestTx(orderId, fromBlock) {
  const evs = await logsSince(C.trading, TRADING, fromBlock);
  const e = evs.find((x) => (x.eventName === 'AutomationCloseOrderInitiated' || x.eventName === 'AutomationOpenOrderInitiated') && x.args.orderId === orderId);
  return e.log.transactionHash;
}

async function apiPosition(account, tradeId) {
  const rows = await api(`/positions/${account.address}`);
  return rows.find((r) => r.tradeId === tradeId.toString()) ?? null;
}
async function apiHistoryRow(account, closeOrderId) {
  const rows = await api(`/positions/${account.address}/history`);
  return rows.find((r) => r.closeOrderId === closeOrderId.toString()) ?? null;
}

function hook(action, ...args) {
  if (!env.ACCEPT_HOOKS) return false;
  const r = spawnSync(env.ACCEPT_HOOKS, [action, ...args.map(String)], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 180_000 });
  if (r.status !== 0) throw new Error(`hook ${action} exited ${r.status}`);
  return true;
}

// ---------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------

const results = [];
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function item(id, title, fn) {
  if (ONLY && !ONLY.has(id)) return;
  const started = Date.now();
  process.stdout.write(`\n== ${id}: ${title}\n`);
  try {
    const evidence = await fn();
    if (evidence && evidence.skip) {
      results.push({ id, title, status: 'SKIP', evidence: evidence.skip });
      console.log(`   SKIP ${evidence.skip}`);
    } else {
      results.push({ id, title, status: 'PASS', evidence });
      console.log(`   PASS ${JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    }
  } catch (err) {
    results.push({ id, title, status: 'FAIL', evidence: err.message });
    console.log(`   FAIL ${err.stack ?? err.message}`);
  }
  results.at(-1).seconds = Math.round((Date.now() - started) / 1000);
}

async function fundWallet(account, usdw) {
  const gas = parseEther(env.ACCEPT_GAS_AMOUNT ?? '0.05');
  const h = await wallet(funder).sendTransaction({ to: account.address, value: gas, type: 'legacy', gasPrice: await pub.getGasPrice() });
  await pub.waitForTransactionReceipt({ hash: h });
  const owner = await read(C.collateral, ERC20, 'owner').catch(() => null);
  if (owner && owner.toLowerCase() === funder.address.toLowerCase()) {
    await send(funder, C.collateral, ERC20, 'mint', [account.address, usdw]);
  } else {
    await send(funder, C.collateral, ERC20, 'transfer', [account.address, usdw]);
  }
}

const usdwOf = (a) => read(C.collateral, ERC20, 'balanceOf', [a]);
const E6 = 10n ** 6n;

async function main() {
  const trader = privateKeyToAccount(generatePrivateKey());
  const lp = privateKeyToAccount(generatePrivateKey());
  console.log(`chain ${chainId} rpc ${RPC_URL} api ${API_URL} publisher ${PUBLISHER_URL}`);
  console.log(`trader ${trader.address} (fresh, key in memory only)  lp ${lp.address}`);
  const health = await api('/health');
  console.log(`api health ${JSON.stringify(health)}`);
  const startBlock = await pub.getBlockNumber();

  await fundWallet(trader, 20_000n * E6);
  await fundWallet(lp, 5_000n * E6);
  await send(trader, C.collateral, ERC20, 'approve', [C.tradingStorage, 2n ** 255n]);
  const timeoutBlocks = Number(await read(C.trading, TRADING, 'marketOrdersTimeout'));

  // 0 ── LP vault ──────────────────────────────────────────────────────────────────────
  // Runs before any trading: a settlement accepts deposits only while the vault's buffer is
  // not negative (OstiumVault._maxMint returns 0 when effectiveAccPnlPerTokenUsed() > 0, i.e.
  // traders are in net open profit), and a refused request becomes RECLAIMABLE instead.
  await item('vault', 'LP deposit request, cancel part, settlement, claim (or reclaim); withdraw request, settlement, claim', async () => {
    const settle = async () => {
      if (gov) return (await send(gov, C.vault, VAULT, 'forceSettlement')).transactionHash;
      const last = Number(await read(C.vault, VAULT, 'lastSettlementTs'));
      const interval = Number(await read(C.vault, VAULT, 'maxSettlementInterval'));
      await waitFor('settlement interval', async () => Number((await pub.getBlock()).timestamp) >= last + interval, (interval + 120) * 1000, 10_000);
      return (await send(lp, C.vault, VAULT, 'tryNewSettlement')).transactionHash;
    };
    await send(lp, C.collateral, ERC20, 'approve', [C.vault, 2n ** 255n]);
    const id = await read(C.vault, VAULT, 'targetSettlementId', [true]);
    const start = await usdwOf(lp.address);
    await send(lp, C.vault, VAULT, 'requestDeposit', [1_000n * E6]);
    check(REQ[await read(C.vault, VAULT, 'getDepositStatus', [lp.address, id])] === 'PENDING', 'deposit not pending');
    check((await usdwOf(lp.address)) === start - 1_000n * E6, 'deposit not escrowed');
    await send(lp, C.vault, VAULT, 'cancelRequestDeposit', [id, 100n * E6]);
    check((await usdwOf(lp.address)) === start - 900n * E6, 'cancel did not refund');
    check((await read(C.vault, VAULT, 'pendingDepositRequest', [lp.address, id])) === 900n * E6, 'pending != 900');
    const s1 = await settle();
    const status = REQ[await read(C.vault, VAULT, 'getDepositStatus', [lp.address, id])];
    const row = await waitFor('settlement in API', async () => (await api('/vault/settlements?limit=50')).find((x) => x.settlementId === Number(id)), 30_000);
    if (status === 'RECLAIMABLE') {
      const eff = await read(C.vault, VAULT, 'effectiveAccPnlPerTokenUsed');
      check(eff > 0n, `deposit refused although effectiveAccPnlPerTokenUsed=${eff} <= 0`);
      await send(lp, C.vault, VAULT, 'reclaimDeposit', [id]);
      check((await usdwOf(lp.address)) === start, 'reclaim did not return the deposit');
      return { depositSettlement: id, settleTx: s1, outcome: `refused by the vault (effectiveAccPnlPerTokenUsed=${eff} > 0: traders in open profit) and RECLAIMED in full`, claim: 'not reachable at this settlement', apiSettlementRow: row.txHash };
    }
    check(status === 'CLAIMABLE', `deposit status after settlement: ${status}`);
    await send(lp, C.vault, VAULT, 'claimDeposit', [id]);
    const shares = await read(C.vault, VAULT, 'balanceOf', [lp.address]);
    const price = await read(C.vault, VAULT, 'settlementShareToAssetsPrice', [id]);
    const expected = (900n * E6 * 10n ** 18n) / price;
    check(shares === expected, `shares ${shares} != ${expected} at price ${price}`);
    check(units(row.shareToAssetsPrice, 18) === price, `API share price ${row.shareToAssetsPrice} != ${price}`);
    // Withdraw half: requested for targetSettlementId(false), claimable once that settles.
    const wid = await read(C.vault, VAULT, 'targetSettlementId', [false]);
    await send(lp, C.vault, VAULT, 'requestWithdraw', [shares / 2n]);
    check(REQ[await read(C.vault, VAULT, 'getWithdrawStatus', [lp.address, wid])] === 'PENDING', 'withdraw not pending');
    const settles = [];
    while ((await read(C.vault, VAULT, 'lastSettlementId')) < wid) settles.push(await settle());
    check(REQ[await read(C.vault, VAULT, 'getWithdrawStatus', [lp.address, wid])] === 'CLAIMABLE', 'withdraw not claimable');
    const before = await usdwOf(lp.address);
    await send(lp, C.vault, VAULT, 'claimWithdraw', [wid]);
    const got = (await usdwOf(lp.address)) - before;
    const wprice = await read(C.vault, VAULT, 'settlementShareToAssetsPrice', [wid]);
    check(got === ((shares / 2n) * wprice) / 10n ** 18n, `withdraw paid ${got}, expected ${((shares / 2n) * wprice) / 10n ** 18n}`);
    return { depositSettlement: id, settledBy: gov ? 'gov forceSettlement' : 'tryNewSettlement after interval', settleTx: s1, shares: usd(shares), sharePrice: px(price), apiSettlementRow: row.txHash, withdrawSettlement: wid, withdrawSettleTxs: settles, withdrawn: usd(got), reclaim: 'not reachable: this settlement accepted the deposit' };
  });

  // 1 ── market open, then close from a wallet holding zero USDW ──────────────────────────
  await item('market', 'market open/close, closing from a wallet holding 0 USDW', async () => {
    const t = await open(trader, { pair: 0, collateral: 100n * E6, leverage: 1000 });
    check(t.collateral > 0n && t.leverage === 1000, `stored trade ${t.collateral}/${t.leverage}`);
    const p = await waitFor('position in API', () => apiPosition(trader, t.tradeId), 30_000);
    check(units(p.collateral, 6) === t.collateral, `API collateral ${p.collateral} != chain ${t.collateral}`);
    // Empty the wallet: the close must not need any USDW.
    const bal = await usdwOf(trader.address);
    await send(trader, C.collateral, ERC20, 'transfer', [funder.address, bal]);
    check((await usdwOf(trader.address)) === 0n, 'wallet not empty');
    const c = await close(trader, t);
    const after = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, t.pairIndex, t.index]);
    check(after.leverage === 0, 'trade still stored after close');
    const got = await usdwOf(trader.address);
    check(got === c.usdcSent && got > 0n, `wallet got ${got}, event says ${c.usdcSent}`);
    const row = await waitFor('closed row in API', () => apiHistoryRow(trader, c.orderId), 30_000);
    check(row.closeReason === 'close' && units(row.usdcSentToTrader, 6) === c.usdcSent, `API row ${JSON.stringify(row)}`);
    check(!(await apiPosition(trader, t.tradeId)), 'API still lists the position');
    await send(funder, C.collateral, ERC20, 'transfer', [trader.address, bal]).catch(async () => fundWallet(trader, bal));
    return { tradeId: t.tradeId, openFill: t.fillTx, closeOrder: c.orderId, closeFill: c.fillTx, usdwBeforeClose: '0', usdwAfterClose: usd(got) };
  });

  // 2 ── partial close ─────────────────────────────────────────────────────────────────
  await item('partial', 'partial close 50%', async () => {
    const t = await open(trader, { pair: 1, collateral: 200n * E6, leverage: 500 });
    const c = await close(trader, t, 5_000);
    const after = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, t.pairIndex, t.index]);
    // The bond for a partial close comes out of the position (see OstiumTrading.closeTradeMarket).
    const bond = await read(C.pairsStorage, PAIRS, 'pairOracleFee', [t.pairIndex]);
    check(after.collateral === t.collateral / 2n - bond || after.collateral === t.collateral / 2n, `collateral ${t.collateral} -> ${after.collateral} (bond ${bond})`);
    const row = await waitFor('partial row in API', () => apiHistoryRow(trader, c.orderId), 30_000);
    check(row.isPartial && row.percentageClosed === '50.00' && units(row.collateral, 6) === t.collateral / 2n, `API row ${JSON.stringify(row)}`);
    const p = await waitFor('API position collateral', async () => {
      const x = await apiPosition(trader, t.tradeId);
      return x && units(x.collateral, 6) === after.collateral ? x : null;
    }, 30_000);
    const rest = await close(trader, { ...t, tradeId: t.tradeId });
    return { tradeId: t.tradeId, collateral: `${usd(t.collateral)} -> ${usd(after.collateral)}`, apiCollateral: p.collateral, partialOrder: c.orderId, partialFill: c.fillTx, restClosedBy: rest.fillTx };
  });

  // 3 ── TP and SL: set at open, update, trigger ───────────────────────────────────────
  await item('tpsl', 'TP and SL set at open, updated, each triggered by the bots', async () => {
    let { mark } = await quote(0);
    const t = await open(trader, { pair: 0, collateral: 100n * E6, leverage: 1000, tp: bps(mark, 500), sl: bps(mark, -500) });
    check(t.tp === bps(mark, 500) && t.sl === bps(mark, -500), `stored tp/sl ${t.tp}/${t.sl}`);
    const newTp = bps(t.openPrice, 400), newSl = bps(t.openPrice, -400);
    await send(trader, C.trading, TRADING, 'updateTp', [0, t.index, newTp]);
    await send(trader, C.trading, TRADING, 'updateSl', [0, t.index, newSl]);
    const s = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, 0, t.index]);
    check(s.tp === newTp && s.sl === newSl, 'update not stored');
    await waitFor('API tp/sl updated', async () => {
      const p = await apiPosition(trader, t.tradeId);
      return p && units(p.tp, 18) === newTp && units(p.sl, 18) === newSl;
    }, 30_000);
    // Trigger TP: move it just under the price a close would fill at (a long closes at the bid).
    ({ bid: mark } = await quote(0));
    const hitTp = bps(mark, -20);
    const fromTp = await pub.getBlockNumber();
    await send(trader, C.trading, TRADING, 'updateTp', [0, t.index, hitTp]);
    const tp = await awaitAutomationClose(trader, t, 'TP', fromTp, 90_000);
    check(tp.kind === 'TP', `closed as ${tp.kind}`);
    const tpRow = await waitFor('tp row in API', () => apiHistoryRow(trader, tp.orderId), 30_000);
    check(tpRow.closeReason === 'tp', `API closeReason ${tpRow.closeReason}`);

    // SL on a second trade: raise it just above the live price.
    const t2 = await open(trader, { pair: 0, collateral: 100n * E6, leverage: 1000, sl: bps((await quote(0)).mark, -500) });
    const hitSl = bps((await quote(0)).mark, 20);
    const fromSl = await pub.getBlockNumber();
    await send(trader, C.trading, TRADING, 'updateSl', [0, t2.index, hitSl]);
    const sl = await awaitAutomationClose(trader, t2, 'SL', fromSl, 90_000);
    check(sl.kind === 'SL', `closed as ${sl.kind}`);
    const slRow = await waitFor('sl row in API', () => apiHistoryRow(trader, sl.orderId), 30_000);
    check(slRow.closeReason === 'sl', `API closeReason ${slRow.closeReason}`);
    return { tp: { tradeId: t.tradeId, order: tp.orderId, fill: tp.fillTx, bot: tp.triggeredBy, tp: px(hitTp), closePrice: px(tp.price) }, sl: { tradeId: t2.tradeId, order: sl.orderId, fill: sl.fillTx, bot: sl.triggeredBy, sl: px(hitSl), closePrice: px(sl.price) } };
  });

  // 4 ── add and remove collateral ─────────────────────────────────────────────────────
  await item('collateral', 'top up and remove collateral', async () => {
    const t = await open(trader, { pair: 1, collateral: 100n * E6, leverage: 2000 });
    await send(trader, C.trading, TRADING, 'topUpCollateral', [1, t.index, 100n * E6]);
    const up = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, 1, t.index]);
    check(up.collateral > t.collateral && up.leverage < t.leverage, `top up: ${t.collateral}/${t.leverage} -> ${up.collateral}/${up.leverage}`);
    await waitFor('API collateral after top-up', async () => units((await apiPosition(trader, t.tradeId))?.collateral ?? '0', 6) === up.collateral, 30_000);
    const fromRm = await pub.getBlockNumber();
    const r = await send(trader, C.trading, TRADING, 'removeCollateral', [1, t.index, 50n * E6]);
    const ev = await waitFor('remove-collateral callback', async () => {
      const evs = await logsSince(C.callbacks, CALLBACKS, fromRm);
      return evs.find((e) => (e.eventName === 'RemoveCollateralExecuted' || e.eventName === 'RemoveCollateralRejected') && e.args.tradeId === t.tradeId);
    }, 45_000);
    check(ev.eventName === 'RemoveCollateralExecuted', `rejected: ${CANCEL_REASONS[ev.args.reason]}`);
    const down = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, 1, t.index]);
    check(down.collateral === up.collateral - ev.args.removeAmount && down.leverage > up.leverage, `remove: ${up.collateral} -> ${down.collateral}`);
    await waitFor('API collateral after remove', async () => units((await apiPosition(trader, t.tradeId))?.collateral ?? '0', 6) === down.collateral, 30_000);
    await close(trader, t);
    return { tradeId: t.tradeId, collateral: `${usd(t.collateral)} -> ${usd(up.collateral)} -> ${usd(down.collateral)}`, leverage: `${t.leverage} -> ${up.leverage} -> ${down.leverage}`, removeRequest: r.transactionHash, removeFill: ev.log.transactionHash };
  });

  // 5 ── LIMIT and STOP entries: place, update, cancel, trigger ─────────────────────────
  async function placeEntry(pair, orderType, target, collateral = 100n * E6, leverage = 1000) {
    const t = { collateral, openPrice: target, tp: 0n, sl: 0n, trader: trader.address, leverage, pairIndex: pair, index: 0, buy: true, isDayTrade: false };
    const r = await send(trader, C.trading, TRADING, 'openTrade', [t, { builder: '0x0000000000000000000000000000000000000000', builderFee: 0 }, orderType, 0n]);
    const ev = decodeLogs(r, TRADING).find((e) => e.eventName === 'OpenLimitPlacedV2');
    return { index: ev.args.index, tx: r.transactionHash, block: r.blockNumber };
  }
  async function apiLimit(pair, index) {
    return (await api(`/limit-orders/${trader.address}`)).find((o) => o.pairIndex === pair && o.index === index) ?? null;
  }
  async function entryLifecycle(orderType, name) {
    const pair = 0;
    const { mark } = await quote(pair);
    // Out of reach: a LIMIT buy fills at or below its price, a STOP buy at or above.
    const far = orderType === LIMIT ? bps(mark, -300) : bps(mark, 300);
    const p = await placeEntry(pair, orderType, far);
    const o = await read(C.tradingStorage, STORAGE, 'getOpenLimitOrder', [trader.address, pair, p.index]);
    check(o.targetPrice === far && o.orderType === orderType, 'stored order differs');
    const row = await waitFor('limit row in API', () => apiLimit(pair, p.index), 30_000);
    check(row.orderType === name && units(row.triggerPrice, 18) === far, `API row ${JSON.stringify(row)}`);
    const moved = orderType === LIMIT ? bps(mark, -400) : bps(mark, 400);
    await send(trader, C.trading, TRADING, 'updateOpenLimitOrder', [pair, p.index, moved, 0n, 0n]);
    check((await read(C.tradingStorage, STORAGE, 'getOpenLimitOrder', [trader.address, pair, p.index])).targetPrice === moved, 'update not stored');
    await waitFor('API trigger updated', async () => units((await apiLimit(pair, p.index))?.triggerPrice ?? '0', 18) === moved, 30_000);
    // Give the bots several sweeps: an out-of-reach order must still be resting.
    await sleep(8_000);
    check(await read(C.tradingStorage, STORAGE, 'hasOpenLimitOrder', [trader.address, pair, p.index]), 'out-of-reach order was filled or removed');
    const balBefore = await usdwOf(trader.address);
    const cancel = await send(trader, C.trading, TRADING, 'cancelOpenLimitOrder', [pair, p.index]);
    check(!(await read(C.tradingStorage, STORAGE, 'hasOpenLimitOrder', [trader.address, pair, p.index])), 'order still stored after cancel');
    const fee = await read(C.pairsStorage, PAIRS, 'pairOracleFee', [pair]);
    check((await usdwOf(trader.address)) - balBefore === 100n * E6 - fee, 'cancel refund != collateral - oracle fee');
    await waitFor('API row gone', async () => !(await apiLimit(pair, p.index)), 30_000);

    // Triggered fill: place out of reach, then move the trigger across the live price.
    const p2 = await placeEntry(pair, orderType, far);
    await waitFor('limit row in API', () => apiLimit(pair, p2.index), 30_000);
    const q = await quote(pair);
    const across = orderType === LIMIT ? bps(q.ask, 30) : bps(q.mark, -30);
    const from = await pub.getBlockNumber();
    await send(trader, C.trading, TRADING, 'updateOpenLimitOrder', [pair, p2.index, across, 0n, 0n]);
    const fill = await waitFor(`${name} fill by the bots`, async () => {
      const evs = await logsSince(C.callbacks, CALLBACKS, from);
      const hit = evs.find((e) => e.eventName === 'LimitOpenExecuted' && e.args.t.trader === trader.address && e.args.limitIndex === BigInt(p2.index));
      const miss = evs.find((e) => e.eventName === 'AutomationOpenOrderCanceled' && e.args.trader === trader.address);
      if (!hit && miss) console.log(`   (bot attempt cancelled: ${CANCEL_REASONS[miss.args.cancelReason]}; waiting for a retry)`);
      return hit;
    }, 90_000, 1500);
    const t = fill.args.t;
    const stored = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, pair, t.index]);
    check(stored.leverage > 0, 'filled trade not stored');
    check(!(await read(C.tradingStorage, STORAGE, 'hasOpenLimitOrder', [trader.address, pair, p2.index])), 'limit still resting after fill');
    const info = await read(C.tradingStorage, STORAGE, 'getOpenTradeInfo', [trader.address, pair, t.index]);
    await waitFor('API position from fill', () => apiPosition(trader, info.tradeId), 30_000);
    await waitFor('API limit row gone after fill', async () => !(await apiLimit(pair, p2.index)), 30_000);
    const hist = await api(`/orders/${trader.address}/history?limit=500`);
    check(hist.some((h) => h.kind === 'limit_executed' && h.index === p2.index && h.pairIndex === pair), 'no limit_executed row in order history');
    const bot = (await pub.getTransaction({ hash: await findAutomationRequestTx(fill.args.orderId, from) })).from;
    await close(trader, { ...stored, tradeId: info.tradeId });
    return { placed: p.tx, cancelled: cancel.transactionHash, trigger: px(across), fillOrder: fill.args.orderId, fill: fill.log.transactionHash, bot, openPrice: px(t.openPrice) };
  }
  await item('limit', 'LIMIT entry: place, update, cancel, triggered fill', () => entryLifecycle(LIMIT, 'LIMIT'));
  await item('stop', 'STOP entry: place, update, cancel, triggered fill', () => entryLifecycle(STOP, 'STOP'));

  // 6 ── timeout reclaim for an open and a close ────────────────────────────────────────
  await item('timeout', 'timeout reclaim for an open and for a close (keeper stopped)', async () => {
    if (!env.ACCEPT_HOOKS) return { skip: 'needs ACCEPT_HOOKS keeper-stop/keeper-start' };
    const held = await open(trader, { pair: 1, collateral: 100n * E6, leverage: 1000 });
    hook('keeper-stop');
    try {
      const bal = await usdwOf(trader.address);
      const req = await openMarket(trader, { pair: 1, collateral: 100n * E6, leverage: 1000 });
      check((await usdwOf(trader.address)) === bal - 100n * E6, 'collateral not escrowed');
      await waitBlocks(timeoutBlocks);
      const o = await send(trader, C.trading, TRADING, 'openTradeMarketTimeout', [req.orderId]);
      check((await usdwOf(trader.address)) === bal, 'open reclaim did not return the full collateral');
      const creq = await requestClose(trader, held);
      await waitBlocks(timeoutBlocks);
      const c = await send(trader, C.trading, TRADING, 'closeTradeMarketTimeout', [creq.orderId, false]);
      const still = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, 1, held.index]);
      check(still.leverage > 0 && still.collateral === held.collateral, 'close reclaim did not leave the position intact');
      hook('keeper-start');
      const statuses = await waitFor('API order statuses', async () => {
        const h = await api(`/orders/${trader.address}/history?limit=500`);
        const a = h.find((x) => x.orderId === req.orderId.toString());
        const b = h.find((x) => x.orderId === creq.orderId.toString());
        return a?.status === 'timeout' && b?.status === 'timeout' ? [a.status, b.status] : null;
      }, 30_000);
      await sleep(3000);
      const closed = await close(trader, held);
      return { openOrder: req.orderId, openReclaim: o.transactionHash, closeOrder: creq.orderId, closeReclaim: c.transactionHash, apiStatuses: statuses, positionClosedAfterRestart: closed.fillTx };
    } finally {
      try { hook('keeper-start'); } catch {}
    }
  });

  // 7 ── degraded mode ──────────────────────────────────────────────────────────────────
  await item('degraded', 'degraded mode: opens refused, closes still fill', async () => {
    if (!env.ACCEPT_HOOKS) return { skip: 'needs ACCEPT_HOOKS degrade/restore' };
    const held = await open(trader, { pair: 0, collateral: 100n * E6, leverage: 1000 });
    hook('degrade');
    try {
      await waitFor('BTC degraded at the publisher', async () => (await quote(0)).degraded, 90_000, 2000);
      const now = Math.floor(Date.now() / 1000);
      const feed = encodeURIComponent(feedOf(0));
      const openProbe = await getJson(`${PUBLISHER_URL}/v2/report?feed=${feed}&timestamp=${now}&orderType=MARKET_OPEN`);
      const closeProbe = await getJson(`${PUBLISHER_URL}/v2/report?feed=${feed}&timestamp=${now}&orderType=MARKET_CLOSE`);
      check(openProbe.status === 409 && closeProbe.status === 200, `probe open=${openProbe.status} ${JSON.stringify(openProbe.body)} close=${closeProbe.status}`);
      const price = await api('/price/0');
      check(price.degraded === true, `API /price degraded=${price.degraded}`);
      const bal = await usdwOf(trader.address);
      const req = await openMarket(trader, { pair: 0, collateral: 100n * E6, leverage: 1000 });
      const c = await close(trader, held);
      await waitBlocks(timeoutBlocks);
      const filled = (await logsSince(C.callbacks, CALLBACKS, req.block)).some((e) => e.eventName === 'MarketOpenExecuted' && e.args.orderId === req.orderId);
      check(!filled, 'an open was filled while degraded');
      await send(trader, C.trading, TRADING, 'openTradeMarketTimeout', [req.orderId]);
      check((await usdwOf(trader.address)) === bal + c.usdcSent, 'refused open not refunded');
      return { publisherOpen: `${openProbe.status} ${openProbe.body?.error}`, publisherClose: closeProbe.status, apiDegraded: price.degraded, openOrderRefusedThenReclaimed: req.orderId, closeFilled: c.fillTx };
    } finally {
      hook('restore');
      await waitFor('BTC healthy again', async () => !(await quote(0)).degraded, 90_000, 2000).catch(() => {});
    }
  });

  // 8 ── liquidation by the bots ───────────────────────────────────────────────────────
  await item('liquidation', 'liquidation fired automatically by the bots', async () => {
    const pair = LIQ_PAIR;
    const maxLev = Number(await read(C.pairsStorage, PAIRS, 'pairMaxLeverage', [pair]));
    const t = await open(trader, { pair, collateral: 50n * E6, leverage: maxLev, slippageP: 200 });
    const from = await pub.getBlockNumber();
    const found = async () => {
      const evs = await logsSince(C.callbacks, CALLBACKS, from);
      return evs.find((e) => e.eventName === 'LimitCloseExecuted' && e.args.tradeId === t.tradeId);
    };
    let shifted = false;
    let ev = await waitFor('natural liquidation', found, LIQ_WAIT_S * 1000, 2000).catch(() => null);
    try {
      if (!ev) {
        if (!env.ACCEPT_HOOKS) return { skip: `no liquidating move on pair ${pair} within ${LIQ_WAIT_S}s and no shift hook` };
        // Documented test rig: tools/stack/shifted-publisher.mjs moves this ONE feed.
        shifted = hook('shift', feedOf(pair), -150);
        ev = await waitFor('liquidation after the shift', found, 120_000, 2000);
      }
    } finally {
      if (shifted) hook('unshift');
    }
    const before = t.collateral;
    ctx.ledger.push({ tradeId: t.tradeId, closeOrderId: ev.args.orderId, collateralClosed: before, usdcSent: ev.args.usdcSentToTrader, reason: LIMIT_KIND[ev.args.orderType].toLowerCase(), partial: false });
    check(LIMIT_KIND[ev.args.orderType] === 'LIQ', `closed as ${LIMIT_KIND[ev.args.orderType]}`);
    const gone = await read(C.tradingStorage, STORAGE, 'getOpenTrade', [trader.address, pair, t.index]);
    check(gone.leverage === 0, 'trade still stored');
    const bot = (await pub.getTransaction({ hash: await findAutomationRequestTx(ev.args.orderId, from) })).from;
    check(manifest.roles && bot.toLowerCase() !== trader.address.toLowerCase(), 'liquidation not sent by a bot');
    const row = await waitFor('liq row in API', () => apiHistoryRow(trader, ev.args.orderId), 30_000);
    check(row.closeReason === 'liq', `API closeReason ${row.closeReason}`);
    return { pair, leverage: maxLev / 100, tradeId: t.tradeId, openPrice: px(t.openPrice), liqPrice: px(ev.args.price), order: ev.args.orderId, fill: ev.log.transactionHash, bot, priceShifted: shifted };
  });

  // 9 ── fills inside the quoted slippage ─────────────────────────────────────────────
  await item('slippage', 'every market fill landed inside wanted price ± max slippage', async () => {
    check(ctx.opens.length > 0, 'no market opens to judge');
    for (const o of ctx.opens) {
      const lim = (o.wanted * BigInt(o.slippageP)) / 10_000n;
      const ok = o.buy ? o.openPrice <= o.wanted + lim : o.openPrice >= o.wanted - lim;
      check(ok, `order ${o.orderId}: fill ${o.openPrice} vs wanted ${o.wanted} ±${o.slippageP / 100}%`);
    }
    const worst = ctx.opens.reduce((m, o) => {
      const d = Number(((o.openPrice - o.wanted) * 1_000_000n) / o.wanted) / 10_000;
      return Math.abs(d) > Math.abs(m) ? d : m;
    }, 0);
    return { fills: ctx.opens.length, worstDeviationPct: worst };
  });

  // 10 ── history endpoints against chain ──────────────────────────────────────────────
  await item('history', 'history endpoints (/orders/:a/history, /fees, /pnl, /positions/:a/history, /limit-orders) match chain', async () => {
    await sleep(5000); // let the indexer catch the last blocks
    const me = trader.address.toLowerCase();
    // The timeout events carry the trader only inside the stored order struct.
    const tEv = (await logsSince(C.trading, TRADING, startBlock)).filter((e) => (e.args.trader ?? e.args.order?.trade?.trader ?? '').toLowerCase() === me);
    const cEvAll = await logsSince(C.callbacks, CALLBACKS, startBlock);
    const cEv = cEvAll.filter((e) => (e.args.trader ?? e.args.t?.trader ?? '').toLowerCase() === me || e.eventName === 'MarketCloseExecutedV2' || e.eventName === 'LimitCloseExecuted');

    // Orders: every oracle round trip this wallet requested, with its outcome.
    const requested = new Map();
    for (const e of tEv) {
      if (['MarketOpenOrderInitiated', 'MarketCloseOrderInitiatedV2', 'AutomationOpenOrderInitiated', 'AutomationCloseOrderInitiated', 'RemoveCollateralInitiated'].includes(e.eventName)) requested.set(e.args.orderId.toString(), 'pending');
    }
    const outcome = (id, s) => { if (requested.has(id)) requested.set(id, s); };
    for (const e of cEvAll) {
      const id = e.args.orderId?.toString();
      if (!id) continue;
      if (/Executed/.test(e.eventName)) outcome(id, 'executed');
      if (/Canceled|Rejected/.test(e.eventName)) outcome(id, 'cancelled');
    }
    for (const e of tEv) if (/TimeoutExecuted/.test(e.eventName)) outcome(e.args.orderId.toString(), 'timeout');
    const hist = await api(`/orders/${me}/history?limit=500`);
    const apiOrders = new Map(hist.filter((h) => h.source === 'order').map((h) => [h.orderId, h.status]));
    const missing = [...requested.keys()].filter((k) => !apiOrders.has(k));
    const extra = [...apiOrders.keys()].filter((k) => !requested.has(k));
    const wrong = [...requested].filter(([k, s]) => apiOrders.has(k) && apiOrders.get(k) !== s).map(([k, s]) => `${k}: chain ${s} api ${apiOrders.get(k)}`);
    check(!missing.length && !extra.length && !wrong.length, `orders missing=${missing} extra=${extra} status=${wrong}`);
    const limitChain = { limit_placed: 0, limit_updated: 0, limit_cancelled: 0, limit_executed: 0 };
    for (const e of tEv) {
      if (e.eventName === 'OpenLimitPlacedV2') limitChain.limit_placed++;
      if (e.eventName === 'OpenLimitUpdated') limitChain.limit_updated++;
      if (e.eventName === 'OpenLimitCanceled') limitChain.limit_cancelled++;
    }
    limitChain.limit_executed = cEvAll.filter((e) => e.eventName === 'LimitOpenExecuted' && e.args.t.trader.toLowerCase() === me).length;
    const limitApi = { limit_placed: 0, limit_updated: 0, limit_cancelled: 0, limit_executed: 0 };
    for (const h of hist) if (h.source === 'limit') limitApi[h.kind]++;
    check(JSON.stringify(limitApi) === JSON.stringify(limitChain), `limit rows api ${JSON.stringify(limitApi)} chain ${JSON.stringify(limitChain)}`);

    // Fees: per-kind sums. The indexer folds the oracle fee of a bond into a 'bond' row.
    const sum = { oracle: 0n, dev: 0n, vault_opening: 0n, vault_liq: 0n, rollover: 0n, funding: 0n, bondCount: 0 };
    const mine = (e) => (e.args.trader ?? '').toLowerCase() === me;
    for (const e of cEvAll.filter(mine)) {
      if (e.eventName === 'OracleFeeCharged') sum.oracle += e.args.amount;
      if (e.eventName === 'DevFeeCharged') sum.dev += e.args.amount;
      if (e.eventName === 'VaultOpeningFeeCharged') sum.vault_opening += e.args.amount;
      if (e.eventName === 'VaultLiqFeeCharged') sum.vault_liq += e.args.amount;
      if (e.eventName === 'FeesChargedV2') { sum.rollover += e.args.rolloverFees; sum.funding += e.args.fundingFees; }
      if (e.eventName === 'OracleFeeBondCharged') sum.bondCount++;
    }
    for (const e of tEv) if (e.eventName === 'OracleFeeCharged' || e.eventName === 'OracleFeeChargedLimitCancelled') sum.oracle += e.args.amount;
    const fees = await api(`/fees/${me}?limit=500`);
    const a = { oracle: 0n, dev: 0n, vault_opening: 0n, vault_liq: 0n, rollover: 0n, funding: 0n, bondCount: 0 };
    for (const f of fees) {
      const v = units(f.amount, 6);
      if (f.kind === 'bond') { a.oracle += v; a.bondCount++; } else a[f.kind] += v;
    }
    const fmt = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    check(fmt(a) === fmt(sum), `fees api ${fmt(a)} chain ${fmt(sum)}`);

    // Realised rows and PnL against the ledger this run built from chain events.
    const rows = await api(`/positions/${me}/history`);
    for (const l of ctx.ledger) {
      const r = rows.find((x) => x.closeOrderId === l.closeOrderId.toString());
      check(r, `no history row for close order ${l.closeOrderId}`);
      check(units(r.usdcSentToTrader, 6) === l.usdcSent && units(r.collateral, 6) === l.collateralClosed && r.closeReason === l.reason,
        `row ${l.closeOrderId}: api sent=${r.usdcSentToTrader} coll=${r.collateral} reason=${r.closeReason}; chain sent=${l.usdcSent} coll=${l.collateralClosed} reason=${l.reason}`);
    }
    check(rows.length === ctx.ledger.length, `API has ${rows.length} realised rows, run made ${ctx.ledger.length}`);
    const pnl = await api(`/pnl/${me}`);
    const realized = ctx.ledger.reduce((s, l) => s + l.usdcSent - l.collateralClosed, 0n);
    const trades = new Set(ctx.ledger.map((l) => l.tradeId.toString())).size;
    check(units(pnl.realizedPnl, 6) === realized && pnl.trades === trades, `pnl api ${JSON.stringify(pnl)} chain realized=${realized} trades=${trades}`);
    const open = await api(`/limit-orders/${me}`);
    let chainOpen = 0;
    for (const m of manifest.markets) chainOpen += Number(await read(C.tradingStorage, STORAGE, 'openLimitOrdersCount', [trader.address, m.pairIndex]));
    check(open.length === chainOpen, `limit-orders api ${open.length} chain ${chainOpen}`);
    return { orders: requested.size, limitRows: limitChain, fees: fmt(sum), realisedRows: rows.length, realizedPnl: pnl.realizedPnl, trades };
  });

  // ── report ──
  const w = Math.max(...results.map((r) => r.id.length));
  console.log('\n' + '-'.repeat(72));
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.id.padEnd(w)}  ${String(r.seconds).padStart(4)}s  ${r.title}`);
  console.log('-'.repeat(72));
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`${results.length} item(s): ${results.filter((r) => r.status === 'PASS').length} PASS, ${failed} FAIL, ${results.filter((r) => r.status === 'SKIP').length} SKIP`);
  if (env.ACCEPT_OUT) {
    writeFileSync(env.ACCEPT_OUT, JSON.stringify({ chainId, rpc: RPC_URL, trader: trader.address, lp: lp.address, at: new Date().toISOString(), results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }
  return failed;
}

main().then(
  (failed) => process.exit(failed ? 1 : 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
