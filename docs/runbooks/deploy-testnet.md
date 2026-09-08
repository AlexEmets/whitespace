# Runbook: Deploy to the Whitechain testnets (1874, 2625)

## Status: NOT DEPLOYED

No contracts have been deployed to either network. `deployments/1874.json` and
`deployments/2625.json` do not exist and must not be created with placeholder
addresses — there is nothing to record yet.

**Path convention:** every `deployments/…` path in this document is relative to the
**repository root**, i.e. `<repo>/deployments/1874.json`, *not* `contracts/deployments/`.
The procedure below `cd`s into `contracts/`, so it defines `$REPO` and always writes and
reads `$REPO/deployments/…` explicitly. Do not drop the `$REPO`.

**Blocker:** the deployer address `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` has a
balance of `0x0` on both chains, and every currently known way to fund it requires a
human in the loop. See [Funding blocker](#funding-blocker). Steps 2–5 below cannot run
until that is resolved. [Step 1](#step-1-pre-flight) can and should be run now — its
balance check is precisely what reports this blocker.

This document is a procedure for the operator to execute once funding lands, not a
record of a completed deployment. Everything below Prerequisites is unexecuted.

For *why* the deployment is shaped this way — the `RegistryBootstrap`, the migration
replay, the unregistered `priceUpKeep`, the inert config JSONs, and the issues knowingly
carried forward — see [`docs/decisions/phase-0-1.md`](../decisions/phase-0-1.md).

---

## Prerequisites

- Foundry (`forge`, `cast`) matching `contracts/foundry.toml`: solc `0.8.24`, EVM
  version `shanghai`.
- `node` (used below to read addresses back out of `$REPO/deployments/<chainid>.json`)
  and `pnpm` (the deploy commands below are `package.json` scripts, so that `--legacy`
  is never something you have to remember to type).
- `jq` (used below to read the generated key files without ever printing a private
  key to the terminal).
- Five distinct role keypairs, already generated, living **outside the repository**
  at `~/.whitespace-keys/{owner,gov,dev,manager,marketmaker}.json`. Each file is mode
  `600` inside a mode-`700` directory and contains a one-element JSON array with
  `address` and `private_key` fields for that role. All five addresses are distinct,
  as `OstiumRegistry` requires (see [Role wiring](#role-wiring-and-the-registrybootstrap)).
  - `owner` (the deployer) — public address `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113`.
  - `gov`, `dev`, `manager`, `marketmaker` — addresses not yet disclosed in any
    repository file; read them from their key files when needed.
- **Never** paste a `private_key` value into a repository file, a commit, or this
  runbook. Only pull it into an environment variable via command substitution
  (`$(...)`), as shown below, never as a literal string typed on the command line.
- Only the `owner`/deployer address needs gas to run the deployment. `gov`, `dev`,
  `manager` and `marketmaker` never sign a transaction — they only receive roles.

---

## Funding blocker

Measured directly against the live services, not assumed:

- The Whitechain testnet faucet, `https://faucet.testnet.whitechain.io`, responds
  HTTP 200 but is gated by **Cloudflare Turnstile** (a CAPTCHA) and **GitHub OAuth**
  (`api/auth/github`). Both require a human to complete.
- Searching 1.6 MB of the faucet's JavaScript bundles found chain id `1874`
  referenced twice and **`2625` not referenced at all**. The faucet appears to serve
  only the OP Stack testnet (1874). This is a "not found in one site's bundle", not
  proof that no gas source for 2625 exists — a wider search may turn one up.
- Developer/test RPC methods are not available as a workaround on either network:
  `anvil_setBalance`, `hardhat_setBalance` and `eth_requestFunds` all return
  `rpc method is not whitelisted`.

**To unblock:** a human must complete the Turnstile challenge and GitHub OAuth flow
at the faucet URL above to fund `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` on 1874,
and separately identify and use a gas source for 2625 (not yet found). Once funded,
verify with:

```bash
export DEPLOYER=0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113
cast balance $DEPLOYER --rpc-url https://rpc.testnet.whitechain.io
cast balance $DEPLOYER --rpc-url https://rpc-testnet.whitechain.io
```

Expected once funded: both non-zero.

---

## Networks

| Chain ID | Name | RPC | `--legacy` |
|---|---|---|---|
| 1874 | `whitechain-testnet-op` | `https://rpc.testnet.whitechain.io` | required |
| 2625 | `whitechain-testnet-legacy` | `https://rpc-testnet.whitechain.io` | required |

`--legacy` is mandatory on **both** networks, not just 2625. All 35 transactions a
full deployment sends were verified type `0x0` (legacy) against a local anvil; 2625
has no EIP-1559 support at all, so a single command that always passes `--legacy`
is what keeps the same invocation working unmodified on both chains.

**Why this is dangerous to leave to memory.** On 1874 the failure is *silent*: that chain
does support EIP-1559, so omitting `--legacy` succeeds and quietly broadcasts type-2
transactions. Nothing fails, nothing warns, and the deployment looks perfect — while the
exact same command on 2625 and on mainnet 1875 would be rejected. You would only discover
the drift on the network where it costs the most.

That is why the deploy commands below are `package.json` scripts (`pnpm deploy:1874`,
`pnpm deploy:2625`) with `--legacy` and the RPC URL hard-coded. **Run the scripted form.**
The raw `forge script` line is documented alongside each one for reference and debugging
only — if you type it by hand, you own the `--legacy` flag.

**Chain guard.** `DeployScript.run()` opens with
`require(block.chainid == 1874 || block.chainid == 2625, ...)`. A typo'd or wrong RPC
therefore aborts before any broadcast with `unsupported chain: <id>` — including against
mainnet 1875, whose URL differs from 1874's by eight characters. If you see that message,
the guard is doing its job; fix the RPC, do not work around it.

---

## Role wiring and the `RegistryBootstrap`

`OstiumRegistry` rejects any collision between `gov`, `dev`, `manager` and `owner` —
all four must be pairwise distinct, and `gov`/`dev`/`manager` must each differ from
the deploying account too.

The deployer **cannot itself be `gov`**, even temporarily: the registry constructor
runs `Ownable(msg.sender)`, making the deployer `owner()` at construction time, and
`setGov` reverts `HasAlreadyRole` whenever the incoming address equals `owner()`. So
there is no ordering of calls in which the deploying EOA registers the system's
components directly.

`Deploy.s.sol` resolves this with a small helper contract, `RegistryBootstrap`,
created fresh by the deployer at the start of each run. The registry is constructed
with the bootstrap holding **both** `gov` and `owner`; the bootstrap then drives
`registerContracts`, `setGov(realGov)` and `transferOwnership(realOwner)`, in that
order, and holds no privilege afterward. **Do not "simplify" this away** — it is not
optional plumbing, it is the only way the deployer can ever hand `gov` to a different
address. Its presence adds one extra contract and three extra transactions beyond the
core 12 deployed contracts.

---

## Procedure

### Step 1: Pre-flight

Run from the repository root, before spending any gas.

```bash
export REPO=$(git rev-parse --show-toplevel)
cd "$REPO"

# 1a. Network capabilities still match the spec. Three seconds; Whitechain has drifted
#     before, and this is far cheaper than discovering it 30.5M gas into a deployment.
node tools/chain-probe/probe.mjs

# 1b. The deployer is funded on BOTH networks (see Funding blocker above).
export DEPLOYER=0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113
cast balance $DEPLOYER --rpc-url https://rpc.testnet.whitechain.io
cast balance $DEPLOYER --rpc-url https://rpc-testnet.whitechain.io

# 1c. The tree builds and its gates pass at the commit you are about to deploy.
git status --short          # must be clean: deployed artifacts need committed source
pnpm build:contracts        # `forge build --sizes`; fails on an EIP-170 overflow
pnpm gate:toolchain
pnpm gate:evm
pnpm test:contracts
```

Expected: probe prints `OK` for all three chains and exits 0; both balances non-zero;
both gates print `OK`; the suite passes. Do not continue past a failure here.

Record `git rev-parse HEAD` now — it is the `commit` field in Step 4.

### Step 2: Deploy to chain 1874

```bash
cd "$REPO"
export DEPLOYER_PRIVATE_KEY=$(jq -r '.[0].private_key' ~/.whitespace-keys/owner.json)
export GOV_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/gov.json)
export DEV_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/dev.json)
export MANAGER_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/manager.json)
export MARKET_MAKER_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/marketmaker.json)
pnpm deploy:1874
```

`pnpm deploy:1874` is defined in the root `package.json` and expands to exactly this —
documented for reference and debugging, but **run the `pnpm` form**, which cannot be
invoked with `--legacy` missing:

```bash
cd contracts && forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc.testnet.whitechain.io \
  --broadcast --legacy -vvv
```

Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

Budget for **35 transactions and roughly 30.5M gas** (measured on a local anvil at
the shanghai hardfork; Whitechain's actual gas pricing has not been measured — fund
the deployer with headroom, not exactly this amount).

Note on library linking: `OstiumTrading` and `OstiumTradingCallbacks` link external
libraries. Foundry deploys linked libraries through the deterministic CREATE2 factory
at `0x4e59b44847b379578588920ca78fbf26c0b4956c` when that factory has code on the
target chain. It **does** have code on 1874, so you will see two transactions to
`0x4e59b4...` in this run — that is expected, not an anomaly.

### Step 3: Deploy to chain 2625

```bash
cd "$REPO"
pnpm deploy:2625
```

Raw equivalent, for reference only — note the RPC host differs from 1874's by a single
character, `rpc-testnet` versus `rpc.testnet`:

```bash
cd contracts && forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc-testnet.whitechain.io \
  --broadcast --legacy -vvv
```

The environment variables exported in Step 2 carry over — run this in the same
shell session. Expected: the same `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` line.

The CREATE2 factory at `0x4e59b44847b379578588920ca78fbf26c0b4956c` has **no code on
2625**. Foundry falls back to plain `CREATE` for the two library deployments in that
case, so this network is not blocked — but it means the **library addresses on 2625
will differ from the library addresses on 1874**, even though every other contract
in the deployment is deployed with identical constructor/initializer arguments.

A failure here that does not occur on 1874 is the portability gate doing its job —
diagnose before proceeding; do not retry blindly. See
[Failure handling](#failure-handling-a-failed-or-partial-deployment) either way.

### Step 4: Record the addresses

**Take the twelve addresses from the `== Return ==` block** that `forge script` prints at
the end of a successful run — not from the broadcast log. `run()` returns the `Deployment`
struct, so forge decodes and prints it with its **field names** (`registry`, `collateral`,
`tradingStorage`, …), which maps one-to-one onto the `contracts` object below. The broadcast
log is an ordered list of raw transactions with no such labelling; reading addresses out of
it means matching them by position, which is exactly how a mis-transcription happens.

The two **linked library** addresses are *not* in that struct. Read them from the run's
broadcast log:

```bash
jq -r '.transactions[] | select(.contractName=="TradingLib" or .contractName=="TradingCallbacksLib")
       | "\(.contractName) \(.contractAddress)"' \
  "$REPO/contracts/broadcast/Deploy.s.sol/1874/run-latest.json"
```

They matter: `OstiumTrading` and `OstiumTradingCallbacks` cannot be verified on a block
explorer without them, and — as Step 3 explains — **they differ between 1874 and 2625**,
because the CREATE2 factory has code on 1874 and none on 2625. Every other address in the
deployment comes from an identical construction on both chains; these two do not.

Write `$REPO/deployments/1874.json` and `$REPO/deployments/2625.json` (repository root, not
`contracts/deployments/`) using this shape:

```json
{
  "chainId": 1874,
  "deployedAt": "<ISO-8601 timestamp of the broadcast>",
  "commit": "<git rev-parse HEAD, recorded in Step 1>",
  "contracts": {
    "registry": "0x...",
    "collateral": "0x...",
    "tradingStorage": "0x...",
    "pairsStorage": "0x...",
    "pairInfos": "0x...",
    "trading": "0x...",
    "callbacks": "0x...",
    "vault": "0x...",
    "openPnl": "0x...",
    "priceRouter": "0x...",
    "verifier": "0x...",
    "priceUpKeep": "0x..."
  },
  "libraries": {
    "TradingLib": "0x...",
    "TradingCallbacksLib": "0x..."
  }
}
```

> **`priceUpKeep` is a local label, NOT a registry key.** Nine of these twelve are registered
> in `OstiumRegistry`; eight are registered under exactly the key shown, and `verifier` is
> registered as `ostiumVerifier` instead. `registry` and `collateral` are also not registered.
> `priceUpKeep` is **deliberately unregistered** — see
> [The unregistered priceUpKeep](#the-unregistered-priceupkeep) before wiring phase 3.

Only write these files after [Step 5](#step-5-verify-the-deployment) passes — see
[Roll-forward guidance](#failure-handling-a-failed-or-partial-deployment).

### Step 5: Verify the deployment

The point of this step is to confirm the deployed system **is** the one running —
not merely that transactions succeeded. Run every check below against both networks
(swap `RPC` and the `$REPO/deployments/<chainid>.json` path for 2625).

```bash
# $REPO/deployments/... — repository root, NOT contracts/deployments/.
REGISTRY=$(node -e "console.log(require('$REPO/deployments/1874.json').contracts.registry)")
VAULT=$(node -e "console.log(require('$REPO/deployments/1874.json').contracts.vault)")
RPC=https://rpc.testnet.whitechain.io
```

1. **The registry resolves `trading` to the address we recorded** — proves the
   registration transaction wired the real component, not a stale or wrong one.

   ```bash
   cast call $REGISTRY "getContractAddress(bytes32)(address)" \
     $(cast format-bytes32-string "trading") --rpc-url $RPC
   ```

   Expected: equals `.contracts.trading` in `$REPO/deployments/1874.json`.

2. **`gov()` is the real gov address, not the deployer** — this is the check that
   proves the `RegistryBootstrap` handover actually completed and the bootstrap left
   no privilege behind.

   ```bash
   cast call $REGISTRY "gov()(address)" --rpc-url $RPC
   ```

   Expected: equals `$GOV_ADDRESS`, **not** the deployer address.

3. **The vault's migration version reports 4** — a first signal that the migration
   chain ran, though see check 4 for why this alone does not prove it.

   ```bash
   cast storage $VAULT \
     0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00 --rpc-url $RPC
   ```

   Expected: decodes to `4`.

4. **`maxSettlementInterval()` is `86400`** — `reinitializer(n)` sets
   `_initialized = n` unconditionally on success, regardless of which reinitializer
   functions ran before it. A vault that was only ever given `initializeV4` (V2 and
   V3 silently skipped) also reports `_initialized == 4`, but its
   `maxSettlementInterval` — set only by `initializeV3` — stays `0`. This check
   distinguishes a correctly replayed chain from a truncated one that check 3 cannot
   tell apart.

   ```bash
   cast call $VAULT "maxSettlementInterval()(uint32)" --rpc-url $RPC
   ```

   Expected: `86400` (24 hours). `0` means V2/V3 were skipped — treat as a failed
   deployment; see Failure handling.

5. **`asset()` returns the collateral token, not the registry** — proves the
   vault's `(_asset, _registry)` initializer argument order was not swapped.

   ```bash
   cast call $VAULT "asset()(address)" --rpc-url $RPC
   ```

   Expected: equals `.contracts.collateral` in `$REPO/deployments/1874.json`, **not**
   `.contracts.registry`.

Repeat all five checks against 2625 before treating that network's deployment as
verified.

---

## The unregistered `priceUpKeep`

`Deploy.s.sol` deploys an `OstiumPrivatePriceUpKeep` proxy and returns it as
`Deployment.priceUpKeep`, but **does not register it in the registry**. That is correct, and
it is not an oversight.

The registry key for a price upkeep is not a constant. Both consumers resolve it per pair:

```solidity
// OstiumPriceRouter.sol:81-84 and OstiumTradingCallbacks.sol:83-85, identical:
string memory priceUpkeepType =
    IOstiumPairsStorage(registry.getContractAddress('pairsStorage')).oracle(pairIndex);
registry.getContractAddress(bytes32(abi.encodePacked(priceUpkeepType, 'PriceUpkeep')))
```

So the key is `<pair.oracle> + "PriceUpkeep"` — for example a pair whose `oracle` string is
`"crypto"` resolves to the key `"cryptoPriceUpkeep"` — and it is **undeterminable until pairs
exist**. Phase 1 adds no pairs, so there is no key to register under yet, and registering
under the struct's field name `"priceUpKeep"` would create an entry that nothing ever reads.

Consequences for whoever wires phase 3:

- The literal key `"priceUpKeep"` is **not** in the registry.
  `getContractAddress("priceUpKeep")` reverts `NotFound(bytes32)`. This is pinned as
  intentional by `test_priceUpKeepIsNotRegisteredUnderItsStructName` in
  `contracts/test/integration/DeployLocal.t.sol`.
- When you add the first pair, register the deployed upkeep under
  `bytes32(abi.encodePacked(<that pair's oracle string>, 'PriceUpkeep'))`. One registration
  per distinct oracle type, not per pair.
- Until then the failure mode is loud, not silent: any trade routed through
  `OstiumPriceRouter.getPrice` reverts inside `getContractAddress`. The system deploys but is
  not operational — which is the intended phase-1 end state.

---

## Failure handling: a failed or partial deployment

**Redeploy from scratch. Do not resume a partially-migrated deployment.**

Every one of the migration-chain calls in `Deploy.s.sol`'s `_replayMigrations` —
8 in total (`pairsStorage.initializeV2`, `openPnl.initializeV2`,
`pairInfos.initializeV2/V3/V4`, `vault.initializeV2/V3/V4`) — is declared
`external reinitializer(n)` with **no access modifier**. They are permissionless.
On a live chain each is its own transaction, so if a run is interrupted (RPC
failure, insufficient gas, manual abort) between proxy deployment and the final
`vault.initializeV4`, a live but unmigrated proxy sits on-chain, and any third party
watching the chain could call the next reinitializer first.

The practical effect is griefing, not a silent takeover: `reinitializer(n)`
requires `_initialized < n`, so once any caller — us or a front-runner — succeeds at
a given `n`, our own later attempt at that same call reverts instead of silently
no-oping. But that is exactly why a half-migrated proxy **cannot be repaired**:
there is no way to re-run a skipped `initializeV{2,3}` once a higher-numbered
`initializeV4` has already set `_initialized` past it, on either side.

Roll-forward guidance:

1. Do not hand-call remaining `initializeVN` functions against addresses from a
   failed run to "finish" it. There is no repair path once `_initialized` has
   advanced past a skipped version.
2. Treat every contract address from a failed or interrupted run as abandoned. Do
   not reuse them and do not write them into `$REPO/deployments/<chainid>.json`.
3. Re-run the whole deploy command for the affected network — `pnpm deploy:1874`
   ([Step 2](#step-2-deploy-to-chain-1874)) or `pnpm deploy:2625`
   ([Step 3](#step-3-deploy-to-chain-2625)). It deploys fresh proxies and
   implementations, so there is nothing to clean up on-chain first — the old, abandoned
   proxies simply go unreferenced.
4. Only write `$REPO/deployments/<chainid>.json` after the run reports
   `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` **and** all five checks in
   [Step 5](#step-5-verify-the-deployment) pass against the new addresses.
5. If only one network fails (e.g. 2625 fails where 1874 succeeded), do not touch
   the working network's deployment or its `$REPO/deployments/<chainid>.json`; diagnose
   the failing network in isolation.
