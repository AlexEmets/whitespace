# List XRP/USD market

Date: 2026-10-16
Chain: Whitechain testnet 1874

XRP/USD is the ordinary four-venue case, identical in shape to ETH/USD and SOL/USD:
Binance, Bybit and OKX quote `XRP-USDT`/`XRPUSDT` and WhiteBIT quotes `XRP_USDT`, so it
carries **no** bounds override and uses the default `MIN_HEALTHY_VENUES` (3 of 4) and the
default risk caps (100x, $1M OI, group 0, fee 0). Contrast WBT/USD, which needed code for a
per-market threshold and a second WhiteBIT book — XRP needs none of that.

The on-chain listing uses the already-generic `Operate.s.sol:runAddMarkets()`
(`MARKETS=XRP/USD`); no Solidity change is required, and the path is already covered by
`contracts/test/integration/Operate.t.sol` (`test_addMarketForListsPairsBesideBtc` etc.).

## Phase 0 — code (DONE, tests green)

- [x] `packages/shared/src/markets.mjs` — `XRP/USD` added with the four standard venue
      symbols (`binance XRPUSDT`, `bybit XRPUSDT`, `okx XRP-USDT`, `whitebit XRP_USDT`) and
      the registry header updated to document it as the ordinary four-venue case.
- [x] `packages/shared/test/markets.test.mjs` — the named-markets guard now includes
      `XRP/USD`, plus a pinned test asserting all four venues, the standard symbols, the
      correct `feedId`, and no bounds override (default `minHealthyVenues`). Both new
      assertions were confirmed **red** against the tree without the registry entry
      (`XRP/USD is missing from MARKETS` / `getMarket: unknown feed "XRP/USD"`) before the
      fix made them green.
- [x] `services/price-publisher/.env.example` — the `PUBLISHER_MARKETS` default comment and
      example value were stale (listed only BTC/ETH/SOL, predating WBT). Corrected to the
      full current registry `BTC/USD,ETH/USD,SOL/USD,XRP/USD,WBT/USD` — this is exactly the
      "stale override silently starves a new market of prices" trap the comment itself warns
      about.

Verified here (node 22 in a container; the repo has no local node and deps are not
installed, so only the dependency-free shared package was runnable):

```
packages/shared/test/markets.test.mjs   8 pass 0 fail
packages/shared whole suite             72 pass 0 fail
```

No other code enumerates the market set: the publisher defaults to `MARKET_FEEDS`, the
keeper resolves feeds dynamically via `getMarketByFeedId`, the API reads pairs from the
chain and maps them through the registry, and the web client reads the API. The web
`whitespace-shared.d.ts` mirror types `MARKETS`/`MARKET_FEEDS` as `Record<string, Market>`
/ `string[]`, not literal unions, so it needs no change.

## Phase 1 — prod publisher must serve XRP/USD BEFORE the on-chain listing

`PUBLISHER_MARKETS` and `PUBLISHER_VENUES` in the prod `.env` OVERRIDE the registry rather
than extend it, so a market can be listed on-chain and never priced. XRP needs only the
four default venues (all already in prod's `PUBLISHER_VENUES`), so only `PUBLISHER_MARKETS`
changes.

- [ ] 1.1 On the publisher host, back up `.env`, add `XRP/USD` to `PUBLISHER_MARKETS`,
      restart the publisher (per `docs/runbooks/deploy-server.md`).
- [ ] 1.2 `curl 127.0.0.1:8787/status` shows `XRP/USD` healthy on 4 venues, `degraded:false`.
      **This is the design bar ("enough sources clear the venue filters") and the gate for
      Phase 2** — do not broadcast until it passes. If any venue's spread exceeds
      `VENUE_SPREAD_WIDTH_BOUND_BPS` (10) and XRP sits below 3 healthy, stop and reassess
      (it should not — XRP is deep on all four, but this is measured, not assumed).

## Phase 2 — list XRP/USD on-chain (no code, default caps)

Run from `contracts/`. Default `MARKET_MAX_LEVERAGE`/`MARKET_MAX_OI` are left unset so XRP
gets 100x / $1M like ETH/SOL. Never print or commit `GOV_PRIVATE_KEY` / `MANAGER_PRIVATE_KEY`.

```sh
RPC=https://rpc.testnet.whitechain.io
MARKETS=XRP/USD \
REGISTRY_ADDRESS=0xBc14f71f6533c74Dc63edeBa1fEC440e564bC4c8 \
GOV_PRIVATE_KEY=$(cat ../keys/gov.json | ...) \
MANAGER_PRIVATE_KEY=$(cat ../keys/manager.json | ...) \
forge script script/Operate.s.sol:OperateScript --sig "runAddMarkets()" \
  --rpc-url $RPC --legacy --slow -vvv          # add --broadcast to send
```

- [ ] 2.1 Dry-run (without `--broadcast`): expect the per-market sequence
      `registerUpkeepFor` → `addMarketFor` (`addPair` + `setPairFundingFees`) → `setMaxOiFor`.
      Confirm the `addPair.feed` equals `asciiToBytes32Hex("XRP/USD")` and the upkeep key is
      `XRP/USDPriceUpkeep` resolving to the deployed `priceUpKeep`
      `0x1c84dFAE52e4448196d37Cb9A6611d34BE810dE2`.
- [ ] 2.2 Broadcast. The 1874 public RPC is flaky under `--broadcast` re-simulation; if it
      dies before sending, fall back to the proven per-tx calldata replay used for ETH/SOL/WBT
      (one call at a time, each retried, `addPair` guarded on `pairsCount`). XRP becomes
      **pairIndex 4** (BTC 0, ETH 1, SOL 2, WBT 3).
- [ ] 2.3 Verify on chain (read live, not inferred): `pairsCount() == 5`; `pairs(4)` is
      XRP/USD at 100x, group 0, fee 0, `feed` byte-identical to `asciiToBytes32Hex("XRP/USD")`;
      `openInterest(4,2) == 1e12` (non-zero — a zero cap cancels opens silently); the
      `XRP/USDPriceUpkeep` registry key resolves to the incumbent upkeep.
- [ ] 2.4 Verify on prod API: `GET /markets` returns 5 rows; `GET /price/4` is
      `"source":"publisher"` with 4 healthy venues and `degraded:false` (feed resolves to the
      live publisher, not the stale chain fallback).

## Phase 3 — record the listing

- [ ] 3.1 Append the XRP/USD entry to `markets` in `deployments/1874-operational.json`
      (pairIndex 4, same shape as ETH/SOL: maxLeverage 10000, maxOpenInterest
      "1000000000000", fundingSpringFactor "1000000000000", maxFundingFeePerBlock "0"),
      with `listedAt`, `listedBy` and the broadcast `txs`.

## Verification gate

- [ ] Whole-repo lint + typecheck + unit tests green once deps are installed, output quoted.
      (Here: only `packages/shared` was runnable — 72/72 green — because the environment has
      no node and no installed deps. publisher/reporter/liquidator/api/web suites NOT run.)
- [ ] `pairsCount()` read from the live chain after the broadcast, not inferred.
- [ ] Publisher `/status` shows XRP/USD non-degraded before AND after the broadcast.
- [ ] Explicitly state what was NOT verified.

## Not done here / hazards

- Phases 1–3 need the GOV/MANAGER keys, the 1874 RPC and the running prod publisher. None of
  those are reachable from this session, so the code (Phase 0) is done and committed and the
  broadcast + prod `.env` edit + deployment-record update are left as the operator steps above.
- The local dev `services/price-publisher/.env` is gitignored; a second developer must add
  `XRP/USD` to their own `PUBLISHER_MARKETS` (the startup `MISCONFIGURED` warning will flag it
  otherwise). The committed `.env.example` now shows the correct full set.
- There is no unlisting: `removePair` requires zero traders and never frees the index, so
  pairIndex 4 is XRP forever once broadcast. Broadcast only after Phase 1.2 passes.
