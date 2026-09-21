# Terminal design parity against docs/design/terminal_design.pdf — 2026-09-21

Owner's ask: "повтори 1 в 1 там все". This file is the full diff between the reference PDF
and the deployed terminal, split by whether it is *achievable* — because a literal 1:1 is
not, and the reasons are decisions this project already took on purpose.

## Group A — real design gaps, nothing invented, safe to do

- [x] **Uppercase chrome labels.** The reference sets every label in letter-spaced
      uppercase (`MARKETS`, `PRICE`, `SIZE`, `AVAIL.`, `LEVERAGE`,
      `DEPTH INDICATORS LOG SCALE`, `POSITIONS · 2`, `LONG`/`SHORT`,
      `LIMIT MARKET STOP TWAP`, `MARKET SIZE ENTRY MARK LIQ. UPNL`) while the build used
      sentence case throughout. Done in `globals.css` as `text-transform`, so the DOM text
      is unchanged and label-matching tests keep passing. **`.order-summary` deliberately
      excluded** — the reference keeps "Order value / Margin required / Est. liq. price /
      Fee · maker/taker" in sentence case.
- [ ] **Duplicated price readout.** The chart renders `85,864.64  index 85,863.90` again
      above the plot, directly under the market header that already shows both. The
      reference shows it once. Removing it means moving `data-testid="mark-price"` to the
      header price, which `tests/e2e/trade-flow.spec.ts:47` asserts on — a coupled change,
      and that spec is independently red at HEAD, so it cannot be used as the signal.
- [ ] **Ticker strip.** The reference has a marquee row under the nav
      (`WBT-PERP 12.804 -0.37%   TON-PERP 6.118 +2.05%`). Not built at all. Honest version
      shows the markets that actually exist — today that is one.
- [ ] **`LONG` / `SHORT` tabs.** Reference: full-width tabs, active one filled with the
      side colour and underlined. Build: dim, low-contrast pills.
- [ ] **Primary button.** Reference: large filled green `BUY · LONG BTC`, base asset in the
      label. Build: `Buy · Long`, and the dim state dominates because collateral is 0 —
      check the *enabled* styling matches, the disabled state is correct behaviour.
- [ ] **Chart hint text.** `45 / 46 candles · scroll to zoom, drag to pan` sits over the
      plot; the reference has no such line.
- [ ] **`Reset zoom` control.** Not in the reference's toolbar (`DEPTH INDICATORS LOG
      SCALE` only). Keep or drop deliberately — it is a genuine affordance the mockup
      lacks.
- [ ] **Max-slippage slider + the execution-price paragraph.** Neither is in the reference.
      They are real protocol behaviour (the two-phase fill), so dropping them loses
      information the trader needs — decide consciously rather than to match a picture.
- [ ] **Header details.** Reference: `BLOCK 8,412,097` with thousands separators, a green
      status dot before `47 MS`, address uppercased (`0X71C4…9AB2`). Build: `BLOCK 8412781`,
      `·` instead of the dot, mixed-case address. The MetaMask label and `Disconnect`
      button are newer than the mockup and should stay.
- [ ] **Size field denominated in the base asset.** Reference: `SIZE` / `0.4500` / `BTC`
      with `AVAIL. 24,880.40`. Build: `Collateral` / `0.00` with `Avail. 52.50 USDW`. Was
      already an open item in `todo-2026-09-10-design-parity.md`.
- [ ] **`USDW` suffix badge inside the price field.**

## Group B — cannot be copied without inventing data, or reverses a locked decision

Each of these is in the reference and is **not** a bug in the build:

| Reference shows | Reality | Why it stays different |
|---|---|---|
| `ORDER BOOK` with resting bids/asks, `spread 0.50` | price-impact ladder vs the vault | Owner decision 2026-09-10 (`todo-2026-09-10-design-parity.md`): the protocol has no resting orders, so a book would be fabricated. "NOT a fabricated book." |
| `MARKETS 38`, eight perps | one pair | Only `pairIndex 0 = BTC/USD` exists on chain; the ETH/SOL listing was never broadcast (hosting design §2) |
| `VOID POINTS · EPOCH 07`, `128,904`, `Rank 214` | "Coming soon" | Same decision: "honest: real volume/fees, no invented totals or ranks" |
| `OPEN INTEREST $38.2M`, `24H VOLUME $412.8M` | `0.00` | No trades have happened; the OI long/short columns are also deliberately seeded at 0 (see `seedMarkets.ts`) |
| `FUNDING · 1H +0.0041%` | `—` | No funding data source wired |
| `CROSS · 50× MAX` | `ISOLATED · 100× MAX` | Chain reality: `maxLeverage` reads 10000 (100.00×), margin is isolated |
| `Fee · maker/taker 0.010% / 0.035%` | `0.00% / 0.00%` | On-chain fee params are zero on this deployment |
| `1W` timeframe | absent | Deliberate, per the comment at `PriceChart.tsx:13-14` |
| Positions/orders populated | empty | No open positions |

**The honest summary for the owner:** most of what makes the screenshots look different is
Group B — it is missing *data and liquidity*, not missing design. Group A is the part that
is genuinely ours to fix, and the typography pass was the largest single piece of it.

## Owner decision 2026-09-21: strip everything the reference does not show

"видали все що не в дизайні … включно з текстом". Explicit, given after the trade-off was
put in front of them. Scope, in the order it should be done:

1. **Delete the prose.** ~16 lines across the right column, none of which exist in the
   reference: the blurb above the ladder ("No resting orders exist here…"), the two
   paragraphs below it ("Flat across size by design…", "IMPACT is the fill's distance…"),
   the slippage explainer in the order form, and the Void-points disclaimer.
2. **Delete the `MAX SLIPPAGE` control** — the reference has exactly one slider, LEVERAGE.
   **Not a pure deletion.** Slippage is a transaction parameter, not decoration: removing
   the control must pin the value to `DEFAULT_SLIPPAGE_BPS` (`config.ts:38`, 50n = 0.50%)
   so submitted orders keep the same tolerance they have today. Deleting the control
   without pinning the value removes the trader's only protection against an unfavourable
   execution price in the two-phase flow — see the comment at `config.ts:32-37`.
3. **Delete `RESET ZOOM`** from the chart toolbar and the `N / N candles · scroll to zoom`
   hint, and the duplicated in-chart price readout (move `data-testid="mark-price"` onto
   the market-header price; `tests/e2e/trade-flow.spec.ts:47` asserts on it).
4. **Order-type tabs** → `LIMIT MARKET STOP TWAP`, LIMIT first and default-active.
5. **Field suffixes** → `USDW` inside the price field, `BTC` inside the size field.
6. **`COLLATERAL` → `SIZE` in the base asset**, with `AVAIL.` above it. Already an open
   item from `todo-2026-09-10-design-parity.md`.
7. **`VOID POINTS · EPOCH 07`** panel shape: epoch label, countdown top-right, big number,
   `Rank … · referral …` line. **Blocked**: the numbers do not exist. Shape can be built;
   values cannot be invented (owner's own 2026-09-10 rule).

**Tests that assert on the deleted strings and must be updated in the same commit:**
`DepthPanel.test.tsx` (18), `OpenPositionForm.test.tsx` (11), `PointsPanel.test.tsx` (6).
The current suite is 259/259 green — that is the baseline to return to, not to lower.

**Not started.** Deliberately not begun half-way: items 1–2 edit the order-entry path, and
an unverified partial change there is worse than a mismatched mockup.

## Verified so far

`apps/web`: 259/259 tests, `tsc --noEmit` exit 0, `next build` compiles, deployed and the
deploy script confirmed the running server postdates the build.

Not verified: how any of it *looks*. There is no browser in this environment — the
typography change is reasoned from the reference PDF and the CSS, not seen.
