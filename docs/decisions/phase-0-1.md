# Phase 0-1 decisions — foundation and Ostium contract port

Status: **phase complete except deployment.** Everything below is decided and implemented on
`main`. The one open item is that nothing has been deployed to 1874 or 2625 — see
[`docs/runbooks/deploy-testnet.md`](../runbooks/deploy-testnet.md), which is blocked on a
human-gated faucet, not on code.

This file is the tracked record of *why* the phase looks the way it does. The working ledger it
was distilled from lives in a git-ignored scratch directory and will not survive; this will.
Each entry is a decision, the reason it was forced or chosen, and the consequence a successor
inherits. Where a claim was measured rather than assumed, the measurement is stated.

---

## 1. Build and toolchain

### `via_ir = true` — required, not preferred

`forge build` with `via_ir = false` **fails**: `CompilerError: Stack too deep` in vendored
`OstiumPairInfos.sol`. This is not an import or remapping problem and no configuration short of
the IR pipeline fixes it. Upstream builds this exact commit with Hardhat `viaIR: true`, so we
are matching upstream's own pipeline rather than inventing one.

**Why it is safe against our hard constraint.** `via_ir` changes codegen but not the *opcode
set*. `TLOAD`/`TSTORE`/`MCOPY` are emitted only when `evm_version >= cancun`, and ours is pinned
`shanghai`. That is an argument, so it is also independently checked: `tools/evm-compat/scan.mjs`
disassembles all 100 compiled bytecode objects and finds none of the three.

**Consequence:** builds are slow (~104 files). Batch work; do not rebuild per edit.

### The toolchain gate asserts every setting the safety argument depends on

`tools/evm-compat/toolchain.mjs` checks `solc_version`, `evm_version`, `bytecode_hash`,
`cbor_metadata` **and** `via_ir`. The rule: if a `foundry.toml` value is load-bearing for a
correctness or compatibility claim, it is asserted, so it cannot regress silently.

- `cbor_metadata: false` is checked *in addition to* `bytecode_hash = "none"`. The hash setting
  suppresses only the hash; with `cbor_metadata = true` solc still appends a CBOR trailer that
  the opcode scanner would disassemble as code. They are a pair.
- `via_ir: true` is checked because disabling it does not merely change output, it breaks the
  build — and because the "no Cancun opcodes" argument above is stated in terms of it.

### The two gates cover different failure classes — neither is redundant

Under a deliberately misconfigured `evm_version = cancun`, the **opcode scanner found nothing**;
only the toolchain gate caught it. Solc 0.8.24 with `via_ir` on Ostium's source patterns simply
never emits those opcodes, cancun or not.

That is not a reason to drop the scanner. The toolchain gate catches *config drift*; the scanner
catches *actual bytecode content* — a future contract, or a future solc lowering, that starts
emitting transient-storage opcodes while `evm_version` still reads `shanghai`. Keep both.

### Dependencies are git submodules

`contracts/lib` holds three real submodules (`forge-std`, `openzeppelin-contracts`,
`openzeppelin-contracts-upgradeable`, the two OZ ones pinned at `v5.0.2`). CI checks out with
`submodules: recursive` and never runs `forge install`.

A `lib/forge-std/` line was removed from `.gitignore` to make this work: `git submodule add` on
an ignored path fails outright with `fatal: Failed to add submodule`. Do not re-add it.

**Do not be fooled by `git describe` here.** `git submodule status` prints
`v5.0.0-12-gdbb6104c` for `openzeppelin-contracts`, which reads like the v5.0.2 pin is false. It
is not: `git rev-parse v5.0.2^{commit}` is `dbb6104c…` exactly. `describe` picked a different
reachable tag. Verify with `rev-parse`, not `describe`.

### EIP-170: `OstiumTrading` has 162 bytes of headroom

24,414 B runtime against the 24,576 B limit — 0.66%. `OstiumTradingCallbacks` is next at
1,725 B. Full table and the list of changes that consume the margin are in
[`contracts/VENDOR.md`](../../contracts/VENDOR.md#eip-170-headroom--read-this-before-touching-foundrytoml).

`forge build --sizes` exits non-zero on overflow; plain `forge build` and `forge test` do not.
CI runs `--sizes`, and `pnpm build:contracts` was changed to do the same so a local build gates
it too. **Raising `optimizer_runs` above 200 is the most likely way to break this.**

---

## 2. The vendored Ostium tree

`contracts/src/vendor/ostium/` is byte-identical to upstream `8390ce49…`, 46 `.sol` files plus
`LICENSE`, verified against three independent sources. `contracts/VENDOR.md` asserts that
identity — **never write into that tree.** Any future divergence must be recorded in VENDOR.md's
table with its rationale.

### `ChainUtils.sol` keeps its Arbitrum branch

`getBlockNumber()` gates on `block.chainid` and returns `block.number` for every non-Arbitrum
chain, so it is *already correct* on 1874, 2625 and 1875. Deleting the dead branch would buy
nothing and would forfeit clean upstream merges. `test/ChainUtils.t.sol` pins the behaviour.

Note the path aliasing: vendored files import `src/lib/ChainUtils.sol`, which resolves only via
`remappings.txt` (`src/lib/` → `src/vendor/ostium/lib/`). There is no `src/lib/` directory.

---

## 3. Deployment

### `RegistryBootstrap` exists because the deployer can never be `gov`

This is forced by upstream, not a style choice. `OstiumRegistry`'s constructor runs
`Ownable(msg.sender)`, making the deployer `owner()` during construction; `setGov` reverts
`HasAlreadyRole` whenever the incoming address equals `owner()`; and `registerContracts` is
`onlyGov`. There is therefore **no ordering of calls** in which the deploying EOA registers the
components directly. The script cannot hold gov itself either — `setGov(address(this))` trips
the same check.

The fix: a throwaway contract created by the deployer holds *both* `gov` and `owner` while the
registry is wired, then calls `registerContracts`, `setGov(realGov)`, `transferOwnership(
realOwner)` **in that order** (`setGov` is `onlyOwner`, so it must precede the handover), and
holds nothing afterward. **Do not "simplify" this away.**

Authority is anchored to `driver` — "whoever created me" — rather than `address(this)`, so the
flow is identical under `forge test` (caller is the script contract) and under `vm.broadcast`
(caller is the EOA). `address(this)` would be wrong in the second case.

Residual, accepted: the bootstrap stays deployed forever with a callable `exec`. Since `driver`
is the deployer itself, `exec` grants nothing the deployer did not already have. It cannot
custody funds (no `payable`, no `receive`, no value parameter).

### The migration chain must be replayed in ascending order, and the version is not proof

Upstream evolved a live system, so part of its state is set only by `reinitializer(n)` functions.
OZ v5 requires `_initialized < n`, so calling V4 first **permanently skips V2 and V3**.
`_replayMigrations` calls all eight in ascending order.

The trap: `reinitializer(n)` sets `_initialized = n` *unconditionally on success*. A vault given
only `initializeV4` also reports version 4. Asserting the version therefore proves nothing. The
discriminator is `OstiumVault.maxSettlementInterval()`, written by `initializeV3` and by nothing
else: `86400` on a correct replay, `0` on a truncated one. Both the test suite and the runbook's
Step 5 check that value, not just the version.

Honest scope limit: of the eight reinitializers, five write **nothing observable** through a
public getter on a greenfield chain (empty-array loops, or zero-to-zero assignments). The
migration guard is strong for the vault and weak-by-necessity elsewhere. Do not read the passing
test as proving more than that.

### A partial deployment must be redeployed, never resumed

All the vendored reinitializers are `external reinitializer(n)` with **no access modifier** —
permissionless. On a live chain each is a separate transaction, so an interrupted run leaves a
live but unmigrated proxy that any third party can advance.

The effect is griefing, not takeover: once any caller succeeds at a given `n`, our own later
attempt reverts rather than silently no-oping. But that is exactly why a half-migrated proxy
**cannot be repaired** — there is no way to run a skipped `initializeV{2,3}` after a higher
`initializeV4` has set `_initialized` past it. Abandon the addresses and redeploy.

### `priceUpKeep` is deployed but deliberately unregistered

The registry key for a price upkeep is not a constant. `OstiumPriceRouter` and
`OstiumTradingCallbacks` both resolve it as
`bytes32(abi.encodePacked(pairsStorage.oracle(pairIndex), 'PriceUpkeep'))` — `<pair.oracle>` +
`"PriceUpkeep"` — which is undeterminable until pairs exist. Phase 1 adds no pairs, so there is
nothing to register under, and registering it as the literal `"priceUpKeep"` (its *struct field
name*) would create an entry no consumer ever reads.

Phase 3 must register it under the real `<oracle>PriceUpkeep` key, one entry per distinct oracle
type. Until then `getContractAddress("priceUpKeep")` reverts `NotFound` — pinned as intentional
by `test_priceUpKeepIsNotRegisteredUnderItsStructName`.

### `run()` guards `block.chainid`; the config JSONs are inert

`contracts/script/config/{1874,2625}.json` are **read by nothing**. They were specified as inert
descriptive metadata and left that way deliberately: wiring them would add a `vm.readFile`
dependency and a second source of truth for values the script already holds as constants.

Treat them as documentation. In particular `"legacyTransactions": true` does **not** enforce
anything — that constraint is enforced by the `pnpm deploy:1874` / `pnpm deploy:2625` scripts,
which hard-code `--legacy`. Anything that must actually hold is enforced in Solidity or in a
`package.json` script, not in these files.

What *is* enforced in Solidity is the target chain: `run()` opens with
`require(block.chainid == 1874 || block.chainid == 2625, "unsupported chain: <id>")`. The two
testnet RPC URLs differ by one character (`rpc.testnet` vs `rpc-testnet`) and mainnet 1875
answers a near-identical URL, so a typo aborts before any broadcast.

### Legacy type-0 transactions, and why the failure mode is asymmetric

All 35 transactions of a full deployment were verified type `0x0` against a local anvil. On 2625
and mainnet 1875, omitting `--legacy` is *rejected*. On 1874 it is **silent** — that chain has
EIP-1559, so the deployment succeeds with type-2 transactions and looks perfect. That asymmetry
is why the flag lives in a script rather than in a runbook instruction.

### Library addresses differ between 1874 and 2625

`OstiumTrading` and `OstiumTradingCallbacks` link `TradingLib` and `TradingCallbacksLib`.
Foundry deploys linked libraries through the deterministic CREATE2 factory at
`0x4e59b448…` when that factory has code; it **has** code on 1874 and **none** on 2625, where
Foundry falls back to plain `CREATE`. Neither chain is blocked, but the two library addresses
will not match across chains even though every other contract is constructed identically. The
`deployments/*.json` shape has a `libraries` slot for exactly this.

### The `Deployment` struct is an interface contract

It is what `run()` returns and what the operator transcribes from the `== Return ==` block. It
was deliberately **not** extended with the bootstrap address, and should not be extended
casually — changing it changes the runbook and the recorded artifact shape.

---

## 4. Network facts established by direct probe

- **Pre-EIP-155 transactions are rejected on mainnet 1875.** Verbatim:
  `only replay-protected (EIP-155) transactions allowed over RPC`. The canonical CREATE2 factory
  at `0x4e59b448…` can therefore **never** be deployed on Whitechain mainnet, so deterministic
  cross-chain address derivation is permanently unavailable there. This confirms rather than
  breaks the standing constraint (no CREATE2-deployer dependency for address derivation) — but
  it is now proven, not assumed.
- 1874, 1875 and 2625 all match the capability expectations in `packages/shared/src/chains.mjs`.
  `tools/chain-probe/probe.mjs` re-checks this; CI runs it as a `continue-on-error` job, and the
  runbook's Step 1 tells the operator to run it before spending gas.
- No developer RPC methods on either testnet: `anvil_setBalance`, `hardhat_setBalance` and
  `eth_requestFunds` all answer `rpc method is not whitelisted`.
- The 1874 faucet is gated by Cloudflare Turnstile **and** GitHub OAuth — human-only by design.
  No gas source has been found for 2625 (searched one site's bundles; that is a "not found", not
  a proof of absence).

---

## 5. Known-deferred — do not re-discover these

Triaged and consciously carried. None blocks the phase.

### Must change before anything holds real value

| Item | Why it is acceptable now | What it becomes |
|---|---|---|
| **`USDW` has no supply cap** on `claim()` or `mint()`. A Sybil can mint unlimited collateral. | It is a testnet faucet token; unlimited free collateral is the point. | Blocks any economic simulation whose results are meant to be believed, and must not exist on a network where the collateral is worth anything. |
| **`DEPLOYER_PRIVATE_KEY` is read from the environment** (`vm.envUint`) rather than a keystore or `--account`. | Testnet keys, generated for this phase, held outside the repo at mode 600. | Move to a keystore before a deployment controls value. A key in an environment variable is readable by every child process and lands in shell history. |

### Cosmetic or low-impact

- `contracts/lib/forge-std` is pinned to a default-branch tip rather than an explicit tag, unlike
  the two OZ submodules at `v5.0.2`. `git submodule update --remote` could drift `Test.sol`.
- `RegistryBootstrap.exec` does not check that `target` has code, so a call to an EOA would
  return success. Only reachable by the deployer, who gains nothing by it.
- A constructor-only `RegistryWirer` would leave no callable function at all and close the
  partial-broadcast window. Rejected in favour of recoverability from exactly that window.
- `run()` writes no address artifact — addresses live only in stdout and the git-ignored
  `broadcast/`. Deliberately not adding `vm.writeJson`: forge already prints the struct with
  named fields, and the runbook now says to read them from there.
- The vault initializer parameters (`MAX_ACC_OPEN_PNL_DELTA`, discount thresholds, timeouts …)
  are placeholders that satisfy the vault's own bounds with headroom. Tune in phase 3.
- `foundry.toml`'s `[rpc_endpoints]` aliases are unused; the deploy scripts pass URLs directly.
- The pnpm workspace (`packages/shared`) is declared but only consumed by `probe.mjs`.
- `USDW`'s cooldown uses a `previous != 0` sentinel that would collide with
  `block.timestamp == 0`. Unreachable on any real chain.
- No test for odd-length hex input to `scanBytecode` (`Buffer.from` truncates the trailing
  nibble; probed, safe but unpinned); no test for `classifyProbe` keys present in `expects` but
  missing from `observed`.
- `Object.values(CHAINS)` iterates in ascending numeric key order (1874, 1875, 2625) rather than
  declaration order. All three are probed either way.
- The `.mjs` tools carry a `#!/usr/bin/env node` shebang but are mode 100644. Every call site
  invokes them as `node <file>`.
- CI pins `foundry-toolchain@v1` (a moving major tag) and declares no `permissions:` block.
- The `PRESIGNED` constant in `pre155.mjs` is one 282-char line. **Do not run `pre155.mjs`** —
  it submits a transaction to a live network.

---

## 6. What "done" does not mean here

The system **deploys**; it is **not operational**. There are no pairs, no authorised verifier
signer, and no `MMDeposit()`. A trade routed through `OstiumPriceRouter.getPrice` reverts inside
`getContractAddress` because no `<oracle>PriceUpkeep` is registered. That is the intended
phase-1 end state, not a defect.

Budget for a live deployment: **35 transactions, ~30.5M gas per network**, measured against a
local anvil at the shanghai hardfork. Whitechain's actual gas pricing has not been measured.
