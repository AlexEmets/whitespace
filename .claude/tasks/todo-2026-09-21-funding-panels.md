# Deposit / Withdraw controls + a dedicated faucet panel — 2026-09-21

Owner's ask: Deposit and Withdraw as their own buttons in the Aster/Hyperliquid style,
out of the Vaults window; the faucet lifted into a panel of its own with a proper
"request test tokens" flow.

## What is there today (verified, not assumed)

- **The faucet is duplicated.** `claimFaucet()` is called from **two** components:
  `VaultPanel.tsx:53` and `OpenPositionForm.tsx:189` (the latter appears only when the
  wallet cannot fund the order it is typing). Two copies of the pending/error/refetch
  handling, two places to keep in step. This duplication is the real reason to extract a
  panel, beyond where it sits on screen.
- **Deposit/withdraw is buried** in `VaultPanel.tsx`, rendered only on `/vaults`
  (`app/vaults/page.tsx:9`). Nothing in the terminal reaches it.
- **The contract lifecycle is asynchronous and already modelled honestly**
  (`VaultPanel.tsx:12-14`): `requestDeposit` → settlement happens off this UI's control →
  `claimDeposit`. The panel refuses to say "Deposited" until `claimDeposit` succeeds.
  `lib/abi.ts:28-31` also exposes `requestWithdraw(uint256 shares)` and
  `cancelRequestWithdraw(uint32 settlementId, uint256 shares)`.
- `useErc20` (`hooks/useErc20.ts:58`) owns `claimFaucet`, and waits for the receipt so a
  caller can refetch straight after.

## Design constraint the reference model does not have

Aster and Hyperliquid deposit into an account balance that settles in one transaction. This
vault does **not**: a deposit is a *request* that a later settlement makes claimable. A
button pair copied from them would promise a synchronous action the contract cannot
perform. So the buttons may look like theirs, but the panel behind them must keep the
three-state lifecycle already implemented — `requested → settling → claimable` — and say
which state the user is in. Do not flatten it into "Deposit ✓".

## Work order

1. **`hooks/useFaucet.ts`** — lift the claim + pending + error + refetch logic out of the
   two call sites so there is one implementation. Both existing sites then consume it.
2. **`components/FaucetPanel.tsx`** — the dedicated panel. Shows the USDW balance, what the
   faucet mints and its per-address cadence (`USDW.claim()` mints 1 000 USDW per address
   per 24h — see the hosting design §11), a single primary action, and a live result. Keep
   the existing honest line: testnet collateral, no value.
3. **`components/FundingButtons.tsx`** — `DEPOSIT` / `WITHDRAW` pair in the terminal chrome,
   opening a modal. Reuse the `WalletPicker` modal pattern already in the repo
   (`WalletPicker.tsx` — portal, focus trap, Esc/backdrop close) rather than inventing a
   second dialog implementation.
4. **Move, do not duplicate.** `VaultPanel` keeps the LP-position view; the deposit and
   withdraw *controls* move into the modal. `/vaults` then renders the vault's state and
   the same modal trigger.
5. **Withdraw path** — `requestWithdraw(shares)` is in the ABI but has **no UI and no hook**
   today. This is new surface on the money path: it needs the same request/settle/claim
   treatment as deposit, plus `cancelRequestWithdraw`.
6. Tests: `VaultPanel` and `OpenPositionForm` suites both touch the faucet strings and will
   move with it. Baseline to hold: **259/259 green**.

## Risk note

Item 5 is the only genuinely new contract interaction. Everything else is relocation and
de-duplication of code that already works. Do 1–4 first and ship; do 5 as its own change
with its own verification, because a half-built withdraw is a user's money stuck in a
settlement they cannot claim or cancel.
