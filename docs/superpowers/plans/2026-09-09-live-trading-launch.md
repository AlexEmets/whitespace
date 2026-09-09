# Plan: live trading launch (phases A–G)

Design: `docs/superpowers/specs/2026-09-09-live-trading-launch-design.md`.
Every step states the **read** that closes it. A receipt is not a gate (design §6).

## Phase A — Oracle migration

### A1 — Signer set and per-feed upkeep key
- [ ] Generate `~/.whitespace-keys/signer-2.json` … `signer-5.json` (same shape:
      `[{address, private_key}]`, mode 600). Never printed, never committed.
- [ ] `Operate.s.sol`: replace the `PRICE_UPKEEP_KEY` constant (`:68`) with a `feedKey`
      argument on `installHardenedUpkeep`, `registerUpkeep`, `_requireHardenedUpkeep`
      and the readers at `:574`/`:580`. `OracleConfig` carries it.
- [ ] Update `OracleHardening.t.sol` and `Operate.t.sol` call sites.
- **Closes on:** `forge test` green, and a new test registering two distinct feed keys
  that resolve to two distinct upkeep addresses.

### A2 — Anvil rehearsal
- [ ] `anvil` → `Deploy.s.sol run()` → `Operate.s.sol run()` → `runOracle()`.
- [ ] Record gas for each of the five oracle steps.
- **Closes on:** `verifier.threshold()==3`, `signerCount()==5`, registry
  `ostiumVerifier` → hardened instance, `BTC/USDPriceUpkeep` → `WhitespacePriceUpKeep`,
  `maxAge()==10`, `maxDeviationBps()==500`, `isForwarder(keeper)==true`.

### A3 — Deploy to 1874
- [ ] Assert the pending-order queue is empty (design D3) by reading storage, before
      anything is sent.
- [ ] Check `owner` balance covers the A2 gas estimate with margin.
- [ ] `runOracle()` against 1874. Update `deployments/1874.json` with both addresses.
- **Closes on:** the same six reads as A2, executed against 1874 over RPC.

### A4 — Real report accepted on chain
- [ ] Run `services/price-publisher` against binance/bybit/okx/whitebit.
- [ ] Take a genuinely signed k=3 report from `GET /v2/report` and deliver it.
- **Closes on:** the upkeep's last-accepted price for `BTC/USD` equal to the report's
  price, read back from chain. First time publisher bytes reach a live chain.

## Phase B — Stack orchestration

### B1 — Service configuration
- [ ] `.env.example` for `price-publisher`, `keeper`, `liquidator`, `indexer`, `api` —
      every variable each `config` module reads, commented, **names only**.
- **Closes on:** a diff of example keys against the keys each config reads, empty
  both ways.

### B2 — Supervisor
- [ ] `tools/stack/run.mjs`, dependency-free (matches `packages/metrics` house style):
      ordered boot, health gating, prefixed interleaved logs, clean shutdown.
- [ ] Root `stack:up` / `stack:down` scripts. `.nvmrc` pinning Node 22.
- **Closes on:** one command, then `/health` 200 on api, publisher and liquidator.

### B3 — Postgres and backfill
- [ ] Create the database; run Ponder to 100 % (currently 39–52 %, RPC-limited).
- **Closes on:** the four `proofTrade` tx hashes in `1874-operational.json` present in
  the indexed tables, and `/positions/:trader` returning the closed position's history.

## Phase C — First live browser trade (the gate)

- [ ] Full stack up, publisher on BTC/USD, keeper watching.
- [ ] Browser: connect, faucet/approve `USDW`, open a 10× long.
- [ ] Keeper observes `PriceRequestedV2`, fetches the k=3 report, `performUpkeep`.
- [ ] Close the position from the UI.
- **Closes on:** position visible in `/positions/:addr` between open and close;
  collateral delta reconciling to the unit; zero `pageerror` in the browser console;
  tx hashes recorded in `deployments/1874-operational.json`.

## Phase D — Liquidation

- [ ] Deploy + register `OstiumTradesUpKeep` (vendored, present, never deployed).
- [ ] `~/.whitespace-keys/liquidator.json`, funded from `owner`.
- [ ] Wire the liquidator's `txSender` (today `null` → `tradesUpKeep_not_configured`).
- [ ] Source candidates from the indexer rather than raw logs.
- **Closes on:** a position taken below maintenance margin and liquidated automatically,
  with the liquidator's `liquidations_won` counter incrementing.

## Phase E — ETH/USD

- [ ] `addMarket` pairIndex 1 + maxOI + funding + vault allowance + its own
      `ETH/USDPriceUpkeep` key (needs A1).
- [ ] Publisher on both feeds.
- **Closes on:** `haltFeed("BTC/USD")` leaving ETH signing and delivering normally —
  phase-2 open item 5, untestable with one market.

## Phase F — Frontend

Twelve items, design §5. Independent of each other; parallelisable.
- **Closes on:** no `—` in any field the mockup shows populated; `tsc --noEmit` clean;
  `next build` clean; unit + e2e green; a screenshot diff against both PDFs reviewed.

## Phase G — Hardening

- [ ] Review and commit `SystemFixture.sol`, `adversarial/Liquidation.t.sol`,
      `adversarial/KeeperCensorship.t.sol` (23 tests, currently untracked).
- [ ] Write `docs/decisions/phase-7-hardening.md` — referenced twice by
      `SystemFixture.sol:29,94`, does not exist.
- [ ] Extend `.github/workflows/ci.yml` past forge+tools to the packages and services
      suites: 273 test cases currently never run in CI.
- **Closes on:** CI green on a branch with all suites enabled.

## Hazards carried into this plan

- **Silent success.** Assert state, never receipts (design §6).
- **Gas is human-gated.** The faucet needs a CAPTCHA. Everything is rehearsed on anvil
  before it touches 1874. Budget from A2's measurements against 0.2070 WBT on `owner`.
- **`OstiumTrading` has 162 bytes of EIP-170 headroom.** Do not touch optimizer runs,
  metadata, `via_ir`, solc or evm version. Only `forge build --sizes` catches overflow.
- **The vendor tree is byte-identical to upstream `8390ce49`.** New behaviour goes in
  new files under `src/oracle/`, never as a vendor edit.
- **Uncommitted work is not mine.** The three untracked test files are left untouched
  until phase G, and reviewed with the user before they are committed.
