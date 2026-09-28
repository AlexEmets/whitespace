# Runbook: redeploy chain 1874 from scratch (testnet-perfect)

Replaces the first 1874 deployment (commit `22e1a5c`, migrated in place four times) with one
built by `contracts/script/DeployTestnet.s.sol` in a single recorded run. Design and the
parameters it sets: `docs/superpowers/specs/2026-09-28-testnet-perfect-design.md`.

**What changes for users.** Every address changes. Positions and LP shares on the old
deployment are not migrated — it is testnet USDW. Announce the cut-over before step 4.

**Roles reuse the existing keys** in `~/.whitespace-keys/` (never in the repo):

| role | key file | signs |
|---|---|---|
| owner / deployer / registry owner / USDW owner | `owner.json` | deploy, forwarder allowlists, USDW mint |
| gov | `gov.json` | registry wiring, markets, oracle, fees |
| manager | `manager.json` | max OI, dynamic spread |
| guardian | `guardian.json` | nothing at deploy (pause/halt only) |
| keeper | `keeper.json` | price deliveries (service) |
| signers ×5 | `signer.json`, `signer-{2..5}.json` | price reports (publisher) |
| LP | `lp.json` — **generate** | the seed vault deposit |
| bot a / bot b | `bot-a.json`, `bot-b.json` — **generate** | automation triggers (services) |

Note: the handover of 2026-09-22 said the gov key was not available. It is in
`~/.whitespace-keys/gov.json` on the development machine; it was only absent from the repo and
the prod box.

---

## 0. Preconditions

```bash
REPO=$(git rev-parse --show-toplevel)
cd "$REPO" && git status --short   # clean, on the commit being deployed
cd contracts && forge test --match-contract DeployTestnetTest   # the script's own test
```

Generate the three new keys (prints addresses only):

```bash
for name in lp bot-a bot-b; do
  f=~/.whitespace-keys/$name.json
  [ -e "$f" ] && { echo "$f exists, not overwriting"; continue; }
  cast wallet new --json > "$f" && chmod 600 "$f"
  jq -r '.[0].address' "$f"
done
```

Fund with WBT for gas (from the owner, which has faucet funds):

| address | needs | why |
|---|---|---|
| owner | ~0.2 WBT | deploys ~20 contracts |
| gov | ~0.1 | ~40 configuration txs |
| manager | ~0.02 | 8 txs |
| lp | ~0.01 | approve + request + claim |
| keeper, bot-a, bot-b | ~0.5 each | ongoing |

```bash
key() { jq -r '.[0].private_key // .private_key' ~/.whitespace-keys/$1.json; }
addr() { jq -r '.[0].address // .address' ~/.whitespace-keys/$1.json; }
RPC=https://rpc.testnet.whitechain.io
for who in gov:0.1 manager:0.02 lp:0.01 bot-a:0.5 bot-b:0.5; do
  cast send --legacy --rpc-url $RPC --private-key "$(key owner)" "$(addr ${who%%:*})" --value "${who#*:}ether"
done
```

## 1. Rehearse on anvil

The script accepts chain 31337 so the exact run can be rehearsed first.

```bash
anvil --chain-id 31337 --block-time 1 &
# same env block as step 2, with RPC=http://127.0.0.1:8545 and anvil-funded keys
```

## 2. Deploy

```bash
cd "$REPO/contracts"
export DEPLOYER_PRIVATE_KEY=$(key owner) GOV_PRIVATE_KEY=$(key gov) MANAGER_PRIVATE_KEY=$(key manager) LP_PRIVATE_KEY=$(key lp)
export DEV_ADDRESS=$(addr dev) MARKET_MAKER_ADDRESS=$(addr marketmaker)
export ORACLE_SIGNERS=$(for f in signer signer-2 signer-3 signer-4 signer-5; do printf '%s,' "$(addr $f)"; done | sed 's/,$//')
export ORACLE_THRESHOLD=3 GUARDIAN_ADDRESS=$(addr guardian) KEEPER_ADDRESS=$(addr keeper)
export LIQUIDATOR_ADDRESSES=$(addr bot-a),$(addr bot-b) LP_AMOUNT=100000000000
START_BLOCK=$(cast block-number --rpc-url $RPC)
forge script script/DeployTestnet.s.sol:DeployTestnetScript --sig "deployTestnet()" \
  --rpc-url $RPC --broadcast --legacy --slow --sender "$(addr owner)" -vvv
```

`--sender` is not optional. `OstiumTrading` and `OstiumTradingCallbacks` link two external
libraries, which forge deploys BEFORE the script body runs — through the CREATE2 factory, from
whatever `--sender` says. Without it they come from Foundry's default sender
(`0x1804…1f38`), which holds no funds, and the run aborts with "You seem to be using Foundry's
default sender" (observed on the anvil rehearsal). **Mainnet 1875 has no CREATE2 factory**
(spec §10.2): there the libraries must be deployed first with `forge create` and passed with
`--libraries`.

If the run dies after the core is deployed, **do not re-run `deployTestnet()`** (it would
deploy a second core). Resume configuration against the registry it printed:

```bash
export REGISTRY_ADDRESS=0x...
forge script script/DeployTestnet.s.sol:DeployTestnetScript --sig "configureTestnet()" \
  --rpc-url $RPC --broadcast --legacy --slow --sender "$(addr owner)" -vvv
```

Every step reads before it writes, so a resume sends only what is missing — and a replay over
a finished system sends nothing at all (rehearsed on anvil 2026-09-28: 101 transactions for the
full deploy, 0 for the replay).

## 3. Write the manifest from chain

```bash
cd "$REPO"
REGISTRY_ADDRESS=0x... START_BLOCK=$START_BLOCK RPC_URL=$RPC node tools/deploy/manifest.mjs > deployments/1874.json
git diff --stat deployments/1874.json
```

The tool refuses to write if any core key is missing or if markets resolve to different
upkeeps. `deployments/1874-operational.json` describes the old deployment's proof trades and
is kept for history; `services/indexer/fixtures/capture.json` pins what the decoder tests need.

## 4. Cut over the services (on the server)

See `docs/runbooks/deploy-server.md` for the host. In order:

1. Stop the bots, keeper, indexer, api: `sudo systemctl stop whitespace-bot@a whitespace-bot@b whitespace-keeper whitespace-indexer whitespace-api` (one unit per command there).
2. Pull the commit carrying the new `deployments/1874.json`.
3. Indexer: set `CONTRACTS_START_BLOCK=$START_BLOCK` and `HEARTBEAT_START_BLOCK=$START_BLOCK`
   in `services/indexer/.env`, and a **new** `DATABASE_SCHEMA` (e.g. `ponder_1874_v2`) so the
   old deployment's rows are not mixed in. Point `services/api` at the same schema.
4. Keeper: no address env needed (reads the manifest); confirm `KEEPER_PRICE_UPKEEP_ADDRESS`
   is unset or equal to the new upkeep.
5. Publisher: `PUBLISHER_VERIFIER_ADDRESS` = new verifier (it signs the verifier address into
   every report — a stale value makes every report fail `verify()`).
6. Bots: copy `bot-a.json`/`bot-b.json` to the box's key dir; write `services/liquidator/.env.a`
   and `.env.b` (forwarder key path, instance name, metrics ports 9466/9467 (the keeper holds 9465), `DATABASE_URL`).
7. `deploy/deploy.sh` — rebuilds web (addresses are baked in at build time) and restarts all.

## 5. Acceptance — prove every feature live

Each item reads the resulting state back; "transaction mined" is not evidence. Use a fresh
trader wallet funded from the faucet page.

| # | action | expected, read back |
|---|---|---|
| 1 | market long BTC 10x, then close from a wallet holding 0 USDW | position gone, USDW returned |
| 2 | partial close 50% | collateral halves, closed_position row with 5000 |
| 3 | limit buy below mark; update trigger; cancel | limit_order row appears, changes, disappears |
| 4 | stop buy above mark; price crosses | position opened by bot trigger (automation_open executed) |
| 5 | TP and SL at open; update both; TP hit | closeReason `tp` |
| 6 | top up, then remove margin | collateral up, then down after the keeper report |
| 7 | 50x position, wait for a ~2% adverse move (or list a test pair) | closeReason `liq`, vault balance up |
| 8 | stop keeper; open; wait 11 blocks; reclaim | collateral back via `openTradeMarketTimeout` |
| 9 | LP request deposit; wait for hourly settlement; claim | shares minted |
| 10 | kill venues until degraded | opens refused 409, closes still fill |
| 11 | terminal quote for 500k notional | Buy/Sell move away from mark; fill within max slippage |
| 12 | every history tab | matches `/fees`, `/orders/:a/history`, `/pnl` |

Record the tx hashes and results in `deployments/1874-acceptance.json`.

## 6. Scripted acceptance run (`tools/stack/acceptance.mjs`)

The table in step 5, automated. It trades from a fresh random wallet (key in memory only)
funded by `ACCEPT_FUNDER_KEY`, and every item reads its result back from the chain and from
the API; a mined transaction is never counted. Items: `vault`, `market` (close from a wallet
holding 0 USDW), `partial`, `tpsl`, `collateral`, `limit`, `stop`, `timeout`, `degraded`,
`liquidation`, `slippage`, `history`. It prints a PASS/FAIL/SKIP table and exits 1 on any
FAIL. Row 11's terminal quote is a web check and is not covered; `slippage` checks that
every fill landed inside the wanted price ± max slippage.

### Against a local anvil

```bash
NODE=~/.nvm/versions/node/v22.18.0/bin/node tools/stack/acceptance-anvil.sh run
```

Boots anvil (`--chain-id 1874 --block-time 1 --hardfork shanghai`, port 8547), runs
`deployTestnet()` with anvil keys for every role except the oracle signers (the real
`~/.whitespace-keys/signer*.json` addresses, so the real publisher signs), writes the manifest
to `$WORK/1874.json` (never `deployments/1874.json`), and starts publisher (real venues),
keeper, indexer (fresh `DATABASE_SCHEMA`), api and two automation bots on ports 8797, 9475,
42169, 4100, 9476/9477. The indexer has no address override, so it runs from a copy of
`services/indexer` beside a copy of the manifest. Logs and results (`acceptance.json`) stay
in `$WORK` (default `/tmp/whitespace-acceptance`). `up` / `down` boot or stop without
running.

Local-only mechanics, all in the script's hooks:
- `timeout` stops the keeper, requests an open and a close, waits 11 blocks, reclaims both.
- `degraded` restarts the publisher with only `binance,bybit` (BTC/ETH/SOL fall below 3
  healthy venues): the publisher answers 409 for opens and 200 for closes, an open request
  goes unfilled and is reclaimed, a close fills.
- `liquidation` opens SOL at max leverage and waits `ACCEPT_LIQ_WAIT_S` (120 s) for a real
  move; if none comes it swaps in `tools/stack/shifted-publisher.mjs`, the real publisher
  with SOL's venue ticks shifted -1.5%, and swaps the real one back afterwards. The bots
  liquidate on their own either way.
- `vault` settles with gov `forceSettlement()` instead of waiting the hour.

Ponder caches RPC data in the database-wide `ponder_sync` schema by chain id, not by
`DATABASE_SCHEMA`, so every local run is "1874" again. The script therefore first jumps the
anvil chain past the highest block a previous local run left in that cache (below 1,000,000;
real 1874 data is above 7,000,000). A dedicated `DATABASE_URL` for local runs avoids this
entirely.

### Against 1874

```bash
ACCEPT_RPC_URL=https://rpc.testnet.whitechain.io ACCEPT_API_URL=http://127.0.0.1:4000 \
ACCEPT_PUBLISHER_URL=http://127.0.0.1:8787 ACCEPT_FUNDER_KEY=~/.whitespace-keys/owner.json \
ACCEPT_GAS_AMOUNT=0.05 ACCEPT_OUT=deployments/1874-acceptance.json \
  node tools/stack/acceptance.mjs
```

Run it on the server (the publisher is loopback-only). Without `ACCEPT_GOV_KEY` the vault
item waits for the hourly `tryNewSettlement()`; pass `ACCEPT_GOV_KEY=~/.whitespace-keys/gov.json`
to force it. Without `ACCEPT_HOOKS` the `timeout` and `degraded` items SKIP, and
`liquidation` SKIPs unless SOL moves ~0.75% within `ACCEPT_LIQ_WAIT_S` (raise it, or pick
`ACCEPT_LIQ_PAIR`). A hooks script for the server maps `keeper-stop`/`keeper-start` to
`systemctl stop|start whitespace-keeper` and `degrade`/`restore` to a publisher restart with
a reduced `PUBLISHER_VENUES`; never provide `shift` there.

A deposit is refused (becomes RECLAIMABLE) whenever the settlement sees traders in net open
profit (`OstiumVault._maxMint` returns 0 while `effectiveAccPnlPerTokenUsed() > 0`); the
`vault` item then reclaims it and says so. That is why it runs first, before any trade.
