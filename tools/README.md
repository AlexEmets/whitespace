# tools/

Scripts that sit around the product rather than in it: CI gates for the contracts, chain
capability probes, the deployment manifest generator, an oracle wire check and the local
stack runner with its acceptance suite.

`tools/` is not a pnpm workspace package. Everything here is plain Node ESM (Node 22).
Scripts that need `viem` or Playwright borrow them from a workspace package by path
(`services/keeper`, `packages/reporter` or `apps/web`), so run `pnpm install` first.
Role keys are read from `~/.whitespace-keys/<role>.json` unless a flag or env var says
otherwise.

| Folder | Purpose | Run from root |
|---|---|---|
| `evm-compat/` | Toolchain and opcode gates for compiled contracts | `pnpm gate:toolchain`, `pnpm gate:evm` |
| `chain-probe/` | Checks each Whitechain network still has the capabilities the spec assumes | `pnpm probe:chains` |
| `deploy/` | Builds `deployments/<chainId>.json` from the on-chain registry; deploy guards | `node tools/deploy/manifest.mjs` |
| `oracle-probe/` | Proves a deployed verifier accepts reports from the real signer | `node tools/oracle-probe/verify-report.mjs` |
| `stack/` | Boots the stack locally, runs end-to-end acceptance, browser checks | `pnpm stack`, `tools/stack/acceptance-anvil.sh run` |

All tool tests: `pnpm test:tools` (also runs `deploy/test/`), or `node --test tools/`.

## evm-compat

Whitechain mainnet (1875) has no Cancun opcodes, so the contracts must compile for
Shanghai and must never contain `TLOAD`, `TSTORE` or `MCOPY`.

- **`toolchain.mjs <forge-config-json>`** checks the output of `forge config --json` for
  `solc 0.8.24`, `evm_version shanghai`, `bytecode_hash none`, `cbor_metadata false` and
  `via_ir true`. Exits 1 listing every mismatch.
- **`scan.mjs <forge-out-dir>`** disassembles `bytecode` and `deployedBytecode` of every
  artifact (skipping PUSH immediates) and fails on any forbidden opcode. It also fails on an
  unparseable artifact and when it found no bytecode at all, so an empty `out/` cannot pass.
  `scanBytecode(hex)` is exported and unit-tested in `scan.test.mjs`.

```bash
cd contracts && forge build
pnpm gate:toolchain
pnpm gate:evm            # node tools/evm-compat/scan.mjs contracts/out
```

## chain-probe

- **`probe.mjs`** queries every chain in `CHAINS` (`packages/shared/src/chains.mjs`: 1874,
  2625, 1875) over JSON-RPC and observes four capabilities: EIP-1559 (`baseFeePerGas` on
  the latest block), Cancun (`eth_call` of an `MCOPY` snippet), the canonical CREATE2
  factory and Multicall3 (code at their addresses). It compares them with each chain's
  `expects` and exits 1 on drift or an unreachable RPC. `classifyProbe` is tested in
  `probe.test.mjs`.
- **`pre155.mjs`** is a one-off experiment: it submits the canonical pre-EIP-155 CREATE2
  deployer transaction to 1875 and prints how to read the node's error (whether
  non-replay-protected transactions are accepted at all).

```bash
pnpm probe:chains
node tools/chain-probe/pre155.mjs
```

## deploy

- **`manifest.mjs`** builds the deployment manifest after `DeployTestnet.s.sol`. Every
  address is read from the registry the contracts resolve through: the core contracts,
  collateral, verifier, each market's pair data and price upkeep, roles, trading timeouts
  and the oracle parameters. It fails if the markets resolve to more than one price upkeep.
  `PREVIOUS_PRICE_UPKEEPS` keeps replaced upkeeps in the manifest so a re-index does not
  lose their history.

  ```bash
  REGISTRY_ADDRESS=0x... START_BLOCK=123 RPC_URL=<rpc> \
    [PREVIOUS_PRICE_UPKEEPS=0xold,...] node tools/deploy/manifest.mjs > deployments/1874.json
  ```

  `RPC_URL` defaults to the 1874 public RPC. The web app and the indexer take their
  contract addresses only from `deployments/1874.json`, so a redeploy must regenerate it.

Tests:

| File | Covers |
|---|---|
| `manifest.test.mjs` | `buildManifest`, `toBytes32`/`fromBytes32` against a fake chain |
| `liveDeployment.test.mjs` | `deployments/1874.json` matches the pinned live registry set and carries no address from the retired deployment. Update its constants in the same change as a regenerated manifest. |
| `checkBalances.test.mjs` | `deploy/check-balances.sh` against a fake JSON-RPC server: floor comparison past 64 bits, unreadable RPC, all clear |
| `indexerSchema.test.mjs` | `deploy/indexer-schema.sh` names the Ponder schema after the last commit touching the indexer's inputs |

## oracle-probe

**`verify-report.mjs`** builds a v2 report with `@whitespace/reporter`, signs it with real
signer key files and calls `WhitespaceVerifier.verify` via `eth_call` (no gas, no
transaction). It reads `threshold` and `signerCount` from the contract, refuses to run with
fewer signer roles than the threshold, and checks the returned chain id, verifier, feed,
timestamp and price round-trip. Exit 0 means the chain accepted the report.

```bash
node tools/oracle-probe/verify-report.mjs --rpc http://127.0.0.1:8545 --verifier 0x... \
  [--feed BTC/USD] [--price 65000] [--signers signer,signer-2,signer-3]
```

`--rpc` defaults to `http://127.0.0.1:8545`; signer roles resolve to
`~/.whitespace-keys/<role>.json`.

## stack

### Running the stack

- **`run.mjs`** starts indexer, api, publisher, keeper, liquidator and web in dependency
  order, waiting for each to be ready (the api's readiness reads `/health`'s body, not just
  the status code). Before booting it checks for taken ports and for `.env` keys missing
  compared with each service's `.env.example` (exit 3). Ports come from `API_PORT` (4000),
  `PUBLISHER_PORT` (8787), `INDEXER_PORT` (42069), `LIQUIDATOR_METRICS_PORT` (9464) and
  `WEB_PORT` (3000).

  ```bash
  pnpm stack                                  # everything
  node tools/stack/run.mjs api indexer        # a subset, dependencies included
  node tools/stack/run.mjs web --no-deps      # only the named services
  pnpm stack:list
  ```

- **`systemd-units.mjs`** writes systemd `--user` units (`whitespace-<name>.service`) for
  indexer, api, publisher and keeper, with `Restart=always` and the same dependency order,
  and enables linger so they survive logout and reboot. `web` is left out. The unit text
  comes from `renderUnit`, tested in `systemd-units.test.mjs`.

  ```bash
  node tools/stack/systemd-units.mjs --dry-run | install | uninstall
  ```

### Acceptance

- **`acceptance-anvil.sh run|up|down`** runs the full stack on a local anvil posing as
  chain 1874 (Shanghai, 1 s blocks): it deploys with `DeployTestnet.s.sol`, generates a
  manifest with `deploy/manifest.mjs` into a work directory (`deployments/1874.json` is
  never touched), starts publisher (real venues), keeper, indexer on a fresh schema, api and
  both automation bots on non-default ports, and with `run` executes `acceptance.mjs` and
  tears everything down. Role keys are derived from anvil's test mnemonic, except the oracle
  signers, which are the real `~/.whitespace-keys/signer*.json` files. Needs Postgres
  (`docker compose up -d postgres`), Foundry and `jq`. The script also serves as the hook
  for `acceptance.mjs` (`keeper-stop`, `keeper-start`, `degrade`, `restore`, `shift`,
  `unshift`).
- **`acceptance.mjs`** trades from a fresh funded wallet and verifies each item by reading
  chain and API state back: `vault`, `market`, `partial`, `tpsl`, `collateral`, `limit`,
  `stop`, `oneclick`, `burst`, `timeout`, `degraded`, `liquidation`, `slippage`, `history`.
  Configured by `ACCEPT_*` env vars (`ACCEPT_FUNDER_KEY` is required; see the file header).
  `ACCEPT_ONLY` picks items. An item whose hook is missing is skipped, never passed. Exits 1
  if anything failed.
- **`shifted-publisher.mjs`** is the real publisher with one feed's venue ticks shifted by
  a number of bps read from `SHIFT_FILE`, used to force a liquidation on anvil. It refuses
  to start without `SHIFT_ALLOW=anvil`.

### Browser checks

These drive the real web app in headless Chromium with Playwright from `apps/web`. A
Node-held key answers the page's wallet requests (`wallet.mjs`, an EIP-1193 provider
forwarded to Node); the key never enters the page.

| Script | What it does |
|---|---|
| `shoot.mjs <url> <out.png> [selector...]` | Screenshot plus a report of what rendered and any console or page errors |
| `shoot-wallet.mjs [--key <path>] <url> <out.png> [selector...]` | The same with a wallet connected (default key `~/.whitespace-keys/dev.json`) |
| `drive-trade.mjs [--collateral 25] [--leverage 5] [--short] [--url ...] [--out ...]` | Opens a position through the trade UI on 1874 |
| `ui-walkthrough.mjs` | Trader walkthrough against a local `acceptance-anvil.sh up` stack: orders, TP/SL, liquidation, vault, one-click. Configured by `UI_RPC`, `UI_URL`, `UI_API`, `UI_KEY`, `UI_HOOKS`, `UI_OUT`, `UI_ONLY` |

### Load

**`load.mjs`** runs `LOAD_USERS` (20) fresh wallets through `LOAD_ROUNDS` (3) rounds of
market open, hold and close against a deployment while polling the API and holding
WebSocket subscriptions, then reports fill latency, cancellations, API errors and latency,
indexer lag, and checks the API agrees with the chain. Requires `LOAD_FUNDER_KEY`; see the
file header for the other `LOAD_*` variables.

## CI

`.github/workflows/ci.yml` uses these tools in two jobs:

- **`contracts`**: after `forge build --sizes`, runs `toolchain.mjs` on the
  `forge config --json` output and `scan.mjs contracts/out`, then the contract tests and
  coverage, then `node --test tools/` for the tool unit tests.
- **`network-drift`**: runs `node tools/chain-probe/probe.mjs` against the live networks.
  It is `continue-on-error`, so drift is reported without failing the pipeline.

The stack, acceptance, oracle-probe, browser and load scripts are not run in CI; they need
a chain, keys or a running stack.
