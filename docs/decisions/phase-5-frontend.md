# Phase 5 — Trading frontend (`apps/web`)

**Date:** 2026-09-08
**Scope:** Next.js/wagmi/viem trading UI on Whitechain testnet 1874, against the D3 read
API contract (mocked for dev/test — `services/api` is a concurrent, separate effort).
**Completion gate:** a mouse-driven trade from deposit to close, exercised end-to-end by
Playwright against a mocked chain and a mocked API. **Both E2E scenarios pass.**

Partway through this task the coordinator delivered two design mockups
(`terminal_design.pdf`, `landing_design.pdf`, read from the parent checkout root) with a
brand identity ("WHITESPACE"), an IA (landing + trade + vaults + points/portfolio/docs),
and eight explicit design-honesty rulings. Everything below reflects the *post-redesign*
state; the rulings and how each was resolved are in their own section.

---

## What was built

```
apps/web/
├─ src/
│  ├─ app/
│  │  ├─ page.tsx            landing page (hero, ticker, stat tiles, markets table)
│  │  ├─ trade/page.tsx      the trading terminal
│  │  ├─ vaults/page.tsx     LP deposit/withdraw
│  │  ├─ points/, portfolio/, docs/   "coming soon" stub pages
│  │  └─ layout.tsx, globals.css      shared shell, brand CSS tokens
│  ├─ components/            NavHeader, WalletConnect, ChainGuard, DegradedBanner,
│  │                         PriceChart (candlesticks), OpenPositionForm, PositionsList,
│  │                         OrdersList, FillsList, VaultPanel, Money, TickerStrip,
│  │                         MarketsTable, StubPage, terminal/{MarketsRail,
│  │                         MarketHeaderBar, DepthPanel, TerminalTabs}
│  ├─ hooks/                 useLiveResource (REST-poll + WS), usePrice, useMarkets,
│  │                         useCandles, usePositions, useOrders, usePositionHistory,
│  │                         useMarket24h, useHealth, useErc20, useOpenTrade,
│  │                         useCloseTrade, useVault, useMarketFees, useChainGuard
│  └─ lib/                   money.ts (decimal safety), pnl.ts, api.ts, ws.ts, abi.ts,
│                             config.ts, deployment.ts, types.ts, wagmiConfig.ts
├─ tests/unit/                8 vitest files, 58 tests
└─ tests/e2e/                 mock chain (real ABI decode/encode), mock backend
                               (page.route over D3), 2 Playwright scenarios
```

**Wallet / chain.** `wagmi` + `viem`, a single `injected()` connector (deliberately not
importing `wagmi/connectors` — see the comment in `src/lib/wagmiConfig.ts`: that package's
barrel drags in Coinbase's `cdp-sdk`, which references unpublished `@x402/*` packages and
broke the production build even though this app never uses that connector). Chain 1874 is
defined from `@whitespace/shared/chains`' registry, not re-typed. `ChainGuard` prompts a
switch when connected to the wrong chain.

**Reads** go through `/health`, `/markets`, `/markets/:pairIndex/candles`,
`/positions/:address[/history]`, `/orders/:address`, `/price/:pairIndex` (D3), each with a
REST poll plus a WS subscription for faster updates (`src/hooks/useLiveResource.ts`) —
the poll is the correctness guarantee, the socket is just a latency improvement; design §7
treats "RPC/socket down" as an expected condition, not an exception.

**Writes** go directly to the contracts, wallet-signed, never through the API:
`openTrade`, `closeTradeMarket` (Trading), `requestDeposit`/`claimDeposit`/
`requestWithdraw`/`claimWithdraw` (Vault), `approve`/`claim` (USDW faucet). ABIs in
`src/lib/abi.ts` are transcribed from the real vendor interfaces with a `// source:`
comment on every entry, not guessed. Addresses come from `deployments/1874.json`, read via
`src/lib/deployment.ts`, not copy-pasted.

**New real reads added mid-task** (`src/hooks/useMarketFees.ts`): `IOstiumPairInfos
.pairOpeningFees` (maker/taker %, PRECISION_6) and `IOstiumPairsStorage.pairOracleFee`
(flat USDC fee, PRECISION_6) — added specifically so the order-entry panel's fee line
could be a genuine on-chain read instead of the mockup's numbers (ruling #7).

---

## Decimal safety

Everything monetary — price (18 decimals), collateral (6), leverage (2, PRECISION_2) —
is parsed and formatted exclusively through `src/lib/money.ts`, which:

- Takes only `bigint` or a strict decimal **string** (`MoneyInput`). **Every public
  function calls `assertNotNumber()` first and throws `MoneyTypeError` if given a JS
  `number`** — not just a TypeScript type, a runtime guard, because TS types are erased
  at build time.
- `parseRawUnits` parses the raw scaled-integer strings the API delivers per D3
  ("`65001000000000000000000` → 65,001.00", never a pre-formatted decimal).
- `parseHumanDecimal` parses user-typed input (a collateral field), **truncating** extra
  fractional digits rather than rounding — rounding up would silently take more of a
  trader's money than they typed.
- `formatMoney` rounds **half-up in bigint** (comparing `remainder * 2n` against the
  divisor) when reducing to display fraction digits — never touches floating point.
- `formatLeverage`/`formatBps` are the same machinery specialised for PRECISION_2/bps
  display.

**Test coverage.** `tests/unit/money.test.ts` (25 tests) formats the exact numbers from
`deployments/1874-operational.json`'s `proofTrade` — `65001000000000000000000` → the
literal string `"65,001.00"`, `999000000` → `"999.00"`, leverage `1000` → `"10.00x"` — and
includes the explicitly-requested test that a `number` reaches every money function and
is rejected (`formatMoney`, `parseHumanDecimal`, `parseRawUnits`, `formatLeverage`, and
the `<Money>` component all have a dedicated throw-test).

**This guard caught two real bugs while building the app**, not hypothetically:

1. `useOpenTrade.ts` — viem types a Solidity `uint32` (`Trade.leverage`) as JS `number`,
   not `bigint` (only wider `uint64+` fields decode to `bigint`). The write call needed
   `Number(leverageRaw)` at that exact boundary, documented in a comment explaining why
   it's safe there (leverage is bounded, well under `Number.MAX_SAFE_INTEGER`) and nowhere
   else.
2. `useMarketFees.ts` — `pairOpeningFees` returns three `uint32` fields; passing them
   straight into `formatMoney` threw `MoneyTypeError` at runtime the first time the panel
   rendered in the Playwright run, which is exactly the guard doing its job. Fixed by
   converting at the read boundary (`BigInt(openingFeesData[0])`), not by loosening the
   guard.

`estimateUnrealisedPnl` and `estimatePositionSizeBase` (`src/lib/pnl.ts`) are the one
UI-only exception to "never compute money without going through money.ts" — they *are*
`money.ts`-safe (bigint throughout, `parseRawUnits` at the boundary) but are explicitly
documented as **display estimates**, not settlement truth: the real PnL/size math lives
in `TradingCallbacksLib` on-chain and includes spread, price impact, funding and rollover
fees this app does not reproduce.

---

## Two-phase order flow (design §5.1)

- **Slippage is displayed explicitly**, not in an advanced panel: a range slider with the
  live percentage next to it, defaulting to 50 bps (0.50%), plus a sentence explaining
  exactly what it protects against ("the execution price... moves against you by more
  than X%, the order is cancelled and your collateral is refunded, minus the oracle fee").
  Verified `slippageP`'s unit numerically *is* bps by reading
  `contracts/src/vendor/ostium/OstiumTrading.sol:28` (`PERCENT_BASE = 100e2`) and the
  actual check in `lib/TradingCallbacksLib.sol:210` (`wantedPrice * slippageP / 100 /
  100`) — not assumed.
- **After `openTrade` confirms, the UI does not say "position opened."** It shows: *"Order
  requested (id N). Nothing has happened yet — the transaction only recorded your
  request. The position opens, or the order is cancelled, once a keeper delivers the
  signed price report."* The banner then polls `/orders/:address` and flips to "Filled —
  your position is now open" or a cancellation with the real `CancelReason` (transcribed
  from `IOstiumTradingCallbacks.sol`) and a plain-English explanation
  (`src/lib/abi.ts:explainCancelReason`).
- Closing carries the identical honesty: "Close requested — pending keeper execution,"
  not "Closed."
- Order status field shapes (`/orders/:address`) are **not fully specified by D3** beyond
  "pending orders" — `src/lib/types.ts` documents the assumed shape (`orderId`,
  `pairIndex`, `buy`, `collateral`, `leverage`, `status`, `cancelReason?`, `tradeId?`) and
  flags it as something to reconcile with the `services/api` team once it exists.

---

## Degraded mode (design §5.2/§7)

`GET /price/:pairIndex`'s `degraded`/`healthyVenues` fields pass straight through
`usePrice`. Two independent layers, not one:

1. `DegradedBanner` (rendered by `PriceChart`) — a clear red banner naming the healthy
   venue count against the 3-venue minimum.
2. `OpenPositionForm` **independently** checks `price.degraded` and both disables the
   submit button (`canSubmit` requires `!isDegraded`) and shows its own inline message —
   belt-and-braces, so a bug in one surface doesn't silently let a trader submit an order
   the system already decided not to price. Closing stays enabled throughout (no
   `isDegraded` check anywhere in `useCloseTrade`/`PositionsList`).

Covered by a dedicated Playwright scenario (`opening is blocked in degraded mode, closing
stays allowed`) and unit tests in `OpenPositionForm.test.tsx`.

---

## The eight design-honesty rulings

| # | Ruling | Resolution |
|---|---|---|
| 1 | No fake order book | `components/terminal/DepthPanel.tsx` — explicit "no order book" empty state citing design §3.2, not fake bids/asks. Attempting the real price-impact-by-size curve (Hill-function, `IOstiumPairInfos`) was judged too large a surface to get right within this task's remaining time — a wrong price-impact number is exactly the class of bug this app's decimal rules exist to prevent, so it was left honestly unavailable rather than guessed, per the ruling's own explicit permission. |
| 2 | "Deep books" copy | Landing hero now reads "Oracle-priced, 50× leverage, and an interface that gets out of the way of the tape." |
| 3 | No padded markets list | `TickerStrip`, `MarketsRail`, `MarketsTable` all map directly over `/markets` — currently renders exactly one row (BTC/USD). |
| 4 | TWAP disabled | Order-type tab present, `disabled`, tooltip "Not implemented in the contracts (no TWAP order type)." LIMIT/STOP are real on-chain order types (`IOstiumTradingStorage.OpenOrderType`) but their full resting-order management UI (place/list/cancel) was out of scope for the original phase-5 brief ("direction, collateral, leverage, slippage" = market orders) — also shown disabled with an honest tooltip, not omitted, not silently claimed working. |
| 5 | Isolated, not cross | `MarketHeaderBar` and `OpenPositionForm`'s doc comments: "Isolated · Nx max," sourced from `/markets`' `maxLeverage`. |
| 6 | Real per-market leverage | Terminal always shows the real value (currently 100x for BTC/USD). Landing's "MAX LEVERAGE 50×" stat tile is kept as the mockup's own marketing figure — explicitly sanctioned by the ruling ("if the product owner's number") since the mockup itself specifies 50×. The two intentionally differ; flagged here per the ruling's instruction. |
| 7 | Real fees | `useMarketFees.ts` reads `pairOpeningFees`/`pairOracleFee` live from chain. Landing's TAKER FEE tile and the order panel's "Fee · maker/taker" line both show the real read (currently 0.00%/0.00%, matching the ruling's stated live config), never the mockup's 0.010%/0.035%. |
| 8 | No invented points/portfolio | Points panel inside the order-entry form and the `/points` page both show "Coming soon" with no numbers. `/portfolio` and `/docs` are the same stub shell (`StubPage.tsx`). Landing's "REFERRAL SHARE 25%" tile is kept as static program-policy marketing copy (not a per-user total or rank, which is what the ruling explicitly forbids inventing) — a judgment call, flagged here rather than silently made. |

**Additional, not-in-the-ruling-list honesty gaps, self-imposed:** `FUNDING · 1H` (market
header) and the terminal's `FUNDING` tab both show an explicit dash/"coming soon" — D3 has
no funding-rate endpoint. `Est. liq. price` in the order summary and the positions table's
`Liq.` column both show a dashed, tooltipped "not available" — computing it correctly
would need on-chain funding/rollover accumulator state (`IOstiumPairInfos
.getTradeLiquidationPrice`) this app does not currently read; adding it was judged the
same class of risk as the depth ladder and left honestly unavailable. `24H VOLUME` and
`24H` change **are** computed (not invented) from real `/candles` data
(`src/hooks/useMarket24h.ts`, sums `Candle.v` and diffs first/last close over the last
25×1h candles) — shown as a dash only if there isn't yet enough candle history.

---

## Tests

**Unit (Vitest + Testing Library), 58 tests, all passing:**

```
$ pnpm exec vitest run
 ✓ tests/unit/Money.test.tsx (5 tests)
 ✓ tests/unit/ws.test.ts (4 tests)
 ✓ tests/unit/pnl.test.ts (9 tests)
 ✓ tests/unit/PositionsList.test.tsx (3 tests)
 ✓ tests/unit/abi.test.ts (3 tests)
 ✓ tests/unit/OrdersList.test.tsx (4 tests)
 ✓ tests/unit/OpenPositionForm.test.tsx (5 tests)
 ✓ tests/unit/money.test.ts (25 tests)
 Test Files  8 passed (8)
      Tests  58 passed (58)
```

**Typecheck:** `pnpm exec tsc --noEmit` — clean, no output.

**Production build:** `pnpm exec next build` — clean, 7 routes (`/`, `/trade`, `/vaults`,
`/points`, `/portfolio`, `/docs`, `/_not-found`), no warnings.

**E2E (Playwright + Chromium), 2/2 passing:**

```
$ pnpm exec playwright test --reporter=list
 ✓ opening is blocked in degraded mode, closing stays allowed (2.3s)
 ✓ connect -> deposit -> open -> pending -> filled -> close (16.3s)
 2 passed
```

`connect -> deposit -> open -> pending -> filled -> close` is the literal completion
gate: connects a fake wallet, deposits USDW into the vault (request → simulated
settlement → claim), opens a 10x long, verifies the honest pending state, advances the
mock "keeper" (a direct `TestState` mutation, not a timer race) to executed, verifies the
position appears with the *exact* independently-computed size (`+0.1538` BTC — computed
by hand in bash with the same bigint formula before being pinned in both the E2E
assertion and a dedicated `pnl.test.ts` unit test), then closes it and confirms the
positions list goes empty. The test also fails on **any uncaught client-side exception**
(`page.on('pageerror')` → asserted empty at the end) — this caught the two decimal bugs
above during development.

**Mocking architecture** (`tests/e2e/`): `installMockWallet.ts` is the one non-obvious
piece — wagmi uses *two different transports*. Wallet-signed writes go through the
connector's EIP-1193 provider (`window.ethereum`, injected via `page.addInitScript` +
bridged to Node via `page.exposeFunction`). Public reads (`eth_call`,
`eth_getTransactionReceipt`, ...) go through the `http()` transport configured in
`wagmiConfig.ts`, which POSTs JSON-RPC straight to the chain's RPC URL — **not** through
`window.ethereum`. Missing this initially sent every balance/allowance/receipt read to
the real Whitechain testnet RPC instead of the mock (silently reading zero balances).
Both paths now route to the same `mockChain.ts` handler (real ABI decode/encode via
`viem`, using the actual `src/lib/abi.ts`/`deployment.ts` the app itself uses — so the
mock can't silently drift from what the app really calls) against one shared
`TestState`. `mockBackend.ts` answers the D3 REST surface via `page.route` from the same
`TestState`.

**Explicitly not covered by E2E:** live WebSocket behaviour in a real browser (Playwright
WS route interception was judged not worth the added complexity for this gate — the app's
REST-poll fallback is what's exercised, which is also what a real dropped-socket user
would fall back to). The WS *message-handling* logic itself is unit-tested with a fake
`WebSocket` class (`tests/unit/ws.test.ts`). Real wallet extensions (MetaMask etc.) were
never driven — only the mocked EIP-1193 surface. Deep unit tests for the newer, purely
presentational components (`NavHeader`, `TickerStrip`, `MarketsTable`, `MarketsRail`,
`MarketHeaderBar`, `DepthPanel`, `TerminalTabs`, `FillsList`, `StubPage`, the landing
page) were not written given the time already spent — their money-bearing values (prices,
fees, sizes) all route through the same tested `money.ts`/`pnl.ts`, but their own render
logic is only exercised indirectly via the E2E run, not directly unit-tested. ESLint was
not configured/run for `apps/web` (no `eslint-config-next` wired up) — only `tsc
--noEmit`, `vitest`, and `next build`'s own type/lint pass, which did run and passed.

---

## Contradictions / open questions surfaced, not resolved

- **`/orders/:address` field shape** is not specified by D3 beyond "pending orders" —
  documented assumption in `src/lib/types.ts`, needs reconciling once `services/api`
  exists for real.
- **`openInterest.{long,short}` decimals** are assumed to be 6 (collateral-denominated,
  matching `IOstiumTradingStorage`'s general pattern) — D3 doesn't state this explicitly.
- **Landing's 50× / 25% marketing tiles** intentionally diverge from the terminal's real
  100× and the (absent) real referral data — see ruling #6/#8 resolutions above.
- **Est. liq. price and the price-impact depth ladder** are both left as honest
  "unavailable" states rather than built under time pressure — see rulings #1 and the
  self-imposed gaps section. If a future session tackles these, `IOstiumPairInfos
  .getTradeLiquidationPrice`/`getTradeLiquidationPricePure` and the Hill-function
  price-impact machinery (`DynamicSpreadParams`/`getPairPriceImpactK`) are the entry
  points, both already located and cited above.
- No contradiction was found between the API contract (D3) and the design spec — the one
  process deviation was the mid-task design-mockup pivot itself, handled per the
  coordinator's explicit rulings rather than improvised.

---

## Files of note

- `apps/web/src/lib/money.ts` — the decimal-safety module.
- `apps/web/src/lib/pnl.ts` — PnL/size estimation, UI-only.
- `apps/web/src/lib/abi.ts`, `apps/web/src/lib/deployment.ts` — the write surface and
  addresses, sourced not guessed.
- `apps/web/src/components/OpenPositionForm.tsx` — two-phase feedback, degraded gating,
  explicit slippage.
- `apps/web/src/components/terminal/DepthPanel.tsx` — the no-fake-order-book decision.
- `apps/web/tests/e2e/installMockWallet.ts` — the dual-transport mock, and why it exists.
- `apps/web/tests/unit/money.test.ts` — the decimal-exhaustiveness tests against the real
  `deployments/1874-operational.json` numbers.
