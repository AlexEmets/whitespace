# contracts

The Whitespace on-chain system: a Foundry project holding a vendored Ostium V2 fork (the
vault-backed perpetual engine) plus Whitespace's own hardened oracle, the testnet collateral
token and the deploy/configure scripts for Whitechain testnet **1874**.

```bash
cd contracts
forge build --sizes      # build, failing on any EIP-170 overflow
forge test               # unit, integration, adversarial, fuzz
```

Submodules (`lib/forge-std`, `lib/openzeppelin-contracts`, `lib/openzeppelin-contracts-upgradeable`)
come with `git clone --recursive` or `git submodule update --init --recursive`.

## Layout

```
src/
  vendor/ostium/    Ostium V2 fork (MIT), rebranded Ostium* -> Whitespace*; see VENDOR.md
    abstract/ interfaces/ lib/   imported as src/abstract, src/interfaces, src/lib (remappings.txt)
  oracle/
    WhitespaceVerifier.sol      k-of-N signed price report verification
    WhitespacePriceUpKeep.sol   price delivery with staleness/deviation/halt/pause rails
  mocks/USDW.sol    testnet collateral: 6-decimal ERC-20, faucet `claim()` once per 24 h
  nft/Hunter.sol    bug-bounty badge collection: owner-minted ERC-721, capped, on-chain SVG art
  Probe.sol         toolchain smoke-test contract
script/             deploy and configure scripts, config/<chainId>.json
test/               unit/ integration/ adversarial/ invariant/ oracle/ helpers/
```

Every local change to the vendored code, the licence note and the rebrand rules are recorded in
[`VENDOR.md`](VENDOR.md). Read it before editing anything under `src/vendor/ostium/`. There is no
`src/lib/` directory on disk: the vendored sources import `src/lib/...`, `src/interfaces/...` and
`src/abstract/...`, which [`remappings.txt`](remappings.txt) maps into `src/vendor/ostium/`.

## Contract map

Every component finds the others through `WhitespaceRegistry` (`getContractAddress(name)`).

| Registry key | Contract | Role in the system |
|---|---|---|
| — | `WhitespaceRegistry` | Name → address directory; holds the `gov`, `dev`, `manager` and `owner` roles |
| `trading` | `WhitespaceTrading` | Every trader entry point: `openTrade`, `closeTradeMarket`, TP/SL and margin edits, limit-order cancel, timeout reclaims, and `executeAutomationOrder` (trades upkeep only). Inherits `Delegatable` (`setDelegate`, `removeDelegate`, `delegatedAction`) |
| `tradingStorage` | `WhitespaceTradingStorage` | Holds trader collateral, open trades, pending market orders and resting limit orders, open interest, accrued dev fees |
| `callbacks` | `WhitespaceTradingCallbacks` | Executes or cancels an order once its price arrives: opens, closes, automation triggers, collateral removal |
| `pairsStorage` | `WhitespacePairsStorage` | Markets: groups, fee tiers, pairs, feed and oracle name, leverage caps |
| `pairInfos` | `WhitespacePairInfos` | Economics: opening fees, funding, rollover, dynamic spread and price impact, liquidation thresholds |
| `openPnl` | `WhitespaceOpenPnl` | Tracks aggregate trader open PnL for the vault |
| `vault` | `WhitespaceVault` | ERC-4626 LP vault, the counterparty to every trade; async `requestDeposit`/`requestWithdraw` claimed after `tryNewSettlement` |
| `priceRouter` | `WhitespacePriceRouter` | Routes a price request to the upkeep registered under `"<pair.oracle>PriceUpkeep"` |
| `ostiumVerifier` | `WhitespaceVerifier` (`src/oracle`) | Checks a report carries k distinct authorised signatures, bound to `block.chainid` and the verifier's own address |
| `<oracle>PriceUpkeep`, e.g. `BTC/USDPriceUpkeep` | `WhitespacePriceUpKeep` (`src/oracle`) | One instance for every feed. Emits `PriceRequestedV2`; `performUpkeep(report, orderId)` from an allowlisted forwarder (the keeper) verifies, applies the rails and calls back |
| `tradesUpKeep` | `WhitespaceTradesUpKeep` | `performUpkeep` from allowlisted forwarders (the automation bots) calls `executeAutomationOrder` for liquidations, TP/SL and limit/stop entries |

The vendored `WhitespaceEngineVerifier` and `WhitespacePrivatePriceUpKeep` are what
`Deploy.s.sol` installs first; the configuration step replaces them with the two `src/oracle`
contracts under the same registry keys. `WhitespaceGovGuard`, `WhitespaceTimelockManager`,
`WhitespaceTimelockOwner` and `WhitespaceLockedDepositNft` are vendored but not deployed by any
script here.

### How a trade flows

```
trader ── openTrade ──► Trading ── collateral ──► TradingStorage (pending market order)
                           │
                           └── getPrice ──► PriceRouter ──► PriceUpKeep: record order, emit PriceRequestedV2
                                                                │
keeper ── performUpkeep(report, orderId) ───────────────────────┘
             │  Verifier.verify: k-of-N, chainId + verifier bound, signers strictly ascending
             │  rails: report timestamp == order timestamp, maxAge, deviation, feed halt, pause
             ▼
          Callbacks.openTradeMarketCallback ── fill (TradingStorage, PairInfos, OpenPnl, Vault)
                                            └─ or cancel with a reason (slippage, exposure limits, price impact, market closed, ...)
```

- The report timestamp must equal the timestamp recorded at request time, so the price is
  always signed **after** the trader committed.
- An order nobody fills can be reclaimed with `openTradeMarketTimeout` /
  `closeTradeMarketTimeout` once `marketOrdersTimeout` blocks have passed (11 on the testnet).
- Closes, limit/stop entries, TP/SL and liquidations go through the same request → report →
  callback path. Automation triggers enter via `TradesUpKeep.performUpkeep` →
  `Trading.executeAutomationOrder`, which requests a `LIMIT_OPEN` or `LIMIT_CLOSE` price.

## Roles

Verified against the modifiers in `src/`:

| Role | Where it lives | What it can do |
|---|---|---|
| **owner** (the vendored code calls it "timelock") | `WhitespaceRegistry.owner()` | `setGov`/`setDev`/`setManager`; allowlist forwarders on both upkeeps (`registerForwarder`, `onlyTimelock`); `Vault.setMarketMaker`. The deployer EOA on the testnet, also the `USDW` owner |
| **gov** | `registry.gov()` | Register/update registry contracts, list markets and fee tiers, most economic parameters, oracle signers and threshold, rail parameters, unpause/resume feeds, unregister forwarders, `claimFees` |
| **manager** | `registry.manager()` | Operational knobs: `Trading.pause`, max open interest, dynamic spread and some `PairInfos`/`PairsStorage` settings |
| **dev** | `registry.dev()` | Receives dev fees claimed from `TradingStorage` |
| **guardian** | `WhitespacePriceUpKeep.guardian` | `pause()` and `haltFeed()` immediately. Cannot unpause, resume or change anything; that is gov only |

`gov`, `dev`, `manager` and `owner` must be four distinct addresses; the registry reverts
`HasAlreadyRole` otherwise. `Deploy.s.sol` uses a throwaway `RegistryBootstrap` contract to hold
gov and owner while it wires the registry, then hands both roles to their final holders.

## Scripts

All in [`script/`](script/). Whitechain needs `--legacy`.

| Script | Entry point | What it does |
|---|---|---|
| `DeployTestnet.s.sol` | `deployTestnet()` | **The current deploy.** The whole testnet system from nothing in one run: the core (via `SystemDeployer`), the hardened verifier and upkeep, oracle rails, `TradesUpKeep` with the keeper and bot forwarders, the four markets in `testnetMarkets()` (BTC, ETH, SOL, WBT against USD) with their economics, an 11-block market-order timeout, a 1 h vault settlement interval and a seeded LP deposit. Runs on 1874 or a 31337 anvil rehearsal |
| | `configureTestnet()` | Configures an already-deployed core at `REGISTRY_ADDRESS`. Every step checks whether its work is done and returns early, so a run that died half-way is resumed with this |
| `Deploy.s.sol` | `DeployScript.run()` | The original deploy: core contracts and registry wiring only, no markets, 30-block timeout. Accepts chain 1874 or 2625 (`pnpm deploy:1874` / `pnpm deploy:2625` at the repo root) |
| `Operate.s.sol` | `run()` | Idempotent configuration of a deployed core: lists BTC/USD, authorises the signer and keeper, registers the upkeep, seeds the vault |
| | `runOracle()` | Installs the hardened verifier and price upkeep, authorises signers, sets the rails and forwarder (`ORACLE_SIGNERS`, `ORACLE_THRESHOLD`, `ORACLE_FEEDS`, ...) |
| | `runLiquidation()` | Installs `TradesUpKeep` and allowlists `LIQUIDATOR_ADDRESS` |
| | `runAddMarkets()` | Lists the markets in `MARKETS` (no default) on a live system |
| `DeployHunter.s.sol` | `run()` | Deploys `Hunter` and mints the first badges (`HUNTER_MINT_TO`, `HUNTER_INITIAL_MINT`) |

Each entry point documents its required environment in its NatSpec. Keys are passed as env vars
(`DEPLOYER_PRIVATE_KEY`, `GOV_PRIVATE_KEY`, `MANAGER_PRIVATE_KEY`, `LP_PRIVATE_KEY`, ...); the
runbooks read them from `~/.whitespace-keys/`, never from the repo.

After any deploy, regenerate the address manifest from the chain:

```bash
REGISTRY_ADDRESS=0x... START_BLOCK=... RPC_URL=https://rpc.testnet.whitechain.io \
  node tools/deploy/manifest.mjs > deployments/1874.json
```

`deployments/1874.json` is the only address source for the web app, indexer and services, so a
deploy without this step leaves them pointing at the old system.

## Toolchain

`solc 0.8.24`, `evm_version = "shanghai"`, `via_ir = true`, optimizer at 200 runs,
`bytecode_hash = "none"`, `cbor_metadata = false` ([`foundry.toml`](foundry.toml)). Shanghai
keeps the bytecode free of Cancun opcodes so it can move to Whitechain mainnet 1875 unchanged.
`pnpm gate:toolchain` and `pnpm gate:evm` at the repo root check both in CI.

`WhitespaceTrading` sits very close to the EIP-170 runtime size limit. Before changing any
compiler setting or adding code to it, read
[VENDOR.md § EIP-170 headroom](VENDOR.md#eip-170-headroom--read-this-before-touching-foundrytoml).
Plain `forge build` and `forge test` do **not** fail on an oversize contract; `forge build --sizes`
(and `pnpm build:contracts`) do.

## Tests

| Directory | Covers |
|---|---|
| `test/unit/` | Trading, vault, `TradesUpKeep`, `PairInfos` economics (fuzz), the EIP-712 domain, regression tests for defects found in `src` (`Findings.t.sol`) |
| `test/oracle/` | `WhitespaceVerifier` |
| `test/integration/` | Deploy scripts end to end (`DeployLocal`, `DeployTestnet`, `Operate`), full trades, close bond, automation trigger rules, oracle hardening, the publisher-to-verifier wire format |
| `test/adversarial/` | Keeper censorship and order timeouts, liquidation races |
| `test/invariant/` | Protocol invariants (USDW conservation, storage backs every collateral, OI never above its cap, below-maintenance is liquidatable, vault accounting) and verifier threshold invariants |
| `test/helpers/` | Shared fixtures and report signing (`ReportLib`) |

```bash
forge test                                            # everything, default (fast) depth
forge test --match-path 'test/unit/*'                 # one directory
forge test --match-contract DeployTestnetTest         # one suite
FOUNDRY_PROFILE=invariant forge test --mt invariant   # invariants at nightly depth
FOUNDRY_PROFILE=invariant forge test --match-path 'test/{invariant,unit}/*'   # invariants + economics fuzz
forge coverage --ir-minimum --report summary          # what CI reports
```

The `invariant` profile raises invariant runs to 256 × depth 200 and fuzz runs to 1024. From the
repo root, `pnpm test:contracts` runs `forge test`.

## Runbooks

- [`docs/runbooks/redeploy-testnet-1874.md`](../docs/runbooks/redeploy-testnet-1874.md):
  redeploy 1874 from scratch with `DeployTestnet.s.sol`: roles and keys, anvil rehearsal,
  deploy, resume, manifest, service cut-over and acceptance.
- [`docs/runbooks/deploy-testnet.md`](../docs/runbooks/deploy-testnet.md): the original 1874
  deploy with `Deploy.s.sol` and `Operate.s.sol`, step by step; 2625 is not deployed.
- [`docs/runbooks/deploy-hunter.md`](../docs/runbooks/deploy-hunter.md): deploying and minting
  the Hunter collection.
