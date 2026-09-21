# Funding panels + terminal design parity — 2026-09-21

Execution plan merging `todo-2026-09-21-funding-panels.md` (steps 1–4) and
`todo-2026-09-21-design-parity-terminal.md` items 1–6 (steps 5–7).

Baseline reproduced before starting, and the bar to return to:

```
Test Files  20 passed (20)
     Tests  259 passed (259)
tsc --noEmit -> exit 0
```

`services/indexer/test/decode.test.ts` fails independently of this work. Not touched.

## Corrections to the source task files, established by reading the repo

Three claims in the two task files are stale. Recorded here because each one changes scope:

1. **`useVault` already has the whole withdraw path.** `todo-…-funding-panels.md:48-50`
   says `requestWithdraw` "has **no UI and no hook** today". `hooks/useVault.ts:51-67`
   implements `requestWithdraw`, `:69-78` `claimWithdraw`, `:92-102` `useWithdrawStatus`.
   Only the **UI** is missing. Genuinely absent from the hook:
   `cancelRequestDeposit`, `cancelRequestWithdraw`, `reclaimDeposit`, `reclaimWithdraw` —
   all four are in `lib/abi.ts:30-35`.
2. **`PointsPanel.test.tsx` does not test the terminal's points block.** The parity file
   says it must be updated (6 tests). It tests `components/points/PointsPanel.tsx`, the
   `/points` page, which is explicitly out of scope. The terminal's Void-points block is
   an inline div at `OpenPositionForm.tsx:436-442`; `grep -rn points-panel src/ tests/`
   matches only that line and `globals.css:775`. **No test asserts on it** — deleting it
   costs nothing. `PointsPanel.test.tsx` is NOT touched.
3. **Slippage is already pinned on the close path.** `PositionsList.tsx:64` passes
   `DEFAULT_SLIPPAGE_BPS` directly. Pinning the open form to the same constant makes the
   two money paths agree; today they only agree by coincidence of the slider's default.

## Owner decisions taken 2026-09-21, before any code

- **Order-type tabs:** order becomes `LIMIT MARKET STOP TWAP` to match the reference, but
  **MARKET stays the active tab**. `useOpenTrade.ts:66` hardcodes
  `OPEN_ORDER_TYPE_MARKET` into every submission, so an active LIMIT tab over a
  market-order submit path would tell the trader one thing and sign another.
  Real limit orders are a separate project (`abi.ts:95-98` scopes them out).
- **SIZE field:** a genuine base-asset input. The trader types BTC; the form derives
  `collateral = size x price / leverage` and submits that. `Margin required` in the order
  summary shows the USDW that actually leaves the wallet. Money-path change — own step,
  own tests.
- **RECLAIMABLE:** add reclaim + cancel to **both** deposit and withdraw. A settlement
  that lands RECLAIMABLE currently offers no control at all (`VaultPanel.tsx:158` only
  branches on `CLAIMABLE`), which is funds stranded in a settlement.

---

## Step 1 — `hooks/useFaucet.ts`

- [ ] Lift claim + pending + error + refetch out of `VaultPanel.tsx:48-61` and
      `OpenPositionForm.tsx:186-196` into one hook.
- [ ] Both existing call sites consume it. No behaviour change; `claimFaucet` keeps
      waiting for its receipt (`useErc20.ts:61-70`) so the refetch reads post-mint state.
- [ ] Verify: `vitest run` still 259/259.

## Step 2 — vault hooks: cancel + reclaim

- [ ] `useVault`: add `cancelRequestDeposit`, `cancelRequestWithdraw`, `reclaimDeposit`,
      `reclaimWithdraw`, following the existing `confirmTx` idiom.
- [ ] Verify: `tsc --noEmit` exit 0.

## Step 3 — `components/FaucetPanel.tsx`

- [ ] Dedicated panel: USDW balance, what the faucet mints and its cadence (1,000 USDW
      per address per 24h), one primary action, live result. Keeps the honest line
      "testnet collateral, no value".
- [ ] New test file covering: claims on click, shows pending, surfaces the error.

## Step 4 — `components/FundingModal.tsx` + `FundingButtons.tsx`

- [ ] `DEPOSIT` / `WITHDRAW` buttons in the terminal chrome (NavHeader), opening a modal.
- [ ] Modal reuses the `WalletPicker.tsx` pattern — portal, focus trap, Esc/backdrop
      close — rather than a second dialog implementation.
- [ ] Deposit tab keeps the three-state lifecycle: `requested -> settling -> claimable`,
      never flattened to "Deposited". Adds the RECLAIMABLE and PENDING-cancel branches.
- [ ] Withdraw tab: same lifecycle over `requestWithdraw`/`claimWithdraw`, plus cancel
      and reclaim. Guard against requesting more shares than held.
- [ ] `VaultPanel` keeps the LP-position view; deposit/withdraw controls **move**, not
      duplicated. `/vaults` renders vault state + the same modal trigger.
- [ ] Tests: new `FundingModal.test.tsx`; `VaultPanel.test.tsx` follows the controls.

## Step 5 — terminal: delete the prose, pin the slippage

- [ ] `DepthPanel.tsx`: delete `styles.blurb` (:45-48), the `staticOnly` caveat
      (:112-118) and `depth-panel-legend` (:119-122).
- [ ] `OpenPositionForm.tsx`: delete the `MAX SLIPPAGE` slider (:321-335) and the
      `.slippage-explainer` paragraph (:336-339). **Pin `slippageBps` to
      `DEFAULT_SLIPPAGE_BPS`** — a `const`, not state, so submissions keep the 0.50%
      tolerance they have today. Drop `slippageBps` from the banner-reset dep array and
      the now-unused `MIN/MAX_SLIPPAGE_BPS` + `formatBps` imports.
- [ ] Delete the Void-points block (:436-442).
- [ ] Update `DepthPanel.test.tsx:194,246-247` (the three assertions on deleted prose).
- [ ] Update `OpenPositionForm.test.tsx:91-96` — assert the submitted slippage is still
      50n rather than that a slider displays it.

## Step 6 — terminal: chart chrome

- [ ] `PriceChart.tsx`: delete `reset-zoom` (:494-502), the
      `{visible} / {total} candles · scroll to zoom` hint (:648-651), and the duplicated
      price readout (:506-515).
- [ ] Move `data-testid="mark-price"` and `index-price` onto `MarketHeaderBar`'s existing
      price and Index cells. `tests/e2e/trade-flow.spec.ts:47` asserts on `mark-price`.
- [ ] `atDefault`/`isDefaultView` become unused in the component — check before deleting;
      `priceChart.test.ts` exercises `isDefaultView` as a pure function, so the export
      stays.

## Step 7 — terminal: tabs, suffixes, SIZE

- [ ] Tabs reordered `LIMIT MARKET STOP TWAP`, MARKET active (see decision above).
- [ ] `USDW` suffix badge in the price field, `BTC` (base asset) in the size field.
- [ ] `COLLATERAL` -> `SIZE` in the base asset with `AVAIL.` above it. Derive collateral
      from size; submit the derived collateral. Quick-fill buttons recompute against it.
- [ ] Tests: size -> collateral conversion is exact at the boundaries, and the submitted
      `collateralRaw` matches what `Margin required` displayed.

## Step 8 — verify and deploy

- [ ] `vitest run` -> 259+ green, `tsc --noEmit` -> exit 0.
- [ ] `next build` compiles.
- [ ] Deploy; the script must print `OK: the running server postdates the build`.
- [ ] Record what was NOT verified: nothing here is seen in a browser (no browser in this
      environment), and no on-chain deposit/withdraw/reclaim was broadcast.

## Review

_(filled in at the end: changed / verified / left)_
