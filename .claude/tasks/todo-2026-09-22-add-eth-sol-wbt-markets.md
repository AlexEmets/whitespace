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

Baseline captured before any edit (2026-09-22): shared 41, price-publisher 62,
liquidator 46, api 54 — all green.

- [x] 2.1 `venues.mjs` — `whitebit_perp` added to `VENUE_IDS`/`VENUES`. Safe for existing
      markets: `main.mjs:41-42` skips any venue a market declares no symbol for.
- [x] 2.2 `markets.mjs` — `WBT/USD` added (`whitebit: WBT_USDT`, `whitebit_perp: WBT_PERP`);
      header rewritten, since it documented WBT's absence as the motivating example.
- [x] 2.3 `bounds.mjs` — `MARKET_BOUNDS_OVERRIDES` + `boundsForMarket(feed)`. Globals stay
      the default for every market without an entry.
- [x] 2.4 `venues/whitebit_perp.mjs` re-exports the WhiteBIT parser under a new `id`;
      the three `venueId === 'whitebit'` branches in `index.mjs` became one capability
      check (`typeof mod.createBook === 'function'`). Verified on a live socket first:
      one connection to wss://api.whitebit.com/ws accepts `depth_subscribe` for both
      `WBT_USDT` and `WBT_PERP` and streams `depth_update` for each.
- [x] 2.5 `engine.mjs` resolves bounds once per feed into `state` and passes `s.bounds` to
      `computeIndex`; `config.mjs` exposes `boundsFor: boundsForMarket`; `main.mjs` wires
      it. `boundsFor` defaults to `() => bounds`, which is why all 62 existing publisher
      tests kept passing untouched.
- [x] 2.6 `aggregator.mjs` now returns `minHealthyVenues` on the result, and `server.mjs`
      publishes it in `/status` and `/health`. Putting it on the aggregate rather than
      re-deriving it downstream is what keeps the layers from drifting.
- [x] 2.7 `chainReader.readHealthyVenueCount` → `readVenueHealth`, returning
      `{ healthyVenueCount, minHealthyVenues }` (falling back to the global minimum, which
      can only ever be stricter); `liquidatorEngine` passes both to `canSubmitLiquidation`.
      `degradedMode.mjs` unchanged — its override parameter already existed.
- [x] 2.8 `publisher.ts` and `routes/price.ts` carry `minHealthyVenues` through, null on
      the chain fallback. **`indexSeries.ts:188` needed no change**: `feed.degraded` is now
      computed per market upstream, so WBT at 2 healthy sources records candles normally.
- [x] 2.9 `types.ts`, `DegradedBanner.tsx`, `OpenPositionForm.tsx`, `PriceChart.tsx`,
      `DocsArticle.tsx`, `config.ts` — the hardcoded "3" is gone from user-facing copy;
      the threshold is rendered from the payload and omitted when unknown.
- [x] 2.10 Tests: +8 shared (new `bounds.test.mjs`; `markets.test.mjs`'s "every market has
      every venue" rule replaced with the stronger "enough known-venue symbols to meet its
      own threshold"), +6 publisher (new `perMarketBounds.test.mjs`), +1 liquidator,
      +7 web. Final: shared 49, publisher 68, liquidator 47, api 54, web 309 — all green,
      `tsc --noEmit` clean for web and api.

### 2.11 Found by running it, not by testing it

`venues/index.mjs` is the untested I/O layer, so the publisher was run live against the
real exchanges. Two defects surfaced that no unit test could have:

- [x] **`PUBLISHER_VENUES` pins the venue list — on prod too.** Both the local and the
      production `.env` carry `PUBLISHER_VENUES=binance,bybit,okx,whitebit`, and that
      OVERRIDES `VENUE_IDS` rather than extending it. The first live run connected only
      `whitebit` for WBT and sat at 1/2, degraded, with nothing in the logs explaining why
      — the same trap `.env.example` already documents for `PUBLISHER_MARKETS`.
      Fixed at the root: `main.mjs` now logs a `MISCONFIGURED` warning at startup naming
      the missing venues whenever a market's enabled sources cannot reach its threshold.
      Not fatal — one bad market must not take the healthy ones down. `.env.example`
      updated. **Prod `.env` still needs `whitebit_perp` added — see Phase 3.**
- [x] **The 2 s staleness bound made WBT unusable ~26% of the time.** With both books
      connected, WBT was degraded in 26 of ~100 steady-state samples, sometimes at zero
      healthy sources — both books merely quiet, not down.
      Measured the cause over 120 s rather than guessing: gaps between `depth_update`
      frames exceeded 2 s 17x on WBT_USDT (max 4,685 ms), 19x on WBT_PERP (max 5,548 ms)
      — **and 11x on BTC_USDT (max 4,483 ms)**. The bound has always been breached; four
      venues absorb it, two do not. It also conflates "book unchanged" with "feed dead",
      while dead sockets are caught separately by the 8 s ping / 20 s idle watchdog.
      Fixed with a second, measured override: `stalenessBoundMs: 8_000` for WBT — above
      the observed maximum, below the idle watchdog, and per-market so the four-venue
      markets keep the tight bound their redundancy pays for.
      Re-measured after the fix: **26 degraded samples → 2**.

## Phase 3 — list WBT/USD on-chain

- [x] 3.0 Prod `.env` updated (backup at `services/price-publisher/.env.bak-2026-09-22`):
      `whitebit_perp` added to `PUBLISHER_VENUES`, `WBT/USD` to `PUBLISHER_MARKETS`.
      Then `deploy/deploy.sh` — pulled `e1dfed5`, rebuilt, restarted the stack; all five
      units active and the running server postdates the build.
- [x] 3.1 Confirmed on prod after the deploy: `WBT/USD healthy=2/2 degraded=false`,
      venues `[whitebit_perp, whitebit]`, index 86.5955. No `MISCONFIGURED` warning, and
      both `connecting whitebit … (WBT_USDT)` and `connecting whitebit_perp … (WBT_PERP)`
      present in the startup log.
- [x] 3.2 Dry-run: 5 txs, 613,494 gas. `feed` byte-identical to the publisher's feedId,
      `maxLeverage 2500` (25x), `maxOI 100000 USD`, group 0, fee 0, pairIndex 3.
- [x] 3.3 Broadcast via the same per-tx calldata replay (4 sends, `addPair` guarded on
      `pairsCount == 3`); all `status=0x1` first attempt. Verified on chain:
      `pairsCount == 4`, `pairs(3)` is WBT/USD at 25x, `openInterest(3,2) == 1e11` ($100k).
      Prod API: `/markets` returns 4 rows, `/price/3` is `"source":"publisher"` with
      `minHealthyVenues: 2` and `degraded: false`.

## Phase 4 — change % for markets younger than 24h (follow-up request)

`useMarket24h` asked for 1h candles over 25h and returned null below two of them, so every
newly listed market showed a dash for change and volume while BTC showed real figures.

- [x] 4.1 `useMarket24h.ts` now walks progressively finer series — 1h/25h, then 5m/6h,
      then 1m/2h — and takes the first with two candles, falling back to a lone candle's
      open→close rather than showing nothing. It returns `windowSeconds` and `truncated`
      so the figure can be labelled with the period it actually covers.
- [x] 4.2 `MarketHeaderBar` printed a hardcoded `· 24h` beside the change; it now prints
      `formatWindowLabel(windowSeconds)`. `MarketsRail`, `MarketsTable` and `TickerStrip`
      disclose a short window in a `title` tooltip, since none has room for inline copy.
      Stale "currently one, BTC/USD" comments in the rail and ticker removed.
- [x] 4.3 New `tests/unit/useMarket24h.test.tsx` (6 tests); the hook had none. Web suite:
      24 files, 316 tests, `tsc --noEmit` clean.
- [x] 4.4 Verified against live prod candles: BTC +0.34% / 24h (25×1h), ETH +0.00% / 2h,
      SOL +0.17% / 2h, WBT −0.03% / 15m (fell through to the 5m series). All four render
      a number; the three young ones are flagged truncated.

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

**Changed.** Four commits on `main`, all pushed and deployed:
- `e77d531` ETH/USD and SOL/USD listed on chain 1874 (no code — the registry already had
  them; the deployment record's `market` object became a `markets` array).
- `e1dfed5` WBT/USD support: `whitebit_perp` as a second source, per-market bounds threaded
  through publisher → liquidator → API → frontend (30 files).
- `07b3a9c` WBT/USD listed at 25x / $100k.
- `552b9a7` change and volume now shown for markets younger than 24h, labelled with the
  window they actually cover.

**Verified.** On chain: `pairsCount() == 4`; each pair's `feed` byte-identical to
`asciiToBytes32Hex` from the publisher's registry; `openInterest(i,2)` non-zero for all
four. On prod: publisher reports BTC/ETH/SOL at 4/3 healthy and WBT at 2/2, none degraded;
`/markets` returns four rows with the right leverage and OI caps; `/price/1..3` all answer
`"source":"publisher"`; `/` and `/trade` return 200. Tests: shared 49, price-publisher 68,
liquidator 47, api 54, web 316 — all green, `tsc --noEmit` clean for web and api. The WBT
feed was measured live before and after the staleness fix (26 degraded samples per ~100 →
2), and the change figures were recomputed against real prod candles for all four markets.

**Left.**
- `services/indexer/test/decode.test.ts` fails at collection on a clean tree, unrelated to
  this work: `fixtures/open-report-tx.json` was captured before the phase-A oracle
  migration and does not contain the current `priceUpKeep` address from
  `deployments/1874.json`. Flagged, not fixed — it is someone's call whether to re-capture
  the fixture or pin the old address.
- The local dev `services/price-publisher/.env` was edited to add `whitebit_perp`; it is
  gitignored, so a second developer's copy will silently run WBT at 1/2 until they do the
  same. The startup `MISCONFIGURED` warning is what will tell them.
- WBT's index rests on one exchange. That risk was accepted deliberately and is bounded by
  25x / $100k, not removed. If WhiteBIT is wrong, both books are wrong together and only
  the on-chain `CONTRACT_MAX_DEVIATION_BPS` (500) stands between that and a filled order.
- Not measured: whether WBT's 2-of-2 feed stays healthy across a WhiteBIT maintenance
  window or a venue-side disconnect. The 100 s runs cover ordinary quiet, not an outage.
- `e2e` (`trade-flow.spec`) was not run; it is known red at HEAD for unrelated reasons
  (`mockChain` missing PairInfos functions), so it would not have been evidence either way.
