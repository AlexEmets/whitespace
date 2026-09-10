# Frontend live trading — make the terminal actually usable

Goal: stack up, chart rendering real candles, a position opened *from the UI* (not from a
forge script), and the result visible on screen.

## Findings that shaped the work

1. **`parseRawUnits` vs the API wire format.** `services/api/src/format.ts` emits every
   monetary field through `toDecimalString`, which always produces a decimal point
   (`"65001.000000000000000000"`). `apps/web/src/lib/money.ts` `parseRawUnits` rejects a
   decimal point by design. Every one of 20+ call sites feeding an API value into it threw
   `MoneyTypeError` at render time — chart, markets table, PnL, order form. The
   `toRawUnits` helper was written in a previous session and never wired in.
2. **The terminal quoted a frozen price.** `/price/:pairIndex` read the last on-chain
   `price_report`, i.e. the price of the last *order*. Measured 78,634.60 on screen against
   a live index of 78,117.06 — a 517 USD gap that only grows while nobody trades.
3. **The chart had no data to draw.** Candles were derived only from on-chain price
   reports, which land only when an order needs one. Three ticks across the market's entire
   history. Not a rendering bug — the series does not exist without trading.
4. **Approval never completed.** `writeContractAsync` resolves on broadcast, not on
   confirmation, and `handleApprove` refetched the allowance immediately — so the button
   reverted to "Approve USDW" after a perfectly good approval. Double gas, still blocked.
5. **The fill was unobservable.** `/orders/:address` served `status='pending'` only, so an
   order vanished the instant it resolved and the panel's "Filled"/"Cancelled" branches
   were unreachable. `cancelReason` was never in the payload at all, though both consumers
   render it.
6. Port 3000 is held by an unrelated container on this machine → `WEB_PORT=3100`.

## Steps

- [x] Add `CORS_ALLOWED_ORIGINS` (incl. :3100) to `services/api/.env` — pre-flight blocker
- [x] Bring the full stack up; indexer needed a solo catch-up run (3.4 h behind)
- [x] Read the real wire format off the running API
- [x] Migrate API-fed call sites to scale-bound `priceToRaw`/`collateralToRaw`/`leverageToRaw`
- [x] Serve the live publisher index/mark from `/price`, with the chain as a labelled fallback
- [x] Record the index series (`api_series.index_candle`) and draw the chart from it
- [x] Make `approve()` wait for its receipt
- [x] Serve recently-resolved orders + `cancelReason` so the lifecycle is observable
- [x] Open a position from the UI, in a real browser, with a real signature
- [x] Screenshot the terminal with chart + positions + live price
- [x] API suite green (52/52, x3 for flakiness)
- [ ] Web unit suite — fixture migration in flight

## Review

**Changed**
- `apps/web`: money.ts gains three scale-bound resolvers; 9 files migrated off
  `parseRawUnits` for API data; `useErc20.approve` waits for the receipt; chart defaults
  to 1m.
- `services/api`: new `publisher.ts` (live `/status` client, per-call env so it is
  testable) and `indexSeries.ts` (own `api_series` schema, OHLC upsert, recorder timer);
  `/price` and `/orders` reshaped and shared with the WS channels via `resolvePrice` /
  `resolveOrders`; `/candles` reads the index series with the on-chain table as fallback
  and joins real traded volume per bucket.
- `tools/stack/run.mjs`: pins `PUBLISHER_URL`; the API readiness gate no longer reports
  "no sync_status row" when the row is merely stale, and waits 600 s for backfill.
- `tools/stack/drive-trade.mjs`: new — drives the UI in a real browser behind an injected
  EIP-1193 provider that signs in Node with the trader role key.

**Verified**
- Two positions opened end-to-end through the UI (LONG 30 @ 5x, SHORT 40 @ 3x). Second run
  reached `outcome filled` with the "Filled — your position is now open." banner.
  Txs `0xb093b25f…` (approve) and `0x8808739d…` (openTrade).
- Terminal screenshot shows candlesticks, live mark 78,272.69, index 78,272.97,
  24h volume 145.00, OI 5,135.00, 3 positions with UPnL. 0 console errors, 0 page errors.
- Landing: max leverage 100× from `/markets`, live mark, real 24h change. 0 errors.
- API suite 52/52, three consecutive runs. Suite time fell 36 s → 2.2 s once the tests
  stopped making real network calls to a publisher on a fixed port.

**Left / not done**
- **Liquidator does not run**: no `~/.whitespace-keys/liquidator.json`, and
  `OstiumTradesUpKeep` is not deployed on 1874 anyway, so it could not liquidate if it
  did. Nothing in this change depends on it; positions here are unliquidatable.
- **Chart history starts when the API does.** The index series has no backfill, so a fresh
  stack shows minutes, not days. Reconstructing history from venue klines is the obvious
  next step and is deliberately not done here.
- **`liq. price` is still a dash** — needs on-chain funding/rollover state the app does not
  read.
- Untracked `contracts/test/adversarial/` and `contracts/test/helpers/SystemFixture.sol`
  were left alone — not mine, possibly in-progress work.
- Nothing committed.
