# Build out /portfolio, /points, /docs (2026-09-10)

Replace the three `StubPage` placeholders with real pages. Files owned: the three
`app/*/page.tsx`, new components under `components/{portfolio,points,docs}/`, new hooks,
new CSS modules, new tests. Not owned: `globals.css`, `lib/abi.ts`, `lib/money.ts`,
`lib/types.ts`, `components/{PriceChart,OpenPositionForm}.tsx`, `terminal/DepthPanel.tsx`.

## Verified inputs (curl + `cast` against 1874, 2026-09-10)

- `/positions/:a/history` emits `realizedPnl` (**American** spelling), `closeReason`,
  `percentProfit`, `usdcSentToTrader`. `lib/types.ts` declares `realisedPnl` — that field
  does not exist on the wire. Reconcile at the boundary; do not edit types.ts.
  `realizedPnl == usdcSentToTrader - collateral` (services/api/src/routes/positions.ts:69).
- Live chain reads: `verifier.threshold()=3`, `signerCount()=5`, `upkeep.maxAge()=10`,
  `maxDeviationBps()=500`, `pairOracleFee(0)=1000000` (=1.00 USDW), `pairOpeningFees(0)`
  all zero, `liqMarginThresholdP()=25`, `vault.decimals()=6`, `vault.totalAssets()=100000.307372`.
- Test trader `0x2b8b…0D19`: 3 open positions, 1 closed trade, 0 orders, 0 vault shares,
  9,428.692628 USDW.
- Only one market exists (`BTC/USD`, pairIndex 0).

## Steps

- [x] Research: PDFs, globals.css, API shapes, decisions docs, live chain probes
- [x] Hook: `useTradeStats.ts` (history normaliser + pure aggregation, exported for tests)
- [x] Hook: `useMarkPrices.ts` (marks for N pairIndexes without breaking rules-of-hooks)
- [x] Hook: `usePortfolioBalances.ts` (USDW wallet + LP vault shares/assets)
- [x] Hook: `useOracleParams.ts` (live threshold/N/maxAge/maxDeviationBps for Docs)
- [x] `components/portfolio/AccountPage.tsx` + `accountPage.module.css` — shared shell for
      the two account pages (head, stat tiles, sections, the four states)
- [x] `components/portfolio/{PortfolioSummary,OpenPositionsTable,TradeHistoryTable}.tsx`
- [x] `components/points/PointsPanel.tsx` + `points.module.css`
- [x] `components/docs/DocsArticle.tsx` + `docs.module.css`
- [x] Rewrite the three `page.tsx`
- [x] Tests under `tests/unit/`
- [x] `tsc --noEmit` + `vitest run`
- [x] `shoot.mjs` each page, read each screenshot, iterate

## Honesty rules applied

- No points total, rank, epoch, or referral — the mockup's `128,904 · Rank 214 · 25%`
  is fabricated data with no service behind it.
- "Fees you have paid" is a dash: `/positions/:a/history` carries no fee field, opening
  fees are currently 0%, and partial closes are not recorded at all (phase-4 §6), so a
  per-user fee total cannot be derived. The fee *schedule* is a real chain read.
- Account value renders a dash if any component of the sum is unavailable, never a
  partial sum presented as a total.
- Liquidation price stays unavailable, matching PositionsList's existing dash.

## Review

- Changed: 3 pages, 8 new components/modules, 4 new hooks, 4 new test files.
- Verified: typecheck, unit tests, and all three pages driven in a real browser.
- Left: `lib/types.ts`'s `realisedPnl`/`realizedPnl` drift is worked around, not fixed
  (not my file). Reported to the caller.
