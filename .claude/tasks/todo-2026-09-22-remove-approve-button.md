# Remove the Approve USDW button (levels 1 + 2)

## Why

`terminal_design.pdf` gives the order panel exactly one action — `BUY · LONG BTC`. The
implementation renders an `Approve USDW` button in front of it, and a second one in
`FundingModal`. Nothing in the repo ever planned to remove them; `ed8d3e1` deliberately
kept the trade-form one and only made it one-time (`approve(maxUint256)`).

The approval transaction itself is unavoidable: `OstiumTradingStorage.sol:486` pulls
collateral with `safeTransferFrom`, there is no per-user collateral balance in that
contract, and `contracts/src/mocks/USDW.sol` is a plain `ERC20 + Ownable` with no
`permit`. So the transaction stays — only the **separate button** goes.

Level 3 (a margin-account layer, how Hyperliquid/dYdX avoid this) is explicitly out of
scope: it is a new contract over vendored Ostium plus a full redeploy on 1874.

## Plan

### Level 1 — fold the approval into the primary action

- [ ] `OpenPositionForm.tsx`: delete the `needsApproval ? approve : submit` branch — the
      submit button is the only button. Drop `!needsApproval` from `canSubmit`
      (`insufficientBalance` still disables it, which also kills the flagged bug
      "Approve is offered for an order the balance cannot fund",
      todo-2026-09-21-funding-and-terminal-parity.md:181).
- [ ] `OpenPositionForm.tsx`: `handleSubmit` approves `maxUint256` first when
      `needsApproval`, then calls `openTrade`. Delete `handleApprove`; move its comment to
      the new site.
- [ ] `OpenPositionForm.tsx`: while `phase === 'approving'`, show a notice that the wallet
      will ask twice. Two prompts with no explanation reads as a failure.
- [ ] `FundingModal.tsx`: same fold into `handleRequest`, and switch
      `erc20.approve(amountRaw!)` → `approve(maxUint256)` so the vault allowance stops
      being consumed per deposit.

### Level 2 — arm the allowance during onboarding

- [ ] `useErc20.ts`: add `hasSpender` to `Erc20Handle`. `approve` currently throws at
      runtime for a spender-less handle; a consumer has no way to ask first.
- [ ] `useFaucet.ts`: after a successful claim, when `hasSpender` and
      `allowance < FAUCET_MINT_USDW`, `approve(maxUint256)`. A wallet that came through the
      faucet then reaches the terminal already armed and never sees an approval at all.
- [ ] `FaucetPanel.tsx`: `useErc20()` → `useErc20(TRADING_STORAGE_ADDRESS)` and rewrite the
      "no spender" note. The panel still renders no allowance.

Honest cost: the faucet now asks for two wallet confirmations instead of one. That is a
relocation of the prompt to onboarding, not an elimination — level 1 remains the backstop
for a wallet that never used the faucet. The vault deposit keeps its own first-deposit
prompt (different spender, `VAULT_ADDRESS`).

### Tests (written first)

- [ ] `OpenPositionForm.test.tsx`: replace the approve-button case — with a short
      allowance the submit button renders and is enabled; clicking it calls
      `approve(maxUint256)` and then `openTrade` with the right collateral.
- [ ] `FundingModal.test.tsx`: `funding-request` with a short allowance calls
      `approve(maxUint256)` then `requestDeposit`; `funding-approve` no longer exists.
- [ ] `FaucetPanel.test.tsx`: claiming approves max when the allowance is below the mint,
      and does not approve when it already covers it.
- [ ] `tests/e2e/trade-flow.spec.ts`: drop the `approve-button` / `funding-approve` steps.

### Verify

- [ ] Record the e2e baseline FIRST — it is red at HEAD (mockChain missing 5 PairInfos
      fns), so a red run afterwards proves nothing on its own.
- [ ] Unit suite, typecheck, whole-repo lint.
- [ ] Do NOT deploy: prod is on `ed8d3e1` and up to date; deploying is a separate go.

## Review

All plan items landed. Every box above is done.

### Changed

| File | What |
|---|---|
| `src/components/OpenPositionForm.tsx` | one button; `handleApprove` folded into `handleSubmit`; `needsApproval` out of `canSubmit`; two-prompt notice |
| `src/components/FundingModal.tsx` | approve folded into `handleRequest`, `amountRaw` → `maxUint256`, own notice |
| `src/components/FaucetPanel.tsx` | `useErc20(TRADING_STORAGE_ADDRESS)` |
| `src/hooks/useFaucet.ts` | `armAllowance()` after the mint |
| `src/hooks/useErc20.ts` | `hasSpender` on `Erc20Handle` |
| `src/app/globals.css` | `.approval-notice` |
| 3 unit suites + `tests/e2e/trade-flow.spec.ts` | rewritten around the folded flow |

### Verified

- **Unit: 300 passed / 300** (baseline before the work: 293/293 — the 7 new ones are this change).
- **Typecheck:** `tsc --noEmit` clean.
- **Lint + build:** `next build` → `✓ Compiled successfully`, `Linting and checking validity of types` passed, 11/11 static pages.
- **The actual payload**, grepped out of the fresh `.next`: `Approve USDW` **0**, `approve-button` **0**, `funding-approve` **0**, and the new notice present (4).
- **e2e:** 6 pass, 2 fail. Those 2 were re-run at HEAD with the work stashed and fail there **identically** — `AbiFunctionSignatureNotFoundError: "0x3acf643d" not found on ABI` at `mockChain.ts:87` (`PAIR_INFOS_ABI`). Pre-existing, unrelated, not introduced here. The earlier "8 failed" run was `fullyParallel` starving `next dev`; serial is the honest signal.

### NOT verified

- **Never exercised against a real wallet on 1874.** The two-confirmation sequence
  (approve → openTrade in one click) is covered by mocks only. Nobody has watched MetaMask
  actually raise two prompts in a row on this flow.
- **Not deployed.** Prod is on `ed8d3e1` and genuinely current — the button is there
  because the code has it, not because the box is stale.

### Left

- `tests/e2e/trade-flow.spec.ts:~157` pre-seeds the allowance against `TRADING_ADDRESS`,
  but the real spender is `TRADING_STORAGE_ADDRESS`. Harmless and now moot (the gate is
  `isDegraded`, and `needsApproval` no longer blocks submit), but the comment claiming it
  isolates the degraded gate is misleading. Pre-existing — flagged, not swept.
- The mockChain `0x3acf643d` gap that keeps trade-flow red is its own task.
