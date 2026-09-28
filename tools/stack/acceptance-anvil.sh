#!/usr/bin/env bash
# Full-stack acceptance on a LOCAL anvil that believes it is chain 1874.
#
#   tools/stack/acceptance-anvil.sh run      # up, run tools/stack/acceptance.mjs, down
#   tools/stack/acceptance-anvil.sh up       # boot only (then run acceptance.mjs by hand)
#   tools/stack/acceptance-anvil.sh down     # stop everything this script started
#
# What it boots, in order:
#   anvil --chain-id 1874 --block-time 1 --hardfork shanghai   on $ANVIL_PORT
#   contracts/script/DeployTestnet.s.sol deployTestnet()        with anvil keys for every
#       role EXCEPT the oracle signers, which are the real ~/.whitespace-keys/signer*.json
#       addresses so the real publisher signs with its real key files
#   tools/deploy/manifest.mjs -> $WORK/1874.json                (deployments/1874.json is
#       never touched: publisher/keeper/bots get every address by env; the indexer has no
#       address env, so it runs from a copy of services/indexer next to a copy of the
#       manifest at $WORK/tree/deployments/1874.json)
#   price-publisher (real venues), keeper, indexer (fresh DATABASE_SCHEMA), api, two
#   automation bots — all on ports that do not collide with a normal stack.
#
# The anvil role keys are derived at runtime from anvil's public test mnemonic into
# $WORK/keys (mode 700); nothing is written into the repo. Forge's broadcast/cache records
# of the local deploy are moved into $WORK so they cannot be mistaken for a real 1874 run.
#
# Hooks: acceptance.mjs calls this script back with keeper-stop|keeper-start|degrade|
# restore|shift <feed> <bps>|unshift. `degrade` restarts the publisher with only
# binance,bybit (BTC/ETH/SOL fall below 3 healthy venues). `shift` swaps the publisher for
# tools/stack/shifted-publisher.mjs, which moves ONE feed's venue ticks by <bps> — used only
# when the liquidation item sees no natural liquidating move in time.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SELF="$REPO/tools/stack/acceptance-anvil.sh"
export WORK=${WORK:-${ACCEPT_WORK:-/tmp/whitespace-acceptance}}
NODE=${NODE:-node}
export PATH="$(dirname "$(command -v "$NODE")"):$PATH"
ANVIL_PORT=${ANVIL_PORT:-8547}
API_PORT=${API_PORT:-4100}
PUB_PORT=${PUB_PORT:-8797}
IDX_PORT=${IDX_PORT:-42169}
KEEPER_METRICS_PORT=${KEEPER_METRICS_PORT:-9475}
BOT_A_PORT=${BOT_A_PORT:-9476}
BOT_B_PORT=${BOT_B_PORT:-9477}
PG=${DATABASE_URL:-postgresql://whitespace:whitespace@127.0.0.1:5433/whitespace}
SIGNERS=${ACCEPT_SIGNER_KEYS:-$HOME/.whitespace-keys/signer.json,$HOME/.whitespace-keys/signer-2.json,$HOME/.whitespace-keys/signer-3.json,$HOME/.whitespace-keys/signer-4.json,$HOME/.whitespace-keys/signer-5.json}
RPC=http://127.0.0.1:$ANVIL_PORT
MNEMONIC="test test test test test test test test test test test junk"
ROLES=(owner gov manager lp keeper bot-a bot-b guardian)

log() { printf '[acceptance-anvil] %s\n' "$*"; }
c() { jq -r ".contracts.$1" "$WORK/1874.json"; }
addr() { jq -r '.[0].address' "$WORK/keys/$1.json"; }
key() { jq -r '.[0].private_key' "$WORK/keys/$1.json"; }

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_http() { # url seconds
  for _ in $(seq 1 "$2"); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  log "not ready: $1"; return 1
}

start() { # name, then the command; runs in its own session so `down` can kill the group
  local name=$1; shift
  setsid "$@" >>"$WORK/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$WORK/pids/$name"
}
stop() {
  local f="$WORK/pids/$1"
  [ -f "$f" ] || return 0
  kill -TERM -- "-$(cat "$f")" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$(cat "$f")" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$(cat "$f")" 2>/dev/null || true
  rm -f "$f"
}

start_publisher() { # [entry] [venues]
  local entry=${1:-src/main.mjs} venues=${2:-}
  (cd "$REPO/services/price-publisher" && start publisher env \
    PUBLISHER_CHAIN_ID=1874 PUBLISHER_VERIFIER_ADDRESS="$(c verifier)" PUBLISHER_HOST=127.0.0.1 PUBLISHER_PORT="$PUB_PORT" \
    PUBLISHER_SIGNER_KEY_PATHS="$SIGNERS" PUBLISHER_MARKETS=BTC/USD,ETH/USD,SOL/USD,WBT/USD ${venues:+PUBLISHER_VENUES=$venues} \
    SHIFT_ALLOW=anvil SHIFT_FILE="$WORK/shift.json" "$NODE" "$entry")
  wait_http "http://127.0.0.1:$PUB_PORT/health" 90
}
start_keeper() {
  (cd "$REPO/services/keeper" && start keeper env \
    KEEPER_CHAIN_ID=1874 KEEPER_PRICE_UPKEEP_ADDRESS="$(c priceUpKeep)" KEEPER_RPC_URLS="$RPC" \
    KEEPER_PUBLISHER_URL="http://127.0.0.1:$PUB_PORT" KEEPER_FORWARDER_KEY_PATH="$WORK/keys/keeper.json" \
    KEEPER_POLLING_INTERVAL_MS=1000 KEEPER_CURSOR_PATH="$WORK/keeper-cursor.json" \
    KEEPER_DEAD_LETTER_PATH="$WORK/keeper-dead-letter.jsonl" KEEPER_METRICS_PORT="$KEEPER_METRICS_PORT" "$NODE" src/main.mjs)
  wait_http "http://127.0.0.1:$KEEPER_METRICS_PORT/health" 30
}
start_bot() { # a|b port
  (cd "$REPO/services/liquidator" && start "bot-$1" env \
    LIQUIDATOR_INSTANCE_NAME="bot-$1" LIQUIDATOR_FORWARDER_KEY_PATH="$WORK/keys/bot-$1.json" \
    LIQUIDATOR_METRICS_PORT="$2" LIQUIDATOR_DEAD_LETTER_PATH="$WORK/bot-$1-dead-letter.json" \
    DATABASE_URL="$PG" DATABASE_SCHEMA="$(cat "$WORK/schema")" LIQUIDATOR_RPC_URLS="$RPC" \
    LIQUIDATOR_PUBLISHER_URL="http://127.0.0.1:$PUB_PORT" LIQUIDATOR_CHAIN_ID=1874 \
    LIQUIDATOR_TRADES_UPKEEP_ADDRESS="$(c tradesUpKeep)" LIQUIDATOR_TRADING_ADDRESS="$(c trading)" \
    LIQUIDATOR_TRADING_STORAGE_ADDRESS="$(c tradingStorage)" LIQUIDATOR_PAIR_INFOS_ADDRESS="$(c pairInfos)" \
    LIQUIDATOR_PAIRS_STORAGE_ADDRESS="$(c pairsStorage)" LIQUIDATOR_TRIGGER_COOLDOWN_MS=10000 "$NODE" src/main.mjs)
  wait_http "http://127.0.0.1:$2/health" 30
}

up() {
  for p in $ANVIL_PORT $API_PORT $PUB_PORT $IDX_PORT $KEEPER_METRICS_PORT $BOT_A_PORT $BOT_B_PORT; do
    port_free "$p" || { log "port $p is in use"; exit 3; }
  done
  rm -rf "$WORK"; mkdir -p "$WORK/logs" "$WORK/pids" "$WORK/keys"; chmod 700 "$WORK/keys"
  echo '{}' >"$WORK/shift.json"
  log "work dir $WORK"

  local i=0
  for name in "${ROLES[@]}"; do
    local pk; pk=$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index $i)
    printf '[{"address":"%s","private_key":"%s"}]\n' "$(cast wallet address "$pk")" "$pk" >"$WORK/keys/$name.json"
    chmod 600 "$WORK/keys/$name.json"; i=$((i + 1))
  done

  start anvil anvil --chain-id 1874 --block-time 1 --hardfork shanghai --port "$ANVIL_PORT"
  for _ in $(seq 1 30); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

  # Ponder keeps its RPC cache in the database-wide `ponder_sync` schema, keyed by chain id and
  # block number — NOT by DATABASE_SCHEMA. Every local run is "chain 1874" again, so a new
  # anvil that restarts at block 0 would be served the previous run's cached blocks and logs
  # (historical sync inserts with ON CONFLICT DO NOTHING and then reads back from the cache),
  # or die on a cached range the new chain has not reached. So the chain first jumps (same
  # timestamp, empty blocks) past the highest low block any earlier run cached. Real 1874
  # data sits above 7,000,000, so anything below 1,000,000 can only be a local run's.
  local floor
  floor=$(cd "$REPO/services/api" && DATABASE_URL="$PG" "$NODE" -e '
    const pg = require("pg");
    (async () => {
      const c = new pg.Client(process.env.DATABASE_URL);
      await c.connect();
      let m = 0;
      for (const sql of [
        "select max(number) m from ponder_sync.blocks where chain_id = 1874 and number < 1000000",
        "select max(block_number) m from ponder_sync.logs where chain_id = 1874 and block_number < 1000000",
        "select max(upper(r)) m from ponder_sync.intervals, unnest(blocks) r where chain_id = 1874 and upper(r) < 1000000",
      ]) {
        try { m = Math.max(m, Number((await c.query(sql)).rows[0].m ?? 0)); } catch (e) { if (e.code !== "42P01") throw e; }
      }
      await c.end();
      console.log(m);
    })().catch((e) => { console.error(e.message); process.exit(1); });')
  if [ "$floor" -gt 0 ]; then
    local jump=$((floor + 100))
    [ "$jump" -lt 900000 ] || { log "ponder_sync already holds local-run blocks up to $floor; clean them (see runbook) or use a dedicated DATABASE_URL"; exit 1; }
    cast rpc anvil_mine "$(printf '0x%x' "$jump")" 0x0 --rpc-url "$RPC" >/dev/null
    log "ponder_sync holds local-run blocks up to $floor: chain jumped to block $(cast block-number --rpc-url "$RPC")"
  fi

  local signers; signers=$(IFS=,; for f in $SIGNERS; do printf '%s,' "$(jq -r '.[0].address // .address' "$f")"; done | sed 's/,$//')
  local start_block; start_block=$(cast block-number --rpc-url "$RPC")
  log "deploying (log: $WORK/logs/deploy.log)"
  (cd "$REPO/contracts" && env \
    DEPLOYER_PRIVATE_KEY="$(key owner)" GOV_PRIVATE_KEY="$(key gov)" MANAGER_PRIVATE_KEY="$(key manager)" LP_PRIVATE_KEY="$(key lp)" \
    DEV_ADDRESS=0x000000000000000000000000000000000000dE70 MARKET_MAKER_ADDRESS=0x000000000000000000000000000000000000Aa01 \
    ORACLE_SIGNERS="$signers" ORACLE_THRESHOLD=3 GUARDIAN_ADDRESS="$(addr guardian)" KEEPER_ADDRESS="$(addr keeper)" \
    LIQUIDATOR_ADDRESSES="$(addr bot-a),$(addr bot-b)" LP_AMOUNT=100000000000 \
    forge script script/DeployTestnet.s.sol:DeployTestnetScript --sig "deployTestnet()" \
      --rpc-url "$RPC" --broadcast --legacy --slow --sender "$(addr owner)" >"$WORK/logs/deploy.log" 2>&1) \
    || { log "deploy failed, see $WORK/logs/deploy.log"; exit 1; }
  mkdir -p "$WORK/forge"
  mv "$REPO/contracts/broadcast/DeployTestnet.s.sol/1874" "$WORK/forge/broadcast" 2>/dev/null || true
  mv "$REPO/contracts/cache/DeployTestnet.s.sol/1874" "$WORK/forge/cache" 2>/dev/null || true
  local registry; registry=$(grep -o 'registry: 0x[0-9a-fA-F]*' "$WORK/logs/deploy.log" | head -1 | cut -d' ' -f2)
  (cd "$REPO" && REGISTRY_ADDRESS="$registry" START_BLOCK="$start_block" RPC_URL="$RPC" "$NODE" tools/deploy/manifest.mjs >"$WORK/1874.json")
  log "registry $registry, manifest $WORK/1874.json, start block $start_block"

  echo "accept_$(date +%s)" >"$WORK/schema"
  mkdir -p "$WORK/tree/services" "$WORK/tree/deployments"
  rsync -a --exclude node_modules --exclude .ponder --exclude generated --exclude .env "$REPO/services/indexer/" "$WORK/tree/services/indexer/"
  ln -sfn "$REPO/services/indexer/node_modules" "$WORK/tree/services/indexer/node_modules"
  cp "$WORK/1874.json" "$WORK/tree/deployments/1874.json"

  start_publisher
  (cd "$WORK/tree/services/indexer" && start indexer env \
    CONTRACTS_START_BLOCK="$start_block" HEARTBEAT_START_BLOCK="$start_block" PONDER_RPC_URLS_1874="$RPC" \
    DATABASE_URL="$PG" DATABASE_SCHEMA="$(cat "$WORK/schema")" PONDER_TELEMETRY_DISABLED=1 \
    ./node_modules/.bin/ponder start --port "$IDX_PORT")
  wait_http "http://127.0.0.1:$IDX_PORT/ready" 180
  start_keeper
  (cd "$REPO/services/api" && start api env PORT="$API_PORT" HOST=127.0.0.1 CHAIN_ID=1874 \
    DATABASE_URL="$PG?options=-c%20search_path%3D$(cat "$WORK/schema")" PUBLISHER_URL="http://127.0.0.1:$PUB_PORT" \
    ./node_modules/.bin/tsx src/server.ts)
  wait_http "http://127.0.0.1:$API_PORT/health" 60
  start_bot a "$BOT_A_PORT"
  start_bot b "$BOT_B_PORT"
  log "up: rpc $RPC api http://127.0.0.1:$API_PORT publisher http://127.0.0.1:$PUB_PORT schema $(cat "$WORK/schema")"
}

down() {
  for s in bot-a bot-b api keeper indexer publisher anvil; do stop "$s"; done
  log "down (logs kept in $WORK/logs; Postgres schema $(cat "$WORK/schema" 2>/dev/null) left in place)"
}

acceptance() {
  ACCEPT_RPC_URL="$RPC" ACCEPT_API_URL="http://127.0.0.1:$API_PORT" ACCEPT_PUBLISHER_URL="http://127.0.0.1:$PUB_PORT" \
  ACCEPT_MANIFEST="$WORK/1874.json" ACCEPT_FUNDER_KEY="$WORK/keys/owner.json" ACCEPT_GOV_KEY="$WORK/keys/gov.json" \
  ACCEPT_HOOKS="$SELF" ACCEPT_GAS_AMOUNT=${ACCEPT_GAS_AMOUNT:-5} ACCEPT_OUT=${ACCEPT_OUT:-$WORK/acceptance.json} \
    "$NODE" "$REPO/tools/stack/acceptance.mjs"
}

case ${1:-run} in
  up) up ;;
  down) down ;;
  run)
    trap down EXIT
    up
    acceptance ;;
  # ---- hooks, called back by acceptance.mjs ----
  keeper-stop) stop keeper ;;
  keeper-start) [ -f "$WORK/pids/keeper" ] || start_keeper ;;
  degrade) stop publisher; start_publisher src/main.mjs binance,bybit ;;
  restore) stop publisher; start_publisher ;;
  shift) printf '{"%s": %s}\n' "$2" "$3" >"$WORK/shift.json"; stop publisher; start_publisher "$REPO/tools/stack/shifted-publisher.mjs" ;;
  unshift) echo '{}' >"$WORK/shift.json"; stop publisher; start_publisher ;;
  *) echo "usage: $0 run|up|down" >&2; exit 2 ;;
esac
