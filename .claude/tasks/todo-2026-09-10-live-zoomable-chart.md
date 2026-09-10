# Live, zoomable price chart

Scope: `apps/web/src/components/PriceChart.tsx`, `apps/web/src/hooks/useCandles.ts`,
new `apps/web/src/components/PriceChart.module.css`, new tests under `apps/web/tests/unit/`.
Nothing else — `app/globals.css` and `src/lib/types.ts` belong to other agents.

## Findings before writing code

1. **The WS candle channel works; the web drops every push.** `services/api/src/ws.ts:164`
   sends `{"type":"update","channel":…,"data":…}`. `useCandles` filters on
   `msg.type !== 'candle'`, so every candle frame is discarded. Probed live:
   subscribing to `candles:0:1m` returns a well-formed `update` frame in ~0.7 s.
   Root fix: route on the *channel* (the client already demultiplexes by it) and
   validate the payload shape, instead of trusting an envelope tag the server never sends.
2. **Same mismatch hits `usePrice`/`usePositions`/`useOrders`** via
   `useLiveResource.extractFromWs` (`msg.type === 'price'` etc.). Those degrade to their
   REST poll so they still move, but the socket does nothing for them. Not my files —
   report, do not fix.
3. **The index series is frozen.** `price-publisher` (pid 756967, :8787) reports
   `healthyCount: 0, noData: true` with a mark stuck for 9 h. `startIndexRecorder` skips a
   tick unless the feed is healthy, so `api_series.index_candle` stops at bucket
   1788991140 (9.2 h old). A 1 h REST window returns `[]`; a 2 day window returns 67
   candles. Live movement cannot be demonstrated until venues recover.
4. **Liquidation price is not computable in this app.** `OpenPositionForm.tsx:291` and
   `PositionsList.tsx:68` both render a dash with "requires on-chain funding/rollover
   state this app does not currently read". The mockup's dashed line therefore cannot be a
   liq line without fabricating it — draw the live **mark** instead and document the gap.

## Steps

- [x] `useCandles`: route by channel + structural payload validation; clear on
      pair/interval change; pure `upsertCandle` helper for the REST/WS race
- [x] Pure chart math exported from `PriceChart.tsx`: `clampView`, `zoomView`, `panView`,
      `niceStep`/`priceTicks` (bigint, exact), `timeTickIndices`, `formatAxisTime`,
      `domainWithMark`
- [x] Measured pixel-space SVG (ResizeObserver + rect fallback), plot padding, grid,
      right price axis, bottom time axis
- [x] Wheel zoom (non-passive native listener), pointer drag pan, reset affordance
- [x] Crosshair + OHLC readout
- [x] `PriceChart.module.css` — dim grid, axis text, crosshair, readout chip
- [x] Unit tests for every pure helper
- [x] `tsc --noEmit` + `vitest run` + drive the real browser and read the screenshot

## Review

**Changed** — 2 files modified, 2 added, nothing else touched.
- `useCandles.ts`: routes on channel + `isCandle` shape check instead of the envelope tag
  the server never sent; state keyed by channel so an interval switch cannot mix series;
  `upsertCandle` closes the REST/WS ordering race. Exports `isCandle`, `upsertCandle`.
- `PriceChart.tsx`: measured-pixel SVG, faint grid, right price axis, bottom time axis,
  wheel zoom about the cursor, drag pan, reset affordance, snapping crosshair + OHLC
  readout, dashed live-mark line, sparse and stale captions. Exports 8 pure helpers.
- `PriceChart.module.css`, `tests/unit/priceChart.test.ts` (42), `tests/unit/useCandles.test.ts` (22).

**Verified**
- `tsc --noEmit` clean; `vitest run` 164/164 across 12 files.
- Real browser on :3100 — 67 real candles, 7 price levels, 6 time labels, 13 grid lines;
  wheel 67→32→43, clamped at 20; drag moved the window 23:18→23:08 with width held;
  crosshair read `23:26 O 78,264.85 H 78,291.58 L 78,264.85 C 78,291.58`; reset restored
  67/67; interval switch sent `unsubscribe candles:0:1m` + `subscribe candles:0:15m` and
  redrew. **console errors 0, page errors 0.**
- Live re-render proven frame by frame against real REST + a WS double: same bucket
  78,126.42→78,205.00 moved the body y 207.1→138.8 and grew it 14.1→82.4; →78,040.00
  flipped it red; count stayed 67 (replace) then went to 68 on a new bucket (append).

**Left / not done**
- **The stack's index feed is dead, so nothing moves on screen.** `price-publisher`
  (:8787) has `healthyCount: 0`; two `/candles` reads 35 s apart returned the identical
  close. Root cause is upstream and unfixed: `venues/index.mjs:65-70` reconnects only on
  `close`, and a half-open socket emits none — no ping, no idle watchdog. `run.mjs`
  does not respawn children either.
- The same envelope mismatch still blinds `usePrice`/`usePositions`/`useOrders` through
  `useLiveResource.extractFromWs`. Not my files; they survive on their REST poll.
- No liquidation line — this app cannot compute a liq price (see the component header).
