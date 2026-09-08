# Phase 2 decisions — oracle hardening

Phase 2 replaces the two contracts that decide what a price *is*. Before it, one ECDSA key
controlled the price of every market, with nothing standing beside it — on Arbitrum, Ostium has
a Chainlink feed as an independent source; on Whitechain there is none. After it, a price needs
**three signatures from three distinct authorised keys** and has to survive **four contract
rails** that do not care who signed.

Nothing under `contracts/src/vendor/` was touched. The new code is two contracts under
`contracts/src/oracle/`, four functions plus one entrypoint added to `contracts/script/Operate.s.sol`,
and three test files.

| Path | What it is |
|---|---|
| `contracts/src/oracle/WhitespaceVerifier.sol` | Layer 1 — k-of-N threshold verification, domain separation |
| `contracts/src/oracle/WhitespacePriceUpKeep.sol` | Layer 2 — staleness, deviation, per-feed breaker, global pause |
| `contracts/script/Operate.s.sol` | `+4` idempotent install functions, `+runOracle()` entrypoint |
| `contracts/test/helpers/ReportLib.sol` | The wire format, written once |
| `contracts/test/oracle/WhitespaceVerifier.t.sol` | 39 unit + fuzz tests |
| `contracts/test/invariant/VerifierThreshold.t.sol` | Design-spec invariant 5 |
| `contracts/test/integration/OracleHardening.t.sol` | 44 tests: rails, e2e, migration window |

---

## 1. The wire format is the contract with the publisher

```solidity
reportData = abi.encode(
    uint256 chainId,            // must equal block.chainid
    address verifier,           // must equal address(this) on the verifier
    bytes32 feedId,
    uint32  timestamp,
    int192  price,              // 18 decimals
    int192  bid,
    int192  ask,
    bool    isMarketOpen,
    bool    isDayTradingClosed
);
signedReport = abi.encode(bytes reportData, bytes[] signatures);  // each 65 bytes, r||s||v
digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(reportData)));
```

Nine static words, 288 bytes. `packages/publisher/` is being built independently against this
same specification, so two properties are pinned by test rather than left to agreement:

- `test_reportDataIsNineStaticWords` — a publisher emitting eight or ten fields produces a
  different keccak, so every signature is unrecoverable.
- `test_digestMatchesLiteralEip191Encoding` — `ReportLib` spells the EIP-191 prefix out
  literally; the verifier calls OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash`. The
  test asserts the two agree, so the test cannot be fooled by the implementation's own helper
  changing meaning.

**Signatures must be sorted by recovered signer address, strictly ascending.** This is a
requirement on the publisher and it is not optional; see §2.

**Prices are 18 decimals.** `65_000e18`, not `65_000e8`. A wrong exponent reverts nowhere. The
only thing in the system that would notice is the deviation rail, and only on a feed that
already has a baseline.

---

## 2. Layer 1 — `WhitespaceVerifier`

Implements `IOstiumVerifier`, so it drops into the registry under the existing `ostiumVerifier`
key and every consumer keeps working unchanged. `verify()` requires, in this order:

1. `signatures.length >= threshold` → `InsufficientSignatures(got, required)`
2. `reportData.length >= 64` → `MalformedReport(length)`
3. `chainId == block.chainid` → `WrongChain(got, expected)`
4. `verifier == address(this)` → `WrongVerifier(got, expected)`
5. per signature, strictly ascending recovered address → `SignersNotAscending()`
6. per signature, `isAuthorizedSigner[signer]` → `NotAuthorizedSigner(address)`

Initial parameters: **k = 3, N = 5**, both governed by `registry.gov()`.

### Ascending order does two jobs

It rejects **the same signature replayed k times** to reach the threshold from one compromised
key, and it makes duplicate detection **O(n) with no storage writes** instead of O(n²) or a
per-call set. Sorting is free off-chain and unforgeable on-chain. Six tests cover it, including
`test_onlyTheSortedPermutationIsAccepted`, which walks all six permutations of a valid 3-signer
set and asserts exactly one is accepted.

### An unauthorised signature rejects the whole report

Not "skipped and not counted". Skipping would let a relayer pad a k-1 report with garbage and
learn nothing from the failure; rejecting makes the failure loud and names the address. It also
preserves the exact error the phase-1 runbook documents (`NotAuthorizedSigner(<recovered>)`).

### Domain separation

`chainId` and `verifier` live **inside the signed bytes**, so whoever relays a report cannot
rewrite them. Testnet 1874 and mainnet 1875 will run the same contracts with the same signer
set; without this, a testnet report is a mainnet report.
`test_rejectsReportAddressedToASiblingVerifier` is the sharp case: a second verifier with the
*same signer set* and the *same registry* still rejects a report addressed to the first. A naive
"is the signer authorised?" check waves that through.

### Two liveness guards on governance

- Removing a signer that would leave `N < k` reverts `ThresholdExceedsSignerCount`. Otherwise
  gov could strand the verifier in a state where no report can ever reach the threshold and
  every price delivery in the system fails.
- `threshold == 0` is refused. A zero threshold accepts a report with no signatures at all.

### `verify` stays `view`

No nonce, no storage write. Per-order replay protection is the upkeep's job, via the recorded
`order.timestamp`, and it must stay there — a nonce here would make `verify` non-view and break
every consumer that staticcalls it.

---

## 3. Layer 2 — `WhitespacePriceUpKeep`

Implements `IOstiumPriceUpKeep` + `IOstiumForwarded`, registered under the per-oracle key
`"BTC/USDPriceUpkeep"`. Everything the vendored `OstiumPrivatePriceUpKeep` does is preserved
verbatim: the `onlyRouter` request, `PriceRequestedV2`, the forwarder gate, the byte-identical
`order.timestamp` check, and the `fulfill` dispatch into `IOstiumTradingCallbacks`.

### Why both layers, restated concretely

k-of-N defends against **key compromise**. It is powerless when all N signers are honest and
receive the **same wrong input** — they will all honestly sign the same falsehood. The deviation
rail catches exactly that: it does not ask *who* signed, it asks whether the **number** is
plausible. Neither check subsumes the other; they rest on different assumptions.

| Rail | Initial value | Threat it addresses | Trips | Does not trip |
|---|---|---|---|---|
| `maxAge` | 10 s | frozen or replayed feed; a keeper sitting on a stale signed report | `test_staleRailRejectsOneSecondLate` | `test_staleRailAcceptsAtTheBoundary` |
| `maxDeviationBps` | 500 bps | aggregation bug or venue manipulation producing a jump that every honest signer signs | `test_deviationRailRejectsAJump`, `…RejectsADownwardJump` | `test_deviationRailAcceptsANormalMove` |
| Per-feed breaker | off | incident on one asset — halt BTC without touching anything else | `test_haltedFeedRejectsNewOrders`, `…RejectsInFlightDelivery` | `test_haltingAnotherFeedDoesNotStopThisOne` |
| Global pause | off | everything else; guardian hot key, immediate, no timelock | `test_guardianPauseBlocksNewOrders`, `…BlocksInFlightDelivery` | `test_unpausedSystemTrades` |

**Every rail has a test that trips it AND a test that does not.** A rail suite that only shows
rejections cannot distinguish a working rail from one that rejects everything — and a rail that
rejects everything is a dead exchange, which is worse than the failure it was added to prevent.

### The rails are a backstop, not the filter

The publisher's own bounds (2 s venue staleness, 10 bps spread, 50 bps venue deviation, 3-of-4
healthy venues) are an order of magnitude tighter. **A contract rail that trips during normal
operation is a liveness bug, not a safety feature**, so the defaults are deliberately loose.
They are baked into the constructor, so a deployment that forgets to configure is safe rather
than open.

### The first price for a feed sets the baseline and is not rail-checked

There is nothing to compare it against, and inventing a bound would mean hardcoding an expected
price per asset. `test_firstPriceSetsTheBaselineWithoutARailCheck` proves this with $1,000,000
BTC — 15× the market — accepted as a baseline.

### Non-positive prices are rejected on an open market

Not decoration. It is what makes `lastPrice == 0` a sound "no baseline yet" sentinel, and a zero
price reaching the callbacks reads as `MARKET_CLOSED` rather than as an error. A zero baseline
would also disarm the deviation rail for that feed permanently.

### `clearPriceBaseline` exists for liveness, and is gov-only

A genuine move larger than `maxDeviationBps` — a crash, a weekend gap, a market reopening far
from where it closed — wedges the feed **permanently**: every honest report afterwards deviates
from a baseline that no longer reflects the market, and there is no way back. This is the way
back. It is gov-only because it is also the way to disarm rail 2 for exactly one report.
`test_govCanClearTheBaselineToUnwedgeAFeed` drives the whole cycle: rail trips, gov clears, the
byte-identical report then lands.

### Pause and halt are enforced at request time as well as at delivery

A pause that only blocked delivery would let `openTrade` succeed, move the trader's collateral
into `tradingStorage`, and strand it for `marketOrdersTimeout` (30 blocks) until the trader
remembers the timeout reclaim. Reverting inside `getPrice` means the whole transaction reverts
and no collateral moves — `test_haltedFeedRejectsNewOrders` asserts the trader's balance is
unchanged.

Enforcing it at delivery too closes the window where an order already in flight when the halt
lands still executes at the very price the guardian distrusts.

The cost, stated plainly: **a pause also stops closes and liquidations.** That is the intended
behaviour of an emergency stop. When the price source is not trusted, closing a position at an
untrusted price is not obviously better than not closing it.

### Guardian may stop, only gov may restart

`pause()` and `haltFeed()` are `guardian || gov`. `unpause()`, `resumeFeed()`,
`clearPriceBaseline()` and every parameter setter are **gov only**. The asymmetry is the point:
the emergency stop must be reachable by a hot key on a pager rotation; restarting the exchange
must not be. Critically, the guardian **cannot retune the rails** — widening
`maxDeviationBps` to 100% would disarm layer 2 without pausing anything, which is precisely the
move a compromised hot key would want (`test_guardianCannotChangeParameters`).

`setMaxAge(0)` and `setMaxDeviationBps(0)` are refused: both would reject every report.
`setMaxDeviationBps(> 10000)` is refused because above 100% the rail can no longer reject
anything upward — a confusing half-disabled state, better expressed by halting the feed.

---

## 4. Deployment shape: plain constructor, not `ERC1967Proxy`

`Deploy.s.sol` puts the vendored upkeep behind an `ERC1967Proxy`. `WhitespacePriceUpKeep` is
deployed directly instead.

**Measured, not assumed:** `grep -rl "UUPSUpgradeable\|upgradeToAndCall" contracts/src/vendor/`
returns **nothing**. No contract in the vendored tree is UUPS or exposes an upgrade function, so
every `ERC1967Proxy` in `Deploy.s.sol` sits in front of an implementation that can never be
upgraded. The proxy buys a second deployment, an extra `DELEGATECALL` on every price delivery,
and an uninitialised-implementation footgun, in exchange for nothing.

This is an observation about the existing deployment, reported rather than changed —
`Deploy.s.sol` is out of scope for this phase and another agent is working nearby.

---

## 5. Installation: four functions, four "already done?" reads

`Operate.s.sol` gains four public functions in the same shape as its existing eight — one
`msg.sender` role each, each opening with a read that answers "already done?" — plus a separate
`runOracle()` entrypoint.

| Function | Sender | "Already done?" read |
|---|---|---|
| `installHardenedVerifier` | `gov` | registry `ostiumVerifier` already resolves to a hardened instance |
| `authoriseHardenedSigners` | `gov` | per signer `isAuthorizedSigner`, then `threshold()` |
| `installHardenedUpkeep` | `gov` | registry `BTC/USDPriceUpkeep` already resolves to a hardened instance |
| `authoriseHardenedForwarder` | registry `owner()` (`onlyTimelock`) | `isForwarder(keeper)` |
| `configureOracleRails` | `gov` | `maxAge()`, `maxDeviationBps()`, `guardian()` compared before writing |

Each resolves its target **through the registry**, not through a `Config` field, because the
registry is the single source of truth for which contracts the vendored code will actually call.
`Config` was left untouched and a separate `OracleConfig` struct added, so no existing test had
to change shape.

The "is this a hardened instance?" probe is a low-level `staticcall` to a getter only the
hardened contract has (`threshold()` / `maxAge()`), built with
`abi.encodeCall(WhitespaceVerifier(a).threshold, ())` so the selector stays compiler-checked.
Deliberately not `try/catch`: a `try` statement does **not** catch a return-data *decoding*
failure, so a contract answering that selector with short data would take the whole run down
instead of being classified as "not hardened".

`test_installIsIdempotent` runs the full sequence twice and asserts no second deployment, no
re-registration, and no registry pointer movement — the same resumability requirement the eight
phase-1 steps carry, for the same reason.

### The constructor seeds the signer set

`registerAuthorizedSigner` is `onlyGov` and the deploying account is not gov, so a verifier
deployed through the gov path would exist with an empty signer set and accept nothing. The
constructor seeds it instead. **The trust decision is therefore not "who deployed this" but
"gov pointed the registry at it"** — gov must read `signerCount`, `threshold` and
`isAuthorizedSigner` off the deployed instance before adopting it. Under `runOracle()` the
deployer and gov are the same key, so this is a documentation point rather than a live gap.

### `runOracle()` is a separate entrypoint, not five more steps in `run()`

`run()` is documented in `docs/runbooks/deploy-testnet.md` with an exact env-var block that has
already been executed against 1874; adding four required variables to it would silently
invalidate that recorded procedure. The two operations also have genuinely different
preconditions — `run()` configures a market that does not exist yet, `runOracle()` replaces the
oracle under a market that is already trading.

```bash
cd $REPO/contracts
export REGISTRY_ADDRESS=$(dep registry) \
  ORACLE_SIGNERS=0xaaa…,0xbbb…,0xccc…,0xddd…,0xeee… \
  ORACLE_THRESHOLD=3 \
  GUARDIAN_ADDRESS=$(ad guardian) \
  KEEPER_ADDRESS=$(ad keeper) \
  GOV_PRIVATE_KEY=$(pk gov) OWNER_PRIVATE_KEY=$(pk owner)
# optional, default to the values above: ORACLE_MAX_AGE=10 ORACLE_MAX_DEVIATION_BPS=500

forge script script/Operate.s.sol:OperateScript --sig "runOracle()" --rpc-url $RPC --legacy
forge script script/Operate.s.sol:OperateScript --sig "runOracle()" --rpc-url $RPC --broadcast --legacy
```

`--legacy` is mandatory on every Whitechain network, for the reason the phase-1 runbook already
gives. The chain guard (`require(block.chainid == 1874)`) fires before anything else.

### The migration window fails closed — probed, not asserted

Migrating a live system means one gov transaction lands before the other, so for at least one
block the verifier and the upkeep disagree about the wire format (nine fields vs seven). "It
fails closed" is a claim about a **negative**, so it is probed:

- `test_hardenedVerifierWithVendoredUpkeepFailsClosed` — the vendored upkeep cannot decode a
  nine-field payload as seven.
- `test_vendoredVerifierWithHardenedUpkeepFailsClosed` — the vendored verifier cannot decode
  `abi.encode(bytes, bytes[])` as `abi.encode(bytes, r, s, v)`.
- `test_legacySingleSignatureReportIsUndeliverable` — once both are installed, the retired
  single-signature format is not a fallback path.

All three assert *the call failed AND no position exists*, not a pinned selector: the point is
not which decoder gave up, and pinning one would be pinning an accident of the verifier
address's high bits. In-flight orders simply time out and traders reclaim via
`openTradeMarketTimeout`.

Install order is verifier first, then upkeep. Either order is safe; this one keeps the
dependency ahead of its consumer.

---

## 6. Tests

### Design-spec invariant 5

> `verify()` never accepts a report with fewer than k signatures, **for any input**.

`contracts/test/invariant/VerifierThreshold.t.sol`. The handler builds reports from a signer set
whose **ground truth it knows**: it selects a subset of the five authorised keys by bitmask, so
`popcount(mask)` is the exact number of distinct authorised signers on the report, computed
**without asking the verifier**. The invariant then reads: *if `verify` returned, that number
was ≥ k*.

That framing is what keeps the test from being circular. A handler that recomputed the signer
set with its own `ecrecover` would be re-implementing `verify` and asserting it equals itself.

Four corollary invariants ride along: no accepted report ever carried an unauthorised signature,
a duplicated signer, a foreign domain, or arbitrary calldata. Three handler entrypoints are
fuzzed: `submit` (structured, with one corruption selector), `submitRaw` (arbitrary bytes), and
`submitCrossSigned` (signatures taken over a *different* payload than the one submitted).

**The coverage floor.** Rejections alone prove nothing — a `verify` that reverted
unconditionally satisfies every invariant above perfectly. `afterInvariant()` asserts the
campaign reached both acceptance and rejection. That hook's existence was itself verified rather
than assumed: a throwaway test whose `afterInvariant` reverted was run and did fail, confirming
forge 0.3.0 calls it. `test_handlerReachesAcceptance` / `test_handlerReachesRejection` pin the
same floor deterministically as a backstop.

Corruption is applied through a single `mode` selector rather than several independent booleans.
With independent booleans, P(clean report) falls off geometrically in the number of axes and the
campaign spends nearly every call on rejections — which would make the coverage floor flaky and,
worse, leave the accept path barely explored.

### Test hygiene

Every `vm.expectRevert` outside the three migration-window tests is pinned to the **exact error
payload**. A bare expectation cannot distinguish "the rail rejected this" from "the helper built
a malformed report and the decoder panicked", and both look identical from outside. The three
exceptions are deliberate and explained above.

### Commands and output

```
$ cd contracts && forge test
Ran 10 test suites in 2.74s (8.48s CPU time): 121 tests passed, 0 failed, 0 skipped (121 total tests)
```

Suite by suite (phase-2 suites in bold):

| Suite | Tests |
|---|---|
| `test/Probe.t.sol` | 1 |
| `test/ChainUtils.t.sol` | 4 |
| `test/USDW.t.sol` | 6 |
| `test/integration/DeployLocal.t.sol` | 7 |
| `test/integration/Operate.t.sol` | 8 (unchanged, still passing) |
| `test/integration/TradeLocal.t.sol` | 5 (unchanged, still passing) |
| **`test/oracle/WhitespaceVerifier.t.sol`** | **39** |
| **`test/invariant/VerifierThreshold.t.sol`** | **7** (5 invariants × 64 runs × 128 depth = 8,192 calls each) |
| **`test/integration/OracleHardening.t.sol`** | **41** (`OracleHardeningTest`) **+ 3** (`OracleMigrationWindowTest`) |

```
$ rm -rf contracts/out && cd contracts && forge build --sizes
BUILD_EXIT=0
| WhitespacePriceUpKeep    | 7,001            | 7,416             | 17,575             | 41,736              |
| WhitespaceVerifier       | 2,535            | 3,167             | 22,041             | 45,985              |
| OstiumTrading            | 24,414           | 24,608            | 162                | 24,544              |
```

`OstiumTrading`'s 162-byte EIP-170 margin is **unchanged** — phase 2 adds no code to it.

```
$ node tools/evm-compat/scan.mjs contracts/out
evm compat gate OK: 124 bytecode objects, no Cancun opcodes

$ cd contracts && forge config --json > /tmp/fc.json && node ../tools/evm-compat/toolchain.mjs /tmp/fc.json
toolchain gate OK: solc 0.8.24 / shanghai / no metadata
```

The Cancun gate passes for a structural reason as well as an empirical one: with
`evm_version = "shanghai"` solc cannot emit `TLOAD`/`TSTORE`/`MCOPY` at all. The scan is the
check that the setting is actually in force.

---

## 7. What was NOT verified

- **Nothing was deployed.** All 121 tests run on a local EVM. Neither contract has been sent to
  1874, and `runOracle()` has never been executed against a live chain — only far enough to
  confirm its chain guard fires (`revert: unsupported chain` on chainid 31337).
- **The publisher side is unverified.** `packages/publisher/` is being built independently. The
  wire format is pinned by `ReportLib` and two tests, but no report produced by the real
  publisher has ever been fed to `WhitespaceVerifier`. **This is the highest-value next check:
  one round trip of real publisher bytes through `verify()` before any gas is spent.**
- **No real multi-party signing.** All five "independent" signers are `vm.sign` on constants in
  one process. Key custody, HSMs, and whether the five keys are genuinely independent are
  operational questions this phase does not touch.
- **Gas cost of a 3-of-5 delivery on 1874 is unmeasured.** Measured locally with
  `forge test --match-test test_openAndClosePosition --gas-report`, over the identical
  open→close cycle (n = 2 calls each: one `MARKET_OPEN`, one `MARKET_CLOSE`):

  | `performUpkeep` | min | mean | max |
  |---|---|---|---|
  | `WhitespacePriceUpKeep` (3-of-5) | 590,878 | 710,662 | 830,446 |
  | `OstiumPrivatePriceUpKeep` (1 sig, behind a proxy) | 677,547 | 739,250 | 800,954 |

  So hardening did **not** measurably raise delivery cost — the callbacks dominate, and the two
  extra `ecrecover`s (6,000 gas) are roughly offset by dropping the proxy `DELEGATECALL`. But
  n = 2 on a local EVM, and Whitechain's gas *pricing* has never been measured at all, per the
  phase-1 runbook. Do not budget from this table.
- **Per-feed breaker isolation is proven at the contract level, not with two live markets.**
  `test_haltingAnotherFeedDoesNotStopThisOne` halts `"ETH/USD"` and shows `"BTC/USD"` still
  trades; only one market is listed on this deployment, so a second real pair routing through a
  second feed has not been exercised.
- **No `Slither` or `Echidna` run.** The design spec lists both as supporting layers; neither is
  wired into CI yet.
- **The recovery window for sequencer stalls (spec §6.5) is not implemented.** It is a
  liquidation-side control and belongs with the liquidator, not the upkeep.

---

## 8. Contradictions and deviations, stated

Two places where the design spec and the delivered code differ. Neither was resolved by
guessing; both follow the task's explicit instruction over the spec's earlier prose.

1. **Spec §6.3 says "Parameter changes via timelock only"; this implements gov only.** The
   phase-2 task specification states "Parameter changes | gov only" in its rail table. There is
   also no timelock deployed in this system: `onlyTimelock` in the vendored contracts resolves to
   the registry's `owner()`, an EOA, not a `TimelockController`. `OstiumTimelockManager` and
   `OstiumTimelockOwner` exist in the vendored tree but `Deploy.s.sol` deploys neither. So
   "timelock only" is not currently expressible. **Carried forward:** when a real timelock is
   introduced, the parameter setters on `WhitespacePriceUpKeep` should move from `onlyGov` to it,
   leaving `pause`/`haltFeed` on the guardian.

2. **Spec §6.2 says the payload includes `pairIndex`; the wire format carries `feedId`.** The
   task's format is explicit and marked "do not deviate", and `feedId` is what the vendored
   `Order` struct and `IOstiumPairsStorage.pairFeed` actually key on — `pairIndex` would need a
   storage read to compare. `feedId` is the correct choice; the spec's `pairIndex` appears to be
   drafting shorthand.

---

## 9. Known-deferred — do not re-discover these

### Operational consequences worth measuring in phase 3

- **`maxAge = 10 s` is tighter than `marketOrdersTimeout = 30` blocks.** Because the report
  timestamp must be byte-identical to `order.timestamp`, `maxAge` doubles as a ceiling on keeper
  delivery latency: deliver within 10 s of the request or the order can *never* be filled — but
  the trader cannot reclaim collateral until block 30. That is a ~20-block window where an order
  is dead but not yet refundable. Not a safety problem; a UX one. Either widen `maxAge` or
  shorten `marketOrdersTimeout` once real keeper latency is measured.

- **One signed report can fill two orders placed in the same block.** Orders share
  `block.timestamp`, so a report valid for one is valid for the other on the same feed. This is
  inherited from the vendored upkeep, not introduced here, and it is not exploitable: both
  traders committed before any report existed, so neither gets a stale-price advantage.

- **A weekend gap will wedge a feed.** `lastPrice` is not updated while `isMarketOpen == false`,
  so the first open-market report after a closed period is compared against the last price before
  it. For a 24/7 crypto feed this is unlikely; for anything with a session it is routine, and the
  runbook answer is `clearPriceBaseline(feedId)`.

### Cosmetic

- `OperateScript`'s deployed size is now 28,345 bytes, over EIP-170. Harmless — a script contract
  is never deployed on-chain, and foundry disables the limit for script/test execution (confirmed
  empirically: the local `forge script` run reports `Return 28345 bytes of code` and proceeds).
  It does mean `forge build --sizes` would flag it if scripts were ever included in that table;
  they are not.
- `test_installHardenedVerifierRejectsNonGov` costs 61M gas because it deploys a second full
  system to reach a state where the install has work to do. Slow but not flaky.

---

## 10. What "done" does not mean here

The threshold and the rails are implemented, governed, and tested against a real Ostium stack.
They have never seen a real signature from a real signer on a real chain. Phase 2 is a
**code-complete** gate, not an operational one: the honest next step is one publisher round trip
and one `runOracle()` dry run against 1874 before anything holds value.
