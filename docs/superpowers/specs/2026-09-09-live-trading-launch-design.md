# Live trading launch: from code-complete to a real trade

Status: approved 2026-09-09. Supersedes nothing; it is the operational layer over
`2026-09-08-whitechain-perp-dex-design.md` and the phases-2-7 plan.

## 1. The problem

Every component of this system is written and unit-tested. Nothing has ever run
together. Measured state on 2026-09-09:

| Layer | Code | Tests | Live |
|---|---|---|---|
| Ostium contracts | deployed on 1874 | 138 forge | one real BTC/USD round trip |
| Hardened oracle (k-of-N + rails) | 612 lines | 88 | **never deployed** |
| Price publisher (4 venues) | 898 lines | 58 | ran 15 s, never reached chain |
| Keeper | 512 lines | 21 | **`main.mjs` never executed** |
| Indexer + API | 1760 lines | 70 | 39–52 % backfilled, `/price` returns nulls |
| Liquidator | 1555 lines | 46 | **`OstiumTradesUpKeep` not deployed** |
| Frontend | 3181 lines | 60 | runs only against mocks |

Three blockers stand between this and a trade, in order of severity.

### B1 — The wire format is split

`deployments/1874.json:verifier` is `0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8`, the
**vendored `OstiumVerifier`**: 1-of-N, v1 report layout. `services/price-publisher`
emits **only** v2 (`packages/reporter/src/report-v2.mjs:57`) — nine fields, `chainId`
and `verifier` inside the signed bytes, k=3 of N=5 signatures sorted by recovered
address. The deployed contract cannot decode those bytes. The chain is severed at its
first link.

`WhitespaceVerifier` and `WhitespacePriceUpKeep` close it, and `Operate.s.sol:709
runOracle()` installs them — but that entrypoint has never run against a live chain.

### B2 — Liquidation is unreachable for every address

`Deploy.s.sol` never deploys `OstiumTradesUpKeep`, and liquidation is forwarder-gated.
No address on 1874 can liquidate an underwater position today. The vendored contract
exists at `contracts/src/vendor/ostium/OstiumTradesUpKeep.sol`, so this is a deployment
gap, not a development one.

### B3 — There is no way to start the system

No `docker-compose`, no `Makefile`, no process manager, and `.env.example` exists only
for `apps/web` — the other five services' configuration is discoverable solely by
reading their `config.mjs`. The environment runs Node `v20.18.1` against an
`engines: >=22` requirement.

Two facts work in our favour and were verified by direct probe, not assumed:
gas is available (`owner` holds 0.2070 WBT), and Postgres accepts connections locally.

## 2. Acceptance criterion

**A position opened and closed with a mouse, in a browser, against real Whitechain
1874, priced by a report the publisher derived from live exchange data and signed with
three of five keys.**

Local processes are fine. Public hosting is out of scope.

## 3. Locked decisions

### D1 — Signer set: five keys, one machine, stated plainly

`WhitespaceVerifier` is configured k=3 of N=5. Only `~/.whitespace-keys/signer.json`
exists, so four more are generated locally. All five therefore live on one host: this
proves the *threshold mechanism* and provides **no distributed-custody security**. That
sentence belongs in the decision doc verbatim, so no later reader mistakes a passing
k-of-N test for decentralisation.

### D2 — The upkeep registry key becomes per-feed

`Operate.s.sol:68` hardcodes `PRICE_UPKEEP_KEY = "BTC/USDPriceUpkeep"`. Ostium's
registry holds one upkeep key per feed, so ETH cannot be registered while that constant
is fixed. It becomes an argument threaded through `installHardenedUpkeep`,
`registerUpkeep`, `_requireHardenedUpkeep` and the readers at `:574`/`:580`.

### D3 — Migration runs only against an empty order queue

Swapping the upkeep while an order is pending strands that order permanently: the
callback resolves through the registry, and the retired instance is no longer
allowlisted. `OracleHardening.t.sol:860 OracleMigrationWindowTest` covers the property.
Operationally, the queue is **read and asserted empty** immediately before `runOracle()`
touches 1874 — not assumed empty because nobody is trading.

### D4 — Markets: BTC/USD and ETH/USD

Both already exist in `packages/shared/src/markets.mjs` with all four venue symbols, and
the design spec §1 fixes them. A second feed is not decoration: per-feed breaker
isolation (phase-2 open item 5) cannot be exercised with one market.

`WBT-PERP` from the landing mockup is **not implementable**. D4 of the phases-2-7 plan
requires a minimum of three healthy venues out of four; WBT trades on WhiteBIT alone, so
the feed would sit permanently degraded and never sign. It is dropped, not faked.

### D5 — The order book is a depth ladder from the price-impact curve

The terminal mockup shows PRICE/SIZE/TOTAL with depth bars. Whitespace has no resting
orders — the LP vault is the counterparty. `IOstiumPairInfos:251 getPairPriceImpactK`
(27 decimals) gives the curve along which execution price moves with size, so the ladder
is computed as "what you pay for size X" and rendered into the mockup's grid. The panel
labels it as vault depth, not as an order book. Every number is real.

### D6 — Points are derived, referral and TWAP are dropped

Points accrue as `Σ (notional × seconds at risk)` over indexed fills, in fixed 7-day
epochs, with rank taken from the epoch leaderboard. The mockup's "weighted by maker
depth" is unimplementable: this market structure has no makers. The formula is published
in the UI.

Referral (25 % of taker fees) needs a code registry, address binding and payouts — a
subsystem, not a panel. TWAP has no contract support (`OpenOrderType` is
`{MARKET, LIMIT, STOP}`) and as a client-side scheduler dies with the browser tab. Both
are removed from the interface rather than stubbed.

### D7 — LIMIT and STOP are built; they are contract-backed

`IOstiumTradingStorage:19` defines `OpenOrderType { MARKET, LIMIT, STOP }` and
`OstiumTrading.openTrade:191` takes it. The mockup's tabs map onto real contract
behaviour, and `/orders/:address` already serves pending orders.

## 4. Phases

Ordered by dependency. Each leaves the system coherent if work stops.

| # | Phase | Gate |
|---|---|---|
| A | Oracle migration to 1874 | a real publisher report is accepted on chain |
| B | Stack orchestration | `pnpm stack:up` → five services healthy, indexer 100 % |
| C | **First live browser trade** | position opened and closed via the real pipeline |
| D | Liquidation live | `TradesUpKeep` deployed, a liquidation fires automatically |
| E | ETH/USD market | second feed live, per-feed breaker isolation proven |
| F | Frontend to mockup fidelity | the twelve items in §5 |
| G | Hardening | 23 adversarial tests committed and running in CI |

C is the criterion in §2. A and B exist only to reach it. D follows C rather than
preceding it because the collateral is `USDW`, a faucet token — the exposure during that
window is play money, and the gate is worth reaching sooner.

## 5. Frontend scope

| Item | Data source |
|---|---|
| JetBrains Mono actually loaded | `next/font/google` — declared in CSS today, never fetched |
| Hero sphere | CSS, replacing the `[ BRAND RENDER ]` text placeholder |
| Est. liq. price | `IOstiumPairInfos:164 getTradeLiquidationPrice` via viem |
| Funding 1 h | `OstiumPairInfos` funding rate → `GET /markets/:pairIndex` |
| Index price | API polls publisher `/status`; `/price/:i` returns nulls today |
| 24 h volume | indexed fills |
| Depth ladder | `getPairPriceImpactK` (D5) |
| LIMIT / STOP tickets | `OpenOrderType` (D7) |
| Open Orders / Fills / Funding tabs | `/orders/:addr`, position history |
| Points panel | new indexer table + `GET /points/:address` (D6) |
| Portfolio page | positions, history, realised PnL |
| Landing: 50× → real max leverage; drop the 25 % tile | `GET /markets` |

## 6. Verification rule

This codebase's dominant failure shape is the **successful transaction that changes
nothing**. Phase 1.5 found three such steps: `setMaxOpenInterest`, `setPairFundingFees`
and `setVaultMaxAllowance` each returned a successful receipt and left a system where no
position could open, price delivery panicked, or opens could never be closed.

Therefore every step in every phase closes on a read of observable state, never on a
receipt:

- not "`runOracle` succeeded" but `verifier.threshold() == 3` and `signerCount() == 5`;
- not "`addMarket` succeeded" but `registry.getContractAddress("ETH/USDPriceUpkeep")`
  resolving to the hardened upkeep;
- not "the trade tx succeeded" but the position readable from `/positions/:address` and
  the collateral delta matching to the last unit.

A wrong price exponent never reverts either: 18 decimals for price, 6 for collateral,
2 for leverage.

## 7. Out of scope

Public hosting, TLS, a managed database, referral, TWAP, WBT-PERP, mainnet 1875, and
chain 2625. Mainnet carries a separate finding: `USDC.e` does exist there
(commit `c146330` corrected the earlier claim), so mainnet is a decision, not a blocker
— but it is not this document's decision.
