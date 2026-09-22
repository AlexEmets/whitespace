# /faucet — rebuild the page against `Whitespace Faucet-print-selection.png`

## Why

`docs/design/Whitespace Faucet-print-selection.png` is the mockup for this screen. The
implementation renders the same *copy* but a different *layout*: it reuses the
`/portfolio` + `/points` shell (`components/portfolio/AccountPage.tsx`), which builds
pages as a stack of full-width bands. The mockup builds this one as a two-column page —
a main column and a right rail separated by a rule that runs from under the nav to the
bottom of the claim band — plus a 50/50 split for the two closing sections.

The shell cannot express that, and widening it would restyle `/portfolio` and `/points`,
which have their own mockups. So the faucet gets its own layout module and keeps only
`AccountState` from the shell (the disconnected state must stay the same object across
the three account-scoped pages, and `FaucetPage.test.tsx:62` asserts on its testid).

## Measured deltas (mockup rendered at 1680 CSS px)

| | Mockup | Now |
|---|---|---|
| Hero title | ~70px | `2rem` (`accountPage.module.css:46`) |
| Hero backdrop | ruled grid, masked | none |
| Hero meta | rows in a right rail, label left / value right | inline right-aligned text |
| Claim band | panel ≤ ~620px + right rail editorial block **`UNCAPPED MINT` — new copy** | panel full-width, no rail |
| Panel internals | full-bleed rules between head / balance / facts; vertical rule between MINTS and CADENCE | gap-separated, raised balance chip |
| Balance figure | ~45px | `1.15rem` (`FaucetPanel.module.css:47`) |
| Button | full width, trailing `→` | full width, no arrow |
| Closing sections | side by side, split by a rule | stacked bands |
| "Once you have some" | two link *cards* (kicker + arrow + sentence) | two `DefRow`s |

## Plan

- [ ] `FaucetPage.module.css` (new) — band grid with rail, hero grid backdrop reusing
      `--hero-grid`, rail dot field reusing `--hero-dot`, link cards, faucet-local def
      rows (the shared `.defValue` is `nowrap` + `tabular-nums`, tuned for figures; these
      rows carry sentences and must wrap).
- [ ] `FaucetPage.tsx` — rewrite against the module. Keep `AccountState`. Add the
      `UNCAPPED MINT` rail block from the mockup.
- [ ] `FaucetPanel.module.css` — rules-not-gaps, large balance, split facts row, arrow
      on the button.
- [ ] `FaucetPanel.tsx` — minimal: wrap the button label + arrow, regroup the footer.
      **Do not touch** `useErc20(TRADING_STORAGE_ADDRESS)` — that is the in-flight
      approve-button work (todo-2026-09-22-remove-approve-button.md).
- [ ] Responsive: rail drops under the main column < 1100px; everything single-column
      < 760px.

## Must not break

`faucet-page`, `faucet-panel`, `faucet-balance`, `faucet-mint-amount`,
`faucet-panel-button`, `faucet-disconnected`, `faucet-panel-success`,
`faucet-panel-error`, `account-state-disconnected`; the full `COLLATERAL_ADDRESS` in
`innerHTML` (`FaucetPage.test.tsx:55`); the strings `not a stablecoin and not
redeemable`, `uncapped, permissionless`, `this one is immediate`.

## Verify

- [ ] `FaucetPage.test.tsx` + `FaucetPanel.test.tsx` green.
- [ ] Typecheck + lint.
- [ ] Render the page and compare against the mockup.
- [ ] e2e is red at HEAD for an unrelated reason (mockChain missing 5 PairInfos fns) —
      do not read a red run as caused by this diff.

## Mid-flight re-plan: the mockup is not monospace

`pdffonts` on the three design files:

| file | date | family |
|---|---|---|
| `landing_design.pdf`, `terminal_design.pdf` | 8 Sep | IBM Plex Mono |
| `pages.pdf` (points, portfolio, docs — 5 pages) | 21 Sep | Schibsted Grotesk |
| the faucet PNG | 22 Sep | Schibsted Grotesk |

So the faucet mockup is not a one-off: the September mockups move the product off
monospace. `layout.tsx:9` had recorded the opposite as settled ("both mockups are
monospace end to end") — true when only the two 8 Sep files existed. Confirmed with the
user, who chose to apply the new direction app-wide.

**Mechanism inverted from the obvious one.** An audit of every rule found ~100 carrying a
figure, a table cell or a small uppercase label, against ~25 carrying prose — and ten
where monospace is load-bearing for *layout*: `.formula` is `white-space: pre` with
hand-padded `=` columns, nine `max-width` values in `docs.module.css` are in `ch`,
`PriceChart` draws its axis chips into a hard-coded 66px SVG gutter, and the money
columns are `white-space: nowrap`.

Switching `body` to sans would mean ~100 opt-outs, each a chance to ship a silently
misaligned price column. Keeping `body` mono and opting *prose* into sans is ~30 edits
whose failure mode is a paragraph that visibly stayed monospace. All ten layout-critical
risks evaporate under the inversion — `.formula` is a `<div>`, so it kept monospace with
no edit at all.

## Review

**Changed**
- `FaucetPage.module.css` (new), `FaucetPage.tsx` — rebuilt to the mockup: rail, hero grid
  backdrop, pull-quote, 50/50 closing pair, link cards.
- `FaucetPanel.module.css`, `FaucetPanel.tsx` — rules not gaps, 2.7rem balance, split
  facts row, arrow on the button.
- `layout.tsx`, `globals.css` — Schibsted Grotesk loaded beside JetBrains Mono;
  `--font-sans`; prose opt-in on `h1-h4, p, li, blockquote, dd`; `.mono-upper` now
  declares the family it is named after (several of its users are `<h2>`/`<p>`).
- `accountPage.module.css` — sans + `+24%` size on the seven shared prose rules. Prose
  sized for monospace reads too small in a proportional face at the same px; 24% is the
  ratio the mockup's measured 13.7px lede implies over the old 11.05px.

**Verified** (dev server, Playwright, 1600px)
- 300/300 unit tests, `tsc --noEmit` clean. No lint gate exists in this repo.
- All six routes render; overflow probe clean on faucet, portfolio, docs, points, landing.
- Terminal inspected by eye: labels, tabs, order-summary figures still monospace; only
  prose flipped.
- The faucet's own 13px horizontal overflow was mine (`.claimRail::before` bled `-1rem`
  past the last column) and is fixed.

**Left**
- `/trade` `FORM`/`.leverage-row` overflow 297>293. Proven **pre-existing** — identical
  under a forced-monospace override — so not from this diff. Not fixed: unrelated.
- Prose sizes recalibrated only in `accountPage.module.css` and on the faucet. `/docs`
  and the landing page still use their monospace-era sizes and want their own mockups
  measured.
- `/docs` prose `max-width` is still in `ch`, which now resolves against the sans: those
  blocks are ~8% narrower than before. Rendered fine; flagged, not changed.
- `.title` (2rem) on `/portfolio` + `/points` untouched — `pages.pdf` draws it much
  larger, but that was not measured here.
- Next reports `Schibsted Grotesk Fallback` as `error`, so there is no metric-matched
  fallback face for it; `display: swap` means a brief FOUT into `ui-sans-serif`.
- e2e not run. Red at HEAD for an unrelated reason (mockChain missing 5 PairInfos fns).
