# Phase 1.5: Make the deployed system operational — Design

**Status:** approved 2026-09-08, ready for an implementation plan.

**Goal.** Open and close one real BTC/USD position on Whitechain testnet 1874, through the
genuine two-phase price flow, against the contracts already deployed there.

**Why this phase exists.** Phases 0–1 delivered a system that *deploys* but cannot *trade*: no
market is listed, no oracle signer is authorised, no keeper is allowlisted, and the vault holds
no liquidity. The phase table in the main design spec jumps straight from "compiles and deploys"
to "an order completes end-to-end", which hides a body of configuration work with its own
failure modes. This phase names that work and closes it.

**Completion gate.** A position is opened and closed on chain 1874, the trader's USDW balance
reflects the realised PnL, and every step is reproducible from a committed script.

---

## 1. Starting state

Deployed and verified on 1874 (`deployments/1874.json`, commit `22e1a5c`):

| Component | Address |
|---|---|
| registry | `0xD6Cc323BF2736B121586B2929E0E27a80DDCC98A` |
| collateral (USDW) | `0x34A2945DBFe45e86dB968ff7E6Bb7d8394711f89` |
| tradingStorage | `0xb51217a43BF812B354E18977a4781909C4d33341` |
| pairsStorage | `0xc5B68AfA8f64288f6d06DEfC5c07555Ef5323397` |
| trading | `0x9f7F9be7731E805B0b9174465257f0C1Ab589f27` |
| callbacks | `0x4084cd63dB84c88c98418e33b88449b3b006da9c` |
| vault | `0x7B9147B4b8b05e7e3c3F86694d8EA7a639c2D516` |
| priceRouter | `0xB14c4cf81007D60afDfd2Cc48b94cFCf861134a4` |
| verifier | `0xf2236F1Cc7610D75DD1D38563aA090bdD7102Fc8` |
| priceUpKeep | `0x3Ce549F5Aa65141D10f25BE793d63572bC3908Be` (deployed, **not** registered) |

Roles are held as five distinct keys outside the repo at `~/.whitespace-keys/`. `gov` and the
registry `owner` are both ours, which is what makes every step below reachable.

**Budget constraint.** 0.308 ETH remains on the deployer and the faucet is CAPTCHA- and
OAuth-gated, so refuelling needs a human. Every flow must be proven locally before it is paid for
on chain.

**Collateral decision.** USDW stays. Chain 1874 does carry real bridged `USDC.e`
(`0x5eb541ba8a2dd841af7864c3389162a23dda8401`, 6 decimals), but `OstiumTradingStorage.initialize`
freezes the collateral address at construction, so switching would mean a full redeploy — roughly
0.19 ETH of the 0.308 available. USDW's faucet also lets testers self-serve, which `USDC.e` cannot.
Recorded as a deliberate divergence from mainnet, where `USDC.e` would be the collateral.

---

## 2. What the vendored source actually requires

Each of these was read out of `contracts/src/vendor/ostium/`, not assumed. They are the reason
this phase is larger than "add a market".

**Listing a pair has two unlisted prerequisites.** `OstiumPairsStorage.addPair` carries
`groupListed(_pair.groupIndex)` and `feeListed(_pair.feeIndex)` modifiers, so `addGroup` and
`addFee` must succeed first. The `Pair` struct is
`{bytes32 from, bytes32 to, bytes32 feed, uint64 tradeSizeRef, uint32 overnightMaxLeverage, uint32 maxLeverage, uint8 groupIndex, uint8 feeIndex, string oracle}`.

**The `priceUpKeep` registry key is derived from the pair, not fixed.** `OstiumPriceRouter` and
`OstiumTradingCallbacks` both resolve it as
`bytes32(abi.encodePacked(pairsStorage.oracle(pairIndex), 'PriceUpkeep'))`. Phase 1 deliberately
left it unregistered because the key is undeterminable before a pair exists; listing the pair
determines it, and this phase registers it.

**The report format is fully specified and unexotic.**
`reportData = abi.encode(bytes32 feedId, uint32 timestamp, int192 price, int192 bid, int192 ask, bool isMarketOpen, bool isDayTradingClosed)`,
then `signedReport = abi.encode(reportData, bytes32 r, bytes32 s, uint8 v)`. The signature is a
standard EIP-191 `personal_sign` over `keccak256(reportData)` — `OstiumVerifier.verify` recovers
with `ecrecover(keccak256(abi.encodePacked('\x19Ethereum Signed Message:\n32', reportHash)), v, r, s)`.

**The report must answer a past instant, not the present.** `OstiumPrivatePriceUpKeep.performUpkeep`
reverts `InvalidPrice` unless `order.timestamp == timestamp` in the report *and*
`expectedFeedId == reportFeedId`. This is the two-phase design made concrete: the publisher is
asked for the price *at the requested timestamp*, and streaming the latest tick will not do.

**There are three separate allowlists, with three different owners.**
`registerAuthorizedSigner` is `onlyGov`; `registerForwarder` is `onlyTimelock`, which in this
codebase resolves to `IOwnable(registry).owner()`; `registerContract` is `onlyGov`.

**The vault has no `MMDeposit`.** It is an ERC-4626 with a two-step settlement flow:
`requestDeposit(assets)`, then `claimDeposit(settlementId)` once a settlement has occurred.
`deposit()` and `mint()` are overridden to revert `FunctionDisabled()`. `maxSettlementInterval`
is 86400 s, so waiting for a natural settlement would cost a day; `forceSettlement()` is
`onlyGov` and is the intended escape hatch.

---

## 3. Components

Three units, each independently testable, each with one responsibility.

### 3.1 `contracts/script/Operate.s.sol`

All on-chain configuration, idempotent so a partial run can be re-run safely. Reads addresses
from `deployments/1874.json`; role addresses from the environment, as `Deploy.s.sol` already does.

Ordered steps, each guarded by a "already done?" read:

1. `pairsStorage.addGroup(...)`
2. `pairsStorage.addFee(...)`
3. `pairsStorage.addPair({from:"BTC", to:"USD", feed, ..., oracle:"ostium"})`
4. `verifier.registerAuthorizedSigner(signer)`
5. `priceUpKeep.registerForwarder(keeper)` — sent by the registry owner, not gov
6. `registry.registerContract(<pair.oracle> + "PriceUpkeep", priceUpKeep)`
7. seed the vault: `USDW.mint(lp)` → `approve(vault)` → `requestDeposit` → `forceSettlement` → `claimDeposit`

Idempotency matters more than usual here: the deployment cannot be repeated for want of gas, so a
script that fails halfway must be safe to resume.

### 3.2 `packages/reporter/`

A small Node module. Its only job is to turn a price into bytes the chain will accept.

- `buildReportData({feedId, timestamp, price, bid, ask, isMarketOpen, isDayTradingClosed}) -> hex`
- `signReport(reportData, privateKey) -> signedReport`
- `encodePerformData(signedReport, orderId) -> hex`

No network access, no price sourcing, no scheduling. That keeps it pure and directly unit-testable,
and makes it the seed of phase 3's publisher rather than throwaway scaffolding: phase 3 adds venue
ingest, index construction and k-of-N signing *around* this, without changing it.

### 3.3 `contracts/test/integration/TradeLocal.t.sol`

Proves the whole cycle on anvil before any gas is spent: configure, open, sign with `vm.sign`,
deliver, assert the position exists, close, assert PnL landed in USDW.

It must also pin the three failure modes, because each is a distinct misconfiguration we need to
be able to recognise from a live revert rather than guess at:

| Test | Expected revert |
|---|---|
| unregistered signer | `NotAuthorizedSigner` |
| report timestamp ≠ order timestamp | `InvalidPrice` |
| caller not allowlisted | `NotForwarder` |

---

## 4. Trade flow

Identical on the way in and the way out; the loop runs twice.

```
openTrade(pair, collateral, leverage, dir, slippage)
  └─ Trading validates, stores a pending order
     └─ PriceRouter.getPrice(...) → priceUpKeep emits PriceRequestedV2(orderId, feed, timestamp)

reporter: buildReportData(feed, <that exact timestamp>, price, bid, ask, true, false)
          signReport(...) with the authorised signer key
          encodePerformData(signedReport, orderId)

priceUpKeep.performUpkeep(performData)   ← must come from the allowlisted forwarder
  └─ verifier.verify → TradingCallbacks.openTradeCallback
     └─ spread + price impact applied, slippage checked, position opened or cancelled

closeTradeMarket(...) → the same loop → realised PnL settled in USDW
```

`slippage` is the trader's only protection against an unfavourable execution price, because the
price is unknown at commit time. That is a UI requirement inherited by phase 5, noted here so it
is not rediscovered later.

---

## 5. Testing strategy

1. **Unit** — `packages/reporter` against fixtures, including a signature whose recovered address
   is asserted, so an encoding change cannot silently pass.
2. **Integration on anvil** — the full cycle plus the three failure modes above.
3. **Live on 1874** — only after 1 and 2 are green. One position, opened and closed.

The ordering is a budget constraint, not a preference: a failed live run cannot simply be retried.

---

## 6. Out of scope

Deliberately excluded, with the phase that owns each:

- Multi-venue price ingest, index construction, EMA mark price — phase 3.
- k-of-N threshold signatures and contract rails. `OstiumVerifier.verify` is 1-of-N *by
  construction* — a single `ecrecover` against an `isAuthorizedSigner` mapping — so raising the
  threshold means editing vendored source, and `verify` being `external view` means the
  deviation rail needs state that lives elsewhere. Phase 2 owns both problems, and will be the
  first entry in `VENDOR.md`'s currently empty local-modifications table.
- Liquidations — phase 6.
- Any UI — phase 5.
- Chain 2625 — still unfunded, and no gas source has been found for it.

---

## 7. Open items the plan must resolve by reading the source

These are deliberately unspecified here because guessing them would be worse than naming them.
Each is a read, not a decision:

- **`Group` and `Fee` struct fields and sane values.** `addGroup` and `addFee` are gated by
  `groupOk` / `feeOk` modifiers whose bounds have not been read yet. Read both structs and both
  modifiers, then choose values that satisfy them for a single BTC/USD market.
- **The `feed` bytes32 is ours to choose.** We are not consuming Chainlink feeds — `feedId` is
  only an identifier that the pair and the report must agree on. Pick one, document it, and
  assert the agreement in a test.
- **Price scaling for `int192 price/bid/ask`.** The vendored contracts annotate collateral fields
  as PRECISION_6 and other quantities as PRECISION_18; which applies to report prices must be
  read from `TradingCallbacks` before a value is signed. A wrong exponent would open a position
  at a price off by 10^12 and would not revert.
- **`forceSettlement()` side effects.** Read it before calling; it is `onlyGov` and touches vault
  accounting.

## 8. Risks

| Risk | Handling |
|---|---|
| A configuration step fails halfway and gas is short | every step idempotent and separately resumable |
| Report encoding subtly wrong; every delivery reverts | proven on anvil first; signature recovery asserted in a unit test |
| `forceSettlement` has side effects we have not read | read it before use; assert vault state before and after |
| Pair parameters chosen badly, so trades are rejected on size or leverage | assert an opened position in the integration test, not just a successful call |
| Price for a *past* timestamp is not something a naive publisher can produce | phase 1.5 signs a fixed price for the exact requested timestamp; phase 3 must keep a short history |
