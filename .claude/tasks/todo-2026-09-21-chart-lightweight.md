# Migrate the price chart to TradingView lightweight-charts — 2026-09-21

## Problem

With two buckets of history the chart draws two columns half a screen apart.
`PriceChart.tsx:44` is the cause:

```ts
const visible = Math.min(total, Math.max(minVisible, Math.round(view.visible)));
```

`Math.min(total, …)` pins the viewport to however many candles exist, so bar width is a
function of data count rather than a constant. Two candles therefore get half the canvas
each.

Decision (user, 2026-09-21): migrate to `lightweight-charts` rather than remove the clamp.
The library solves the same problem with a fixed `barSpacing` and by never calling
`fitContent()` — `fitContent()` silently overrides `barSpacing` every time it runs.

## Baseline before touching anything

`apps/web`: `tsc --noEmit` exit 0, **20/20 test files, 255/255 tests passing**, measured
2026-09-21 after `pnpm add lightweight-charts@5.2.1`. Any red after this point is mine.

**The working tree is not clean and that is expected.** The user is concurrently editing
`apps/web/src/hooks/useWalletOptions.ts` (+122 lines: `GenericInjectedInfo`, a
`useEffect`/`useState`, a new `deriveWalletOptions` parameter) and
`.claude/tasks/todo-2026-09-21-wallet-picker.md`. Those files are theirs — never stage
them, never "fix" them.

## Decisions

- **No backfill.** The user did not ask for it, so the honest footer
  ("the index series starts with the API and is not backfilled. Nothing here is padded or
  interpolated") and the "N / N candles" affordance are preserved. Pulling history from an
  exchange is a separate product decision, not part of this migration.
- `lightweight-charts@5.2.1`, Apache-2.0. The licence requires a TradingView attribution
  notice — must be added, not skipped.
- Fixed `barSpacing`; `fitContent()` is never called. Right-anchored, empty slots to the
  left when history is short. `ResizeObserver` recomputes, because with fixed spacing a
  wider pane must show more slots rather than fatter candles.

## The one invariant this migration breaks

`apps/web/src/lib/money.ts` refuses JS numbers at runtime: `MoneyInput = bigint | string`
(`:44`) and every public function calls `assertNotNumber` (`:56-61`), which throws
`MoneyTypeError`. `Money.test.tsx:32` asserts the throw. lightweight-charts accepts prices
**only** as JS `number`.

So the migration needs exactly one conversion boundary. Rules for it:
- It lives in the chart module, **never** in `money.ts`, and is named so that its purpose
  is unmistakable at the call site.
- Display-only. Its output must never reach order construction, slippage maths, or
  anything that is signed or sent on chain.
- Precision is adequate and worth stating: a price of 85_933.933473386497 at 18 decimals
  keeps ~16 significant digits in a double — far below one pixel of chart resolution.

This is a real cost of the migration, not a free win. Documented here so the next reader
does not discover it as a surprise.

## Steps

- [x] Confirm the root cause in `PriceChart.tsx:44` and that the library's own answer is
      fixed `barSpacing` + no `fitContent()`
- [x] Record the green baseline
- [x] `pnpm add lightweight-charts@5.2.1`
- [ ] Behavioural spec of the current component (props, every rendered string, the
      interactions, the mark/index overlay, the CSS contract)
- [ ] Reimplement `PriceChart.tsx` on the library, preserving every string in the spec
- [ ] Rework `priceChart.test.ts` — 42 tests currently assert pure geometry
      (`clampView`, `zoomView`, `panView`, `isDefaultView`, `niceStep`, `priceTicks`,
      `timeTickIndices`) that moves into the library. Keep what still has meaning
      (`formatAxisTime`, `domainWithMark`), delete what does not, and say which in the
      Review rather than quietly dropping coverage.
- [ ] TradingView attribution notice
- [ ] Verify: `tsc --noEmit`, the full web suite, `next build`
- [ ] Deploy via `deploy/deploy.sh` and confirm the running bundle postdates the build

## Outcome — the migration was NOT done, and that was the right call

The behavioural spec of the existing component changed the arithmetic. Three findings, all
discovered after the decision to migrate was taken:

1. **The axis holds a money-exactness contract the library cannot.** `niceStep`/`priceTicks`
   compute tick values as exact `bigint` precisely so a label is never a rounded double
   (`PriceChart.tsx:79-92`), with 11 tests behind them. `lightweight-charts` formats a
   `number`.
2. **Coverage cliff.** All 42 tests exercise pure functions; there is no render test for
   `PriceChart` anywhere in the repo. Migrating moves `clampView`, `zoomView`, `panView`,
   `timeTickIndices`, `isDefaultView` into the library (23 tests) and, with the price axis,
   11 more — ~34 green tests deleted with nothing to replace them.
3. **A lot of bespoke behaviour would have to be rebuilt**: crosshair snapping (a deliberate
   "never invert a pixel back into a price" rule), the `domainWithMark` autoscale policy,
   the sparse/stale notes, seeding, append-offset compensation, the non-passive wheel
   listener.

`lightweight-charts@5.2.1` was installed, then removed again once the fix landed without
it. Re-adding is one command if indicators, volume panes or multiple series ever justify it.

## What was actually changed

The window now counts **slots**, not candles, with a floor of `MIN_VISIBLE_CANDLES`:

- `maxVisible()` added; `clampView` no longer pins `visible` to `total`, and the pan range
  collapses to `[0, 0]` once the window outruns the series.
- `isDefaultView` and the seeding effect compare against `maxVisible(total)`.
- `leadingSlots` / `sliceStart` right-anchor a short series, with an explicit guard because
  `Array#slice` reads a negative start as an offset from the end.
- `xOf` now takes a slot; `xOfCandle` offsets past the empty leading slots, and the grid,
  time axis, candle geometry and crosshair all go through it.
- Hover maps slot → candle index, so the blank left-hand area clears the crosshair instead
  of clamping onto the oldest bar.
- The `N / N candles` hint, `aria-label` and `data-visible-candles` report
  `visibleCandles.length`; they would otherwise have read "20 / 2 candles".
- Candle body cap raised 16px → 26px so the existing 62% fill ratio governs at minimum
  zoom, where the old ceiling clipped a slot to 40% filled and read as thin and gappy.

Concretely, at the default 880px pane with two buckets: 20 slots, `step` 40.3px, bodies
~25px wide, drawn at x≈754 and x≈794 against a plot edge of 814 — adjacent, at the live
edge, with the empty history to their left.

## Verified

- `apps/web`: `tsc --noEmit` exit 0; **259/259 tests in 20 files** (was 257 — one test
  rewritten, two added).
- `next build` compiles.
- Exactly one pre-existing test failed and was rewritten: "lets a short series go below the
  minimum rather than inventing bars" encoded the old rule this change deliberately
  reverses. Nothing else in the 42-test geometry suite broke.
- Added coverage for the new rule: right-anchoring, and the collapsed pan range.

## Left

- No backfill — the honest footer and the sparse-history note are untouched.
- `apps/web/tsconfig.tsbuildinfo` is dirty from a `tsc` run; it is a tracked build cache.
