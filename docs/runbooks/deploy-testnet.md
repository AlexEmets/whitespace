# Runbook: Deploy to the Whitechain testnets (1874, 2625)

## Status: NOT DEPLOYED

No contracts have been deployed to either network. `deployments/1874.json` and
`deployments/2625.json` do not exist and must not be created with placeholder
addresses — there is nothing to record yet.

**Blocker:** the deployer address `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` has a
balance of `0x0` on both chains, and every currently known way to fund it requires a
human in the loop. See [Funding blocker](#funding-blocker). Steps 1–5 below cannot run
until that is resolved.

This document is a procedure for the operator to execute once funding lands, not a
record of a completed deployment. Everything below Prerequisites is unexecuted.

---

## Prerequisites

- Foundry (`forge`, `cast`) matching `contracts/foundry.toml`: solc `0.8.24`, EVM
  version `shanghai`.
- `node` (used below to read addresses back out of `deployments/<chainid>.json`).
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

### Step 2: Deploy to chain 1874

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=$(jq -r '.[0].private_key' ~/.whitespace-keys/owner.json)
export GOV_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/gov.json)
export DEV_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/dev.json)
export MANAGER_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/manager.json)
export MARKET_MAKER_ADDRESS=$(jq -r '.[0].address' ~/.whitespace-keys/marketmaker.json)
forge script script/Deploy.s.sol:DeployScript \
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
forge script script/Deploy.s.sol:DeployScript \
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

Write `deployments/1874.json` and `deployments/2625.json` from each run's broadcast
output, using this shape:

```json
{
  "chainId": 1874,
  "deployedAt": "<ISO-8601 timestamp of the broadcast>",
  "commit": "<git rev-parse HEAD>",
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
  }
}
```

Only write these files after Step 5's checks pass — see
[Roll-forward guidance](#failure-handling-a-failed-or-partial-deployment).

---

## Verification

The point of this step is to confirm the deployed system **is** the one running —
not merely that transactions succeeded. Run every check below against both networks
(swap `RPC` and the `deployments/<chainid>.json` path for 2625).

```bash
REGISTRY=$(node -e "console.log(require('./deployments/1874.json').contracts.registry)")
VAULT=$(node -e "console.log(require('./deployments/1874.json').contracts.vault)")
RPC=https://rpc.testnet.whitechain.io
```

1. **The registry resolves `trading` to the address we recorded** — proves the
   registration transaction wired the real component, not a stale or wrong one.

   ```bash
   cast call $REGISTRY "getContractAddress(bytes32)(address)" \
     $(cast format-bytes32-string "trading") --rpc-url $RPC
   ```

   Expected: equals `.contracts.trading` in `deployments/1874.json`.

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

   Expected: equals `.contracts.collateral` in `deployments/1874.json`, **not**
   `.contracts.registry`.

Repeat all five checks against 2625 before treating that network's deployment as
verified.

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
   not reuse them and do not write them into `deployments/<chainid>.json`.
3. Re-run the full `forge script ... --broadcast --legacy` command for the affected
   network (Step 2 or Step 3). It deploys fresh proxies and implementations, so
   there is nothing to clean up on-chain first — the old, abandoned proxies simply
   go unreferenced.
4. Only write `deployments/<chainid>.json` after the run reports
   `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` **and** all five checks in
   [Verification](#verification) pass against the new addresses.
5. If only one network fails (e.g. 2625 fails where 1874 succeeded), do not touch
   the working network's deployment or its `deployments/<chainid>.json`; diagnose
   the failing network in isolation.
