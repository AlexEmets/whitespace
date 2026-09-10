# Design parity + finish the product

Owner's ask: the terminal does not look like `docs/design/terminal_design.pdf`; the chart must
be dynamic and zoomable; show an order book; finish everything else.

## Decisions taken (owner, 2026-09-10)

1. **Order book slot** → a real **price-impact ladder** computed from on-chain params
   (`getDynamicTradePriceImpact` / `_priceImpactFunction` in `TradingCallbacksLib.sol`).
   The protocol has no resting orders; this is the honest analogue and it is what the vault
   actually fills you at. NOT a fabricated book.
2. **Markets** → list **ETH/USD and SOL/USD on chain**. Dry-run first, operator broadcasts.
3. **Faucet** → a "Get testnet USDW" affordance in the UI, so any connected wallet can trade.
   (`USDW.claim()` already exists; `useErc20.claimFaucet` is wired but has no button.)

## A green light that was measuring nothing

`pnpm test:packages` exited 0 having run **zero** tests — none of the three packages defined
a `test` script, so `pnpm -r --filter` matched them and found nothing to do. It was reported
upward as "packages ok" on the strength of that exit code. Fixed by giving each package the
one-line script it was always assumed to have; the gate now reports shared 41 / reporter 13 /
metrics 6.

CI is worse and is NOT fixed here: `.github/workflows/ci.yml` runs only `forge build`,
`forge config` and `forge test`. Every JS test in the repo — web 220, api 54, publisher 62,
liquidator 46, keeper 21, packages 60, tools 19 — has never run in CI.

## Workstreams

- [ ] **Chart** — live via WS, wheel-zoom + drag-pan, price/time axes, grid, crosshair OHLC readout
- [ ] **Depth ladder** — on-chain price-impact math, live, matching the mockup's PRICE/SIZE/TOTAL shape
- [ ] **Pages** — Portfolio (real cross-market account view), Points (honest: real volume/fees, no
      invented totals or ranks), Docs (real protocol documentation grounded in `docs/`)
- [ ] **Markets on chain** — parameterised `addMarketFor` + `runAddMarkets`, oracle feed keys,
      publisher config, venue symbols. Dry run only until the operator approves.
- [ ] **Order form** (mine) — faucet button, real `Est. liq. price` via
      `IOstiumPairInfos.getTradeLiquidationPrice`, size shown in base asset per the mockup
- [ ] **Terminal chrome** (mine) — tab counts (`POSITIONS · 2`), markets rail with volume/change,
      globals.css integration of everything above

## Found, not mine to touch

`contracts/script/Operate.s.sol` holds the owner's **uncommitted** "Phase D — liquidation"
implementation (`installTradesUpKeep`, `authoriseLiquidator`, `runLiquidation`). That is exactly
the missing piece that makes positions liquidatable — `OstiumTrading.sol:123` gates liquidation on
a `tradesUpKeep` registry key that was never set. Left untouched; flagged to the owner. All agents
were told to keep it byte-identical.

## The outage found while doing this — most important thing here

**The price publisher had been dead for 9.6 hours and could not recover on its own.**

All four venue WebSockets were half-open: the peers had gone without sending a FIN or an
RST, so the TCP connections stayed `ESTABLISHED` and `ws` emitted neither `error` nor
`close`. The reconnect loop in `services/price-publisher/src/venues/index.mjs` was armed
only on those two events, so `connect()` was never rescheduled. Result: `healthyCount: 0`,
`noData: true`, not one tick published, no candle written for 9.6 h — and, because the
keeper has no signed report to deliver, **no order could be filled at all**. A total
product outage, not a degradation.

It went unnoticed because `GET /health` answered a hardcoded `{ok: true}`, and that is the
only thing the stack supervisor and any monitor look at. A health check that cannot fail
is not a health check.

Fixed at the root, both halves:
- Liveness detection: periodic protocol PING plus an idle watchdog on any inbound frame,
  and `terminate()` (not `close()`, which waits for a FIN that never comes) before
  reconnecting. Single-reconnect guard so a watchdog eviction and the `close` it provokes
  cannot race two sockets into existence.
- `/health` now reports real venue counts and answers **503** when no feed has a live
  venue. The supervisor's gate actually gates on it.

Proven, not argued: `test/venueLiveness.test.mjs` stands up a real local WS server that
completes the handshake and then says nothing — including `autoPong: false`, without which
`ws` answers pings by itself and the "dead" peer looks alive (the test failed exactly that
way first). Three cases: a silent peer IS reconnected, a healthy one is NOT recycled, and a
stopped venue stays stopped. 3/3.

## Two things measured, and one hypothesis that was wrong

- **RPC rate limiting is real but not fatal.** 24,094 rate-limit errors in the indexer log,
  and still current (271 per 3,000 recent lines). But bursts of 40 `eth_blockNumber` and 8
  concurrent `eth_getLogs` all return 200, so it is sustained load, not a low ceiling.
- **The indexer was 4.2 h behind and I nearly restarted it.** Measured first: it advances
  735 blocks per 90 s against a chain doing 91 — the gap is closing at ~644 blocks/90 s,
  roughly 32 minutes to catch up. It was recovering on its own. No action taken.

## Review

**Changed (mine)**
- `services/price-publisher`: venue-socket liveness (ping + idle watchdog + terminate);
  truthful `/health` with a 503; `indexBid`/`indexAsk` exposed on `/status`.
- `services/api`: `bid`/`ask` on `GET /price/:pairIndex` (null on the chain fallback and
  when there is no two-sided aggregate — never the mark substituted).
- `apps/web`: faucet button; real liquidation price in both the positions table
  (`getTradeLiquidationPrice`) and the order form (`getTradeLiquidationPricePure` at
  rollover=funding=0); tab counts; two-line markets rail with abbreviated 24h volume;
  derived position size; `formatCompactMoney`.
- `tools/stack/run.mjs`: publisher gate now gates; api gate no longer blocks on lag (a
  missing `sync_status` row still does) and reports STALE loudly instead.

**Fixed along the way**
- `pairOpeningFees` was declared non-`view` in our ABI (copied from the interface, but it
  is a public mapping getter) — wagmi rejected the entire read surface once a genuinely
  `view` entry was added next to it.
- `PriceResponse.healthyVenues` was typed `number`; the API has always sent an array of
  venue names. `DegradedBanner` was printing the array where it meant a tally.
- `useLiquidationPrice` returned wagmi's cached value even when the read was disabled.

**Left**
- `priceImpactK == 0` on this deployment: `setPairDynamicSpreadParams` is called by no
  script, so size-dependent impact was never configured. One governance call would enable
  it. Not made.
- Indexer `test/decode.test.ts` fails on fixtures captured against the retired upkeep
  (`0x3ce549f5…`); the oracle migration in `e229d37` never re-captured them. Pre-existing,
  untouched.
- Liquidator still has no key and `OstiumTradesUpKeep` is still not installed — though the
  owner's uncommitted Phase D work in `Operate.s.sol` is exactly the missing piece.
- Nothing committed.
