# Plan — testnet 1874 working perfectly

Spec: `docs/superpowers/specs/2026-09-28-testnet-perfect-design.md`. Branch `feat/testnet-perfect`.
One commit per change; every change lands with the tests that cover it.

## T0 — Green baseline
- [x] Merge `feat/close-bond-from-position`.
- [x] Contracts green after the merge; record sizes.
- [x] Indexer `decode.test.ts`: refresh the fixture against the hardened upkeep.
- [x] Playwright `mockChain`: serve the PairInfos reads the terminal makes.
- [x] CI: services, packages, indexer, api (Postgres service), web tsc + vitest + build + e2e.

## T1 — Contracts and one-shot deploy
- [x] `DeployTestnet.s.sol`: one script that deploys the whole system (hardened oracle, TradesUpKeep,
      markets with fees/spread/impact/funding, forwarders, liquidity), idempotent, with a test
      asserting every configured value.
- [x] `marketOrdersTimeout` 30 → 11, with the dead-window test flipped to prove it closed.
- [ ] Unit tests per external function: Trading (limit/stop place-update-cancel, TP/SL update,
      top-up, remove collateral, timeouts), Callbacks (every cancel reason), Vault (full request/
      settle/claim/cancel/reclaim, MM), PairInfos (fees, funding, rollover, liq price), PairsStorage,
      TradesUpKeep (every automation status).
- [ ] Invariant suite: handler over all actions; solvency, conservation, OI cap, liquidatability,
      storage collateral = balance.
- [ ] Coverage gate in CI.

## T2 — Off-chain correctness
- [x] `packages/txsender`: serial nonce queue, replacement on receipt timeout, nonce after revert,
      persistent dead-letter.
- [x] Keeper on txsender; awaited events; persisted cursor; retry report failures; polling config.
- [x] Publisher: loopback bind, timestamp window on `/v2/report`, metrics.
- [x] Automation bot (liquidator): candidates from indexer DB; LIQ + TP + SL + LIMIT/STOP triggers;
      batching; sweep mutex; per-trade `isDayTrade`; RPC outage → STALLED; metrics wired.
- [x] Indexer: limit orders, TP/SL, collateral changes, liquidations, funding, vault settlements.
- [x] API: open orders, order history, funding history, realised PnL, account summary.

## T3 — Terminal (Variational-style quote)
- [x] Remove `DepthPanel`; quote maths `lib/quote.ts` with tests.
- [x] Order form: Market / Limit / Stop tabs, Buy/Sell quoted prices, spread, est/max slippage,
      size in base or USD, % of available slider, TP/SL, isolated-margin badge, leverage control.
- [x] Positions: Liq. price, margin usage, funding, UPnL; edit TP/SL; add/remove collateral; close.
- [x] Tabs: Open Orders (update/cancel), Trade History, Order History, Funding History, Realised PnL.
- [x] Header: mark, index, 24h volume/change, open interest, funding rate.
- [x] Playwright e2e for every acceptance item.

## T4 — Redeploy 1874 and prove it live
- [ ] Deploy with `DeployTestnet.s.sol`; write `deployments/1874.json`.
- [ ] Repoint services; fresh indexer sync from the deploy block.
- [x] Two automation-bot units; loopback bindings; keeper gas alert; backup cron; `deploy-server.md`.
- [ ] Scripted live acceptance run of every item in spec §2, results recorded.
