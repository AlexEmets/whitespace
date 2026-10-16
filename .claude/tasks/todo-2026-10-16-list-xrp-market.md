# List XRP/USD market — DONE (live)

Date: 2026-10-16
Chain: Whitechain testnet 1874
Deployment: the **live** pre-debrand one — registry `0x86d4EC32F8ed6e07D6176b71De05c9866A30c357`,
pairsStorage `0x2e5CcD43667fCE72e3EDE9Af5E3E1A10DBBA985A`, priceUpKeep
`0x1E0DBa1e028eE40A0096dD63eaBadB5b4A7c2c99`. **Not** the debranded redeploy at
`0xBc14f71f…` that `origin/main` HEAD's `deployments/1874.json` describes — prod has not
migrated to it (prod repo is at `77fb71f`, 5 commits behind), so the live site reads
`0x86d4`. XRP was listed where the site actually serves from.

XRP/USD is the ordinary four-venue case, identical in shape to ETH/USD and SOL/USD:
Binance/Bybit/OKX quote `XRPUSDT`/`XRP-USDT`, WhiteBIT quotes `XRP_USDT`. No bounds
override, default `MIN_HEALTHY_VENUES` (3 of 4), default caps (100x, $1M, group 0, fee 0).
No Solidity change — the generic `Operate.s.sol:runAddMarkets()` lists it.

## Phase 0 — code (committed, tests green)

- [x] `packages/shared/src/markets.mjs` — `XRP/USD` added (four standard venue symbols),
      registry header documents it as the ordinary four-venue case.
- [x] `packages/shared/test/markets.test.mjs` — named-markets guard includes `XRP/USD`
      plus a pinned test (four venues, standard symbols, feedId, no bounds override). Both
      new assertions confirmed **red** without the registry entry, green with it.
- [x] `services/price-publisher/.env.example` — stale `PUBLISHER_MARKETS` default
      (BTC/ETH/SOL only, predating WBT) corrected to the full current registry.
- [x] Verified (node 22 container; repo has no local node / installed deps, so only the
      dependency-free shared package was runnable): `markets.test.mjs` 8/8, whole shared
      suite 72/72. No other code enumerates the market set — publisher defaults to
      `MARKET_FEEDS`, keeper resolves via `getMarketByFeedId`, API reads the chain, web
      reads the API, and the web shared `.d.ts` mirror types markets as `Record`/`string[]`.

## Phase 1 — prod publisher serves XRP (surgical, DONE)

Did **not** run `deploy/deploy.sh`: it `git pull`s, which would drag prod onto the
debranded `0xBc14` contracts and strand live positions. Surgical instead:

- [x] 1.1 Copied the edited `packages/shared/src/markets.mjs` to prod
      (`whitespace@65.21.53.147:/home/whitespace/whitespace`); diffed against the live file
      first — strict superset, only the XRP additions. Backup:
      `packages/shared/src/markets.mjs.bak-2026-10-16`.
- [x] 1.2 Added `XRP/USD` to `PUBLISHER_MARKETS` in prod
      `services/price-publisher/.env` (now `BTC/USD,ETH/USD,SOL/USD,WBT/USD,XRP/USD`).
      Backup: `services/price-publisher/.env.bak-2026-10-16`. `node` import of the edited
      registry succeeded (no syntax error; feeds include XRP/USD).
- [x] 1.3 `sudo systemctl restart whitespace-publisher`; unit `active`.
- [x] 1.4 Gate passed: `curl 127.0.0.1:8787/status` → XRP/USD `healthyCount 4`
      `[whitebit,bybit,okx,binance]`, `minHealthyVenues 3`, `degraded false`, `noData false`.

## Phase 2 — list XRP/USD on-chain (DONE, live registry)

- [x] 2.1 Dry-run against `REGISTRY_ADDRESS=0x86d4…`: 4 calls, 561,233 gas (~0.0028 WBT).
      Decoded byte-perfect: `addPair(XRP, USD, feed XRP/USD, 100x, group0, fee0)`;
      `registerContract("XRP/USDPriceUpkeep" → 0x1E0DBa1e…)` (the live upkeep);
      `setMaxOpenInterest(4, 1e12)`. Keys `~/.whitespace-keys/{gov,manager}.json` derive to
      the live `gov 0xFB04…` / `manager 0xE2DA…` (simulation did not revert).
- [x] 2.2 Broadcast (`forge --broadcast --slow`): ONCHAIN EXECUTION COMPLETE & SUCCESSFUL,
      all four receipts `status=true`:
      - registerContract `0x7b4a3ff941896ac1209021eada6f4852d86c989074222e1c92fe4b1dcb1ed79b`
      - addPair          `0xf839968202a64341b45215d6d59420a9c99d12f0eacc1c3d8d5f97e291ccfe45`
      - setPairFundingFees `0x821ac0362a0b141a480edaf32eb8dea10b567d36e70e5cf120b666e0770af030`
      - setMaxOpenInterest `0x79167a9a29c77863381951d3bcd60ec6534f5d5c04d888c1c3f0cedb3556aa46`
- [x] 2.3 On-chain (read live, not inferred): `pairsCount() == 5`; `pairs(4)` = XRP/USD at
      100x, group 0, fee 0, feed byte-identical to `asciiToBytes32Hex("XRP/USD")`;
      `openInterest(4, 2) == 1e12` (non-zero); `XRP/USDPriceUpkeep` → `0x1E0DBa1e…`.
- [x] 2.4 Public API: `/api/markets` returns 5 rows, XRP at index 4 (100x / $1M);
      `/api/price/4` → `"source":"publisher"`, 4 healthy venues, `degraded:false`, live quote.

## Phase 3 — record (DONE)

- [x] Appended XRP/USD (pairIndex 4) to `markets` in `deployments/1874-operational.json`
      with the four tx hashes and the listing metadata.

## Left / hazards

- **Prod working tree is now dirty**: `packages/shared/src/markets.mjs` is modified
  (XRP added) on top of `77fb71f`, plus a `.bak-2026-10-16` and the edited (gitignored)
  `.env`. The next `deploy/deploy.sh` does `git pull --ff-only`, which will FAIL on the
  local modification. Before any future deploy, run on prod:
  `git checkout packages/shared/src/markets.mjs` then pull — `origin/main` already carries
  the identical XRP addition (this branch), so nothing is lost.
- **Two deployments on 1874.** XRP is on the live `0x86d4`. The debranded `0xBc14` redeploy
  at `origin/main` HEAD does NOT have XRP; whenever prod is migrated to it, XRP must be
  listed there too (same `runAddMarkets` with `REGISTRY_ADDRESS=0xBc14…`, which the dry-run
  already proved works).
- Not run here: publisher/reporter/liquidator/api/web suites (no local node / deps). Shared
  suite only.
