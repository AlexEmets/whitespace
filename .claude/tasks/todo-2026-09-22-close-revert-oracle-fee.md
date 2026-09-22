# Closing a position reverts, and the UI cannot say why

## Root cause — confirmed on chain, not inferred

Reverted tx `0x8a357f2b0fd3dd0262afb9b20235ebf3e27453a8e253e5dbccf4f4260e1addd2`
(`closeTradeMarket(0, 3, 10000, …)`, block 8491850, `status 0`). Replayed with `eth_call`
at block 8491849; the revert data decodes to:

```
ERC20InsufficientBalance(0x43Ac…B06B, balance 57243, needed 1000000)
                                      = 0.057243 USDW    = 1.00 USDW
```

`pairOracleFee(0)` read live = `1000000`. Exactly the `needed`.

`contracts/src/vendor/ostium/OstiumTrading.sol:310-311` — the close path pulls the flat
oracle fee **from the trader's wallet**:

```solidity
uint256 oracleFee = pairsStorage.pairOracleFee(pairIndex);
storageT.transferUsdc(sender, address(storageT), oracleFee);
```

So **closing costs 1.00 USDW that must be sitting in the wallet**. Opening charges it too,
so a trader who spends down to zero opening positions cannot close them.

The second report is the same trap's other half: `USDW.claim()` reverted with
`CooldownActive`. Read live — `lastClaim + 24h` unlocks in 2.38 h. So the wallet cannot be
topped up either. `contracts/src/mocks/USDW.sol:27-30`.

Neither failure is a code bug in this repo. The bug is that **the UI lets both happen and
then reports "Transaction reverted on chain" with no reason**, after the user has paid gas.

## Why the message is useless

`hooks/useCloseTrade.ts:34` calls `writeContractAsync` with **no `simulateContract`**, so
the revert is only discovered once mined. `lib/tx.ts:43` then throws
`TransactionRevertedError`, whose own comment says the reason "is not recoverable here" —
true *after* mining, false *before* it.

Six call sites render `err.message` raw (`PositionsList.tsx:69`, `OpenPositionForm.tsx:275`,
`FundingModal.tsx:110`, `OrdersList.tsx:53`, `useFaucet.ts:88`), which for a viem error is
the multi-paragraph dump with a docs link — the cosmetic complaint.

## Plan

### 1. `lib/tx.ts` — one place that turns a thrown write error into one sentence

- [ ] `describeTxError(err): string | null`. `null` means render nothing.
- [ ] User rejection → `null`. Rejecting is a deliberate act; a red alert implies fault.
      Detect via viem's `UserRejectedRequestError` through `BaseError.walk`, plus the
      EIP-1193 `code === 4001` fallback for wallets that do not produce a typed error.
- [ ] Decode known custom errors to sentences, following the `explainCancelReason` shape
      already in `lib/abi.ts:137`:
      - `ERC20InsufficientBalance(_, balance, needed)` → names both figures in USDW.
      - `CooldownActive(availableAt)` → says when the faucet unlocks.
- [ ] Anything else → viem's `shortMessage` (one line), never `message`.
- [ ] Replace the raw `err.message` at all five write call sites.

### 2. Catch it before it costs gas

- [ ] `useCloseTrade`: `simulateContract` first, then write the simulated request. The
      revert then arrives pre-flight, with data to decode, and no gas is spent.

### 3. Stop offering an action that cannot succeed

- [ ] Close control: disable when wallet balance < `pairOracleFee`, with the reason inline
      rather than an error after the fact.

### Tests (written first)

- [ ] `tx.test.ts`: user rejection → `null`; `ERC20InsufficientBalance` → both figures;
      `CooldownActive` → unlock time; unknown viem error → `shortMessage`, and assert the
      result contains no newline and no `viem.sh`.
- [ ] `PositionsList.test.tsx`: balance below the fee → Close disabled and the reason shown.

## Out of scope — flagged, not fixed

Opening a position does not reserve the USDW needed to later close it, so the trap can be
re-entered the moment the wallet is drained. Fixing that means the order form's Max/balance
check must withhold one oracle fee per open position — a product decision about trading
economics, not a bug fix. Raising it separately.

## Review

**Changed**
- `lib/tx.ts` — `describeTxError(err)`: one place deciding what a failed write says.
  Rejection → `null`; `ERC20InsufficientBalance` / `CooldownActive` decoded from the raw
  revert data into sentences; everything else → viem's one-line `shortMessage`.
- `useCloseTrade.ts` — `simulateContract` before the write, so a revert arrives pre-flight
  with data to decode and costs no gas.
- Five call sites stopped rendering `err.message`: `PositionsList`, `OpenPositionForm`,
  `FundingModal`, `OrdersList`, `useFaucet`. The first two fall back to `idle` rather than
  `error` on a rejection, so the control simply offers itself again.
- `FaucetPanel.test.tsx` — replaced a test that asserted rejections are *shown* while
  feeding it a plain `Error` (not what a wallet throws), so it passed without exercising
  the path. Now: a real `UserRejectedRequestError` is silent, and `CooldownActive`
  explains the 24h limit.

**Verified**
- 310/310 unit tests, `tsc --noEmit` clean.
- End to end against the live chain, not a mock: re-simulated the real failing call
  (`closeTradeMarket(0, 3, 10000, …)` at block 8491849) and passed the thrown error
  through `describeTxError`. Output:

  > Not enough USDW in your wallet: this needs 1.00 and you hold 0.06. Closing charges
  > the oracle fee from your wallet, separately from the position's collateral.

  That is the exact call that previously produced the unreadable dump.

**Left**
- Close is still *offered* when the wallet cannot pay the fee; it now fails fast with a
  clear reason instead of costing gas. Disabling it up front needs `pairOracleFee` +
  balance per row, and 1874 has a single public RPC that 429s aggressively
  (`docs/runbooks/deploy-testnet.md`), so N positions × 2 extra reads per render is a real
  cost. Wants a shared read, not a per-row hook.
- Opening still does not reserve the USDW needed to later close, so the trap can be
  re-entered. Product decision, raised above.
- Only the close path simulates. `useOpenTrade`, the vault deposit and the faucet claim
  still discover reverts after mining — same fix applies, not made here to keep this diff
  to the reported bug.
- No live click-through: the wallet is not connectable from this environment.
