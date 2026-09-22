# Handover — close without a wallet balance (close-bond migration)

Written 2026-09-22. Read this before touching `feat/close-bond-from-position`.

## The one-line state

The contract work is **finished and green (183/183)**, on a branch, **not merged and not
deployed**. It is blocked on one thing: the registry gov private key. Everything else is done.

## What the problem was

A trader could not close their own positions. Reverted tx
`0x8a357f2b0fd3dd0262afb9b20235ebf3e27453a8e253e5dbccf4f4260e1addd2`, replayed with
`eth_call` at block 8491849, decoded to:

```
ERC20InsufficientBalance(0x43Ac…B06B, balance 57243, needed 1000000)
                                      = 0.057 USDW     = 1.00 USDW
```

`OstiumTrading.sol` pulled a flat `pairOracleFee` (1.00 USDW) **from the wallet** when a close
was requested. Opening charges it too, so a trader who spent their balance on margin was
stranded. The faucet could not rescue them either — `USDW.claim()` is once per address per 24h.

**The charge was never really a fee.** On a successful *full* close the old callback refunded
it in the same transaction. It was a refundable anti-griefing bond, so the trader was blocked
by the need to post a deposit that would have been handed straight back.

## What was built

The bond stops being posted at request time and stops being refunded on full close — those
cancelled out exactly — and is charged from the **position's own collateral** on the only two
paths where it has teeth: a cancelled close, and a partial close. Economics are unchanged on
all three paths; the wallet is no longer involved.

Branch `feat/close-bond-from-position` in worktree `.claude/worktrees/close-bond`, 11 commits
from `028b804`:

| file | change |
|---|---|
| `OstiumTrading.sol` | request-time wallet charge removed; the `closeTradeMarketTimeout` refund removed |
| `OstiumTradingCallbacks.sol` | `_chargeBondFromPosition`; refund branch gone; new event |
| `TradingCallbacksLib.sol` | `applyBondToTrade` — leverage recompute, liquidation guard, tp/sl correction |
| `OstiumTradingStorage.sol` | `refundOracleFee` + `RefundOracleFeeFailed` removed (zero callers) |
| `services/indexer/` | `OracleFeeBondCharged` ABI entry + handler |
| `apps/web/src/lib/tx.ts` | **on `main`, commit `ff72707`** — stopped claiming the fee comes from the wallet |

Gates: 183/183 forge, EVM-compat clean, `OstiumTrading` 904 B headroom, `OstiumTradingCallbacks`
760 B, no storage-layout change (that is what keeps this a redeploy-and-repoint).

## The blocker — read before planning anything

`OstiumRegistry.updateContract(bytes32,address)` is `onlyGov`.

| | |
|---|---|
| registry | `0xD6Cc323BF2736B121586B2929E0E27a80DDCC98A` |
| gov | `0xFB042739DaA0946E9e6658CA6603Ff5EcEa60Dd8` — **EOA**, code `0x`, nonce 24, 0.058 WBT |
| deployer / USDW owner | `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` — a **different** key |

Gov is a plain private key that someone has used 24 times. It is **not in this repository and
not on the prod box** (checked `.env`, `contracts/.env`, `services/*/.env`). Find where it
lives before scheduling anything. Nothing else stands in the way.

## Things that cost hours and would cost them again

**`trading` and `callbacks` are NOT upgradeable.** They sit behind *bare* `ERC1967Proxy`
(`script/Deploy.s.sol:99`) — no admin, no `upgradeTo` on either side, 77-byte runtime, admin
slot `0x0`. `Initializable` on the implementations is a red herring inherited from upstream
Ostium. An earlier session asserted "it's a proxy, so we can upgrade it" and was wrong. The
switch is the **registry**, because authorisation is resolved per call via
`registry.getContractAddress('trading')`.

**`tradingStorage` is never redeployed.** Open positions, balances, `devFees` and open interest
all live there. Redeploying it would orphan every position.

**Repoint `callbacks` BEFORE `trading`.** New-trading + old-callbacks makes the old callback
refund a bond nobody charged — it drains escrow and then reverts `RefundOracleFeeFailed`,
stranding closes. The other ordering only overcharges. Full procedure in
`docs/superpowers/runbooks/close-bond-migration.md`.

**The indexer must be redeployed and backfilled from the switch block.** The charge emits
`OracleFeeBondCharged` and the handler writes *absolute* post-charge state. Every charge an old
indexer misses leaves that position permanently 1 USDW high and 0.01x low, and the drift
outlives the position via open interest.

**`PERCENT_BASE` is 10000** (`OstiumTrading.sol:28`), settled by test. `TradeLocal.t.sol:166`
passes `0` as `closePercentage` (the contract defaults that to a full close) — the literal
`100` on that line is `slippageP`. Do not re-investigate; it looked like a bug and is not.

**A position cannot be OPENED with collateral below one bond** — the `pairMinLevPos` floor
equals the bond exactly at 10x. It can only drift there via rollover/funding, which is what
the waive guard actually protects.

## Judgment calls already made — do not silently reverse

- **The stop-loss is RE-CLAMPED, never nulled** (`TradingCallbacksLib`, `correctSl` not
  `correctToNullSl`). This deliberately diverges from `handleRemoveCollateral`, which nulls it.
  There, the leverage rise is trader-initiated; here it is the protocol taking a fee on a close
  the trader asked for and that failed. Measured before the fix: a single charge moved a stop
  from 59,475.915 to **0**, and `correctSl` clamps every "widest stop" to exactly that boundary
  at registration, so it was the default case, not an edge.
- **`MARKET_CLOSED` values the position at `IOstiumOpenPnl.lastTradePrice`**, falling back to
  open price only for a pair that never traded. Valuing at its own entry makes `profitP` zero
  by construction, so the guard saw ~97.5% phantom headroom however far underwater the position
  was. Known residual: `lastTradePrice` is stale by definition — narrower hole, not zero.
- **`NO_TRADE` and `WRONG_TRADE` cancels are free.** `NO_TRADE` has nothing to debit;
  `WRONG_TRADE` would hit an unrelated position in a reused slot. Judged safe because
  `triggerTimeout` (30 blocks) and report `maxAge` (10 s) interlock — in-flight closes cannot
  be stacked to harvest free cancels.
- **The waive never reverts.** Fee accounting must not be the reason a close fails; that is the
  entire defect. The protocol forgoes at most one bond.

## What was NOT done

- **No live-chain verification.** Everything is a local `DeployScript.deployAll` fixture. The
  acceptance test is in the runbook: after migrating, close a position from a wallet holding
  **zero** USDW. "Transactions mined" is not evidence.
- **Nothing reserves a bond at open time.** Not needed once this ships, but note it if the
  design changes.
- Pre-existing, untouched, and unrelated to this work: `/trade` has a 4px overflow on
  `.leverage-row` (proven identical under a forced-monospace override), and
  `services/indexer` `test/decode.test.ts` throws on a `PriceReceived` fixture lookup.

## Working notes

- The SDD ledger with every review finding, ruling and parked item is
  `.superpowers/sdd/2026-09-22-close-without-wallet-balance/progress.md` (git-ignored). Read it
  before re-opening any closed question.
- Spec: `docs/superpowers/specs/2026-09-22-close-without-wallet-balance-design.md`.
  Plan: `docs/superpowers/plans/2026-09-22-close-without-wallet-balance.md`.
  Runbook: `docs/superpowers/runbooks/close-bond-migration.md`.
- The plan's 8-task split was wrong and was collapsed mid-execution: tasks 3–6 had no
  independently testable deliverable (3 and 4 leave the suite red on purpose). ~80 lines of
  Solidity do not need eight review gates.
- Every test in `CloseBond.t.sol` and the four new `closeTradeMarketTimeout` cases in
  `KeeperCensorship.t.sol` were re-run against pre-fix contracts and fail there. Keep that
  standard: a green test that is green without the fix proves nothing.
