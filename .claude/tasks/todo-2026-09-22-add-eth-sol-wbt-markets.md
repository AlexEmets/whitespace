# Add ETH/USD, SOL/USD, WBT/USD markets

Date: 2026-09-22
Chain: Whitechain testnet 1874

## Measured baseline (verified 2026-09-22, not assumed)

On-chain, read live from `pairsStorage 0xc5B68AfA8f64288f6d06DEfC5c07555Ef5323397`:

```
pairsCount()  = 1     -> only BTC/USD at index 0
feesCount()   = 1
pair(0)       = BTC / USD / "BTC/USD", maxLeverage 10000, group 0, fee 0
```

Off-chain registry `packages/shared/src/markets.mjs` already contains BTC/USD, ETH/USD,
SOL/USD. ETH and SOL therefore need **no code** — only an on-chain listing.

Venue spreads vs `VENUE_SPREAD_WIDTH_BOUND_BPS = 10` (`packages/shared/src/bounds.mjs:20`):

| market  | binance | bybit | okx  | whitebit | mexc | kraken | healthy |
|---------|---------|-------|------|----------|------|--------|---------|
| ETH/USD | 0.04    | 0.04  | 0.04 | 0.04     | --   | --     | 4       |
| SOL/USD | 0.85    | 0.86  | 0.85 | 5.43     | --   | --     | 4       |
| WBT/USD | absent  | absent| absent| 1.16    | 28.9 | 30.1   | 1       |

MEXC and Kraken do list WBT but quote ~3x wider than the bound, so adapters for them
would produce ticks the aggregator rejects. WBT is WhiteBIT-only in practice.

WhiteBIT WBT books (both inside the 10 bps bound, mids agree to 0.23 bps):

| book      | 24h quote volume | spread   | top-of-book depth |
|-----------|------------------|----------|-------------------|
| WBT_PERP  | $140.8M          | 3.12 bps | ~$680 / ~$1,140   |
| WBT_USDT  | $68.9M           | 1.04 bps | ~$3,990 / ~$4,019 |
| BTC_USDT  | $113.6M          | --       | --                |

## Locked decisions

1. **ETH/USD + SOL/USD** — list on-chain with default params (100x, $1M OI, group 0,
   fee 0), matching BTC. Claude executes the broadcast.
2. **WBT/USD** — WhiteBIT only, fed by **two independent books**: `WBT_USDT` (venue id
   `whitebit`) and `WBT_PERP` (new venue id `whitebit_perp`), with a per-market
   `minHealthyVenues = 2`.
   Rationale: at `minHealthyVenues = 1` the leave-one-out deviation check in
   `aggregator.mjs:106-126` silently does nothing — `others` is empty, the tick is pushed
   to `healthy` unchecked. Two books restore the cross-check; a book that diverges past
   `VENUE_DEVIATION_BOUND_BPS = 50` causes both to be rejected, yielding `noData` and no
   signed report, which is the safe failure.
3. **WBT risk caps** — 25x (`MARKET_MAX_LEVERAGE=2500`) and $100k OI
   (`MARKET_MAX_OI=100000000000`), vs BTC's 100x / $1M. Both are existing env vars on
   `runAddMarkets()`; no code needed for the caps themselves.

Residual risk accepted by the user: WBT's index has a single **exchange** as its trust
root. Two books reduce book-level failure, not venue-level. On-chain the only backstop is
`CONTRACT_MAX_DEVIATION_BPS = 500` — the signed report (`packages/reporter/src/report-v2.mjs:21-31`)
carries no venue count, and no contract enforces one.

## Phase 1 — list ETH/USD and SOL/USD on-chain (no code)

- [x] 1.1 Pre-flight: confirm the **running** publisher serves ETH/USD and SOL/USD.
      `PUBLISHER_MARKETS` overrides rather than extends `MARKET_FEEDS`, so a market can be
      listed on-chain and never priced. **PASSED** — `whitespace-publisher.service` is
      active on `whitespace@65.21.53.147`; `curl 127.0.0.1:8787/status` (2026-09-22)
      returns all three feeds healthy on 4 venues:

      | feed    | healthyCount | degraded | index      |
      |---------|--------------|----------|------------|
      | BTC/USD | 4            | false    | $86,140.03 |
      | ETH/USD | 4            | false    | $2,755.42  |
      | SOL/USD | 4            | false    | $117.55    |

      ETH and SOL are already being priced in prod; only the on-chain pair is missing.
      No publisher restart or config change is needed for Phase 1.
- [x] 1.2 Dry-run `runAddMarkets()` with `MARKETS=ETH/USD,SOL/USD`. **PASSED** — 10 txs,
      1,226,988 gas @ 5.001 gwei = 0.00614 WBT. Verified beyond the call order: each
      `addPair`'s `bytes32 feed` is byte-identical to `asciiToBytes32Hex(name)` from
      `packages/shared/src/markets.mjs` (the function the publisher signs with), `from/to`
      rejoin to the feed name for `services/api/src/publisher.ts:106-108`, and both
      upkeep keys resolve to the deployed `priceUpKeep`.
      Roles confirmed against the chain: `registry.gov()` and `registry.manager()` equal
      the local `gov.json` / `manager.json` addresses.
- [x] 1.3 Broadcast. **DONE 2026-09-22**, but not via `forge --broadcast`: the 1874 RPC
      dropped 3 of 5 probe requests (one 15 s timeout), and two `forge script --broadcast`
      attempts died during re-simulation before sending anything — verified by
      `pairsCount()==1` and no `runAddMarkets` entry in `broadcast/`.
      Instead the 8 state-changing calls were replayed **from the dry-run's raw calldata**
      (`/tmp/ws-send.sh`), one at a time, each retried, with `pairsCount()` guarding both
      `addPair` calls against a double-send. All 8 landed `status=0x1` first attempt.
      The 2 skipped calls are `pairFundingFees(uint16)` — a public mapping auto-getter
      (`OstiumPairInfos.sol:55`) that forge records as a tx only because the interface
      omits `view`. Pure read; skipping saved ~102k gas and changed nothing.
- [x] 1.4 Verified on-chain: `pairsCount() == 3`; pair 1 = ETH/USD and pair 2 = SOL/USD,
      both feed-encoded correctly, 100x, group 0, fee 0, `openInterest(i,2) == 1e12`
      (non-zero — a zero cap cancels trades silently). All three upkeep keys registered.
- [x] 1.5 Verified on prod: `GET /markets` returns 3 rows, and `/price/1` + `/price/2`
      both return `"source":"publisher"` with 4 healthy venues and `degraded:false` —
      i.e. the new pairs resolve to a live publisher feed, not the stale chain fallback.
      Zero code changes in indexer, API or frontend, as designed.
- [x] 1.6 Recorded in `deployments/1874-operational.json`: `market` (object) became
      `markets` (array of 3), with tx hashes for the two new listings. The BTC record is
      unchanged apart from nesting. Two assertions in
      `services/indexer/test/decode.test.ts` (232, 242) were repointed to `markets[0]`;
      both resolve to identical values (`pairIndex 0`, `maxOpenInterest "1000000000000"`).

## Phase 2 — WBT support (code)

Thread a per-market bounds override. `computeIndex(ticks, now, bounds, weightOf)` already
takes bounds as a parameter, and `canSubmitLiquidation({..., minHealthyVenues})` already
accepts an override — both are currently fed only the global default.

- [ ] 2.1 `packages/shared/src/venues.mjs` — add `whitebit_perp` to `VENUE_IDS`/`VENUES`.
      Only markets whose `venueSymbols` name it will connect to it, so BTC/ETH/SOL are
      untouched.
- [ ] 2.2 `packages/shared/src/markets.mjs` — add the `WBT/USD` entry; rewrite the header
      comment, which currently documents WBT's *absence* as the motivating example.
- [ ] 2.3 `packages/shared/src/bounds.mjs` — add a per-market override map and a
      `boundsForMarket(feed)` helper beside `PUBLISHER_BOUNDS`. Keep the globals as the
      default for every market that has no entry.
- [ ] 2.4 `services/price-publisher/src/venues/` — register `whitebit_perp` reusing the
      existing WhiteBIT parser, and replace the three hardcoded `venueId === 'whitebit'`
      checks in `index.mjs` with a capability check on the module (`mod.createBook`).
      This file is the untested I/O layer — review it carefully.
- [ ] 2.5 `services/price-publisher/src/config.mjs` + `engine.mjs` — store resolved bounds
      **per feed** in the `state` map and pass `s.bounds` at the `computeIndex` call
      (`engine.mjs:55`). That is the single choke point; `sampleMark`, `signReportFor`,
      `/status` and `/health` all inherit it.
- [ ] 2.6 `services/price-publisher/src/server.mjs` — expose `minHealthyVenues` per feed in
      `/status`. Today `degraded` is published without the threshold that produced it, so
      no consumer can tell which rule applied.
- [ ] 2.7 `services/liquidator/` — `chainReader.mjs` returns the threshold alongside the
      count; `liquidatorEngine.mjs:72` passes it to `canSubmitLiquidation`. Without this
      the liquidator refuses to ever liquidate WBT. `degradedMode.mjs` needs no change.
- [ ] 2.8 `services/api/` — carry `minHealthyVenues` (and `healthyCount`, currently
      dropped) through `publisher.ts` and `routes/price.ts`. Re-check the
      `feed.degraded` skip at `indexSeries.ts:188` so WBT records candles.
- [ ] 2.9 `apps/web/` — replace hardcoded copy with the per-market threshold:
      `OpenPositionForm.tsx:377` ("fewer than 3 healthy venues"), `DegradedBanner.tsx:19`
      ("minimum 3 required"), plus `types.ts` and the `DocsArticle.tsx:451` re-export.
- [ ] 2.10 Update tests that pin the global 3: publisher `aggregator`/`engine`/`server`,
      liquidator `degradedMode`/`liquidatorEngine`, api `price`, web `OpenPositionForm`
      and the `trade-flow` e2e.
      **Baseline first**: the e2e is known red at HEAD (`mockChain` missing PairInfos
      functions). Capture the failure list *before* this diff, or the red gets blamed on it.

## Phase 3 — list WBT/USD on-chain

- [ ] 3.1 Confirm the publisher serves `WBT/USD` with `healthyCount: 2`, `degraded: false`.
- [ ] 3.2 Dry-run `runAddMarkets()` with `MARKETS=WBT/USD`, `MARKET_MAX_LEVERAGE=2500`,
      `MARKET_MAX_OI=100000000000`. Separate run from Phase 1 — the env vars apply to
      every market in a run, and WBT's caps differ.
- [ ] 3.3 Broadcast, then verify `pairs(3)` and its OI cap and leverage on-chain.

## Verification gate

- [ ] Whole-repo lint + typecheck + unit tests green, with output quoted.
- [ ] `pairsCount()` read from the live chain after each broadcast, not inferred.
- [ ] Publisher `/status` shows every listed market non-degraded.
- [ ] Explicitly state what was NOT verified.

## Notes / hazards

- 1874 has a single public RPC with aggressive 429s — one `cast call` already failed
  during research. Retry rather than concluding a contract is unreachable.
- Never print or commit `GOV_PRIVATE_KEY` / `MANAGER_PRIVATE_KEY`.
- Stage files explicitly; the tree already has an unrelated modification
  (`apps/web/tsconfig.tsbuildinfo`).

## Review

_(changed / verified / left — filled in at the end)_
