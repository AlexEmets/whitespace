# Testnet 1874 — every feature working, every case tested

**Date:** 2026-09-28
**Status:** Approved decisions below; implementation in progress on `feat/testnet-perfect`
**Scope:** Testnet 1874 only. Mainnet-only work (1875 deploy, collateral choice, audit, Safe on
1875) is explicitly deferred — but everything built here is the mainnet rehearsal.

---

## 1. Decisions (made with the user, 2026-09-28)

| Question | Decision | Consequence |
|---|---|---|
| Gov key `0xFB04…0Dd8` is lost | **Full fresh redeploy of 1874** | close-bond ships in the redeploy, not as a registry repoint. Old testnet positions are orphaned (testnet funds only). |
| Liquidation model | **Allowlisted forwarders, 2 independent instances** | No change to vault economics. Freeze-griefing (L-3) is only reachable by our own keys. |
| Margin | **Isolated only** | No Cross toggle. Ostium's per-trade isolated margin stays the model. |
| Mainnet collateral | Undecided | Collateral stays a deploy parameter. Testnet keeps `USDW`. |
| "Order book" | **Like Variational Omni — no book at all** | See §3. |

## 2. What "working perfectly" means — the acceptance bar

Each item is demonstrated **on the live 1874 deployment**, not only on a local fixture:

1. Market open/close, partial close, from a wallet holding **zero** USDW at close time.
2. Limit and stop entries: place, update, cancel, trigger.
3. TP and SL: set at open, update after open, trigger.
4. Add and remove collateral.
5. **Liquidation fires automatically** when the mark crosses the liquidation price.
6. Timeout reclaim for both an open and a close.
7. Vault: request deposit/withdraw, settlement, claim, cancel, reclaim.
8. Degraded mode: opens blocked, closes and liquidations flow.
9. The terminal shows a two-sided **quote** for the chosen size, and the executed price lands
   inside the quote plus the trader's max slippage.
10. Every history tab (trades, orders, funding, realised PnL) matches chain state.

"Transactions mined" is not evidence. Each item has a scripted check that reads the resulting
state back.

## 3. The quote panel (Variational-style), replacing the depth panel

Variational Omni has no order book: a single liquidity provider (the OLP) quotes every trade
(RFQ), and the UI shows **Buy @ ask / Sell @ bid for the size you typed**, the spread, estimated
and max slippage, and the quoted price. The trader never sees depth, because there is none to see.

Our vault is the same shape: it is the only counterparty and its price is deterministic —
oracle bid/ask + dynamic spread + price impact for size (`TradingCallbacksLib.getDynamicTradePriceImpact`,
already transcribed in `apps/web/src/lib/priceImpact.ts`). So the quote is **computed, not
negotiated**:

| UI field | Source |
|---|---|
| Buy price | `priceAfterImpact(ask, size, long)` |
| Sell price | `priceAfterImpact(bid, size, short)` |
| Spread | `(buy − sell) / mid` |
| Est. slippage | `|quoted − mark| / mark` for the chosen side |
| Max slippage | trader setting → `slippageP` in `openTrade` |
| Fee | pair open fee × notional |
| Liquidation price / margin required | existing on-chain pure views |

`DepthPanel` and the fixed 1k…1M ladder are removed. For the quote to be meaningful the markets
must have non-zero `priceImpactK` and dynamic-spread params — today they are zero (§5).

**Why this is not a fake book.** A book implies resting liquidity at levels; the vault has none.
A per-size quote is exactly what the contract will do, so it is the honest display.

## 4. Automation (liquidations, TP/SL, limit entries)

`OstiumTradesUpKeep` is the only path to `executeAutomationOrder`, so the same service that
liquidates must also trigger TP, SL and limit entries — otherwise those order types exist in the
contracts and never fire. `services/liquidator` becomes the **automation bot**:

- Candidate set from the indexer's Postgres (open trades + open limit orders), refreshed each
  sweep; no in-memory-from-head table, so a restart sees every position.
- Per candidate, decide with the contract-exact margin engine (LIQ) or the trigger rule (TP, SL,
  LIMIT/STOP) against the publisher mark — the same price the report will carry.
- Batch triggers into one `performUpkeep`; one in-flight sweep at a time.
- Two instances with two forwarder keys. A lost race is harmless (contract NOT_HIT / NO_TRADE).
- The bot only triggers what its engine says is hit, which is the operational mitigation for the
  renewable trigger freeze (L-3) while the forwarder set is our keys only.

## 5. Parameters that change in the redeploy

| Parameter | Now | New | Why |
|---|---|---|---|
| `marketOrdersTimeout` | 30 blocks | **12 blocks** | With `maxAge` 10 s at 1 s/block, 30 left a 20 s window where an order is neither fillable nor refundable (measured in `KeeperCensorship.t.sol`). |
| Open fee, dynamic spread, `priceImpactK` | 0 | per market, non-zero | Vault earns; the quote reflects size. |
| Funding | 0 | non-zero, capped | Balances OI; funding history becomes meaningful. |
| TradesUpKeep | not deployed | deployed, 2 forwarders | Liquidations and TP/SL/limit. |
| Markets | BTC, ETH, SOL, WBT | same | WBT stays single-venue on testnet only. |

Exact values live in the deploy script and are pinned by its test.

## 6. Off-chain correctness fixes (all found in the 2026-09-28 audit)

- **Keeper:** events processed concurrently against one nonce; cursor lost on restart; report
  failures never retried; nonce not advanced after a mined revert; polling interval ignored.
- **Shared tx sender** (`packages/txsender`) for keeper and bot: serial nonce queue, receipt
  timeout with replacement, correct nonce after revert, persistent dead-letter with retry.
- **Publisher:** `/v2/report` signs any timestamp and listens on every interface. Bind to
  loopback; refuse timestamps in the future or older than `maxAge`.
- **Liquidator/bot:** overlapping sweeps, `isDayTrade` hardcoded, RPC outage never reaches
  STALLED, declared metrics never set.
- **Indexer:** stale decode fixture; index limit orders, TP/SL updates, collateral changes,
  liquidations, funding charges, vault settlements.

## 7. Testing bar

- **Contracts:** unit tests for every external function of Trading, Callbacks, Vault, PairInfos,
  PairsStorage, TradesUpKeep; fuzz on fee/funding/liquidation math; **invariant suite** with a
  handler covering every user and keeper action: vault solvency, conservation of USDW, OI never
  above cap, below-maintenance always liquidatable, storage collateral equals balance.
  Coverage gate in CI. Every new test must fail without the change it covers.
- **Services:** unit tests for every fix above, reproducing the bug first; integration tests on
  anvil with the real contracts.
- **Web:** unit tests for the quote maths and every new form path; Playwright e2e for each
  acceptance item in §2 against the mock chain; one full-stack e2e on anvil.
- **CI:** contracts, all services, web (tsc, vitest, build, Playwright), coverage.

## 8. Out of scope here

Mainnet deploy, Safe/Timelock governance (planned as the next rehearsal step), permissionless
liquidation, Cross margin, points/leaderboard, audit.
