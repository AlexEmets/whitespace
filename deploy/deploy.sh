#!/usr/bin/env bash
# Deploy the public testnet stack. Run as the `whitespace` user.
set -euo pipefail

# Overridable only so deploy/test/deploySh.test.mjs can run this against a scratch clone with
# stubbed sudo/systemctl/pnpm; production uses the defaults.
REPO=${WHITESPACE_REPO:-/home/whitespace/whitespace}
# Which commit each restart-on-change unit last came up on (see changed_since).
STATE_DIR=${WHITESPACE_DEPLOY_STATE:-$HOME/.whitespace-deploy}
VERIFY_DELAY_S=${WHITESPACE_VERIFY_DELAY_S:-5}

# Set while web and indexer are stopped for the build; see recover_on_exit.
UNITS_STOPPED_FOR_BUILD=0

# EVERYTHING lives inside main(), which is called on the last line, and that structure is
# load-bearing rather than stylistic. bash reads a script incrementally, keeping a byte
# offset into the file — and the first thing this script does is `git pull`, which can
# rewrite the script itself. When a pull changes this file's length mid-run, the offset
# then lands in the wrong place of the new text and bash executes a mix of the old and new
# versions. Observed exactly that: a fixed `deploy.sh` was pulled and the run still used
# the previous body. A function body is parsed in full before any of it executes, so
# wrapping the work here makes a self-modifying pull harmless.
main() {
  cd "$REPO"
  trap recover_on_exit EXIT

  echo "==> pulling"
  git pull --ff-only

  echo "==> installing dependencies"
  pnpm install --frozen-lockfile

  echo "==> naming the indexer build schema"
  write_indexer_build_env

  install_units_if_changed

  echo "==> stopping memory-heavy units for the build"
  # One `sudo systemctl <verb> <single-unit>` per call, never a multi-unit line.
  # /etc/sudoers.d/whitespace matches the WHOLE command including its arguments, so
  # `systemctl restart a b c` is a different — and unpermitted — command from three
  # separate restarts. Batching them fails with "I'm afraid I can't do that".
  UNITS_STOPPED_FOR_BUILD=1
  ws_ctl stop whitespace-web whitespace-indexer

  echo "==> building the frontend"
  # NEXT_PUBLIC_* values are inlined into the bundle here, not read at runtime, so
  # apps/web/.env.local must already hold the final public URLs before this runs.
  #
  # The units above are stopped first as arithmetic, not tidiness. Measured on this host:
  # bare Ubuntu 26.04 uses ~330 MB, dockerd + containerd ~122 MB, the running stack ~900 MB
  # of 1909 MB total, and `next build` peaks near 807 MB of real (PSS) memory. Building
  # with the stack up leaves the box a few tens of megabytes from the ceiling — it survives
  # on the 2 GB swapfile, which is the backstop, not the plan.
  build_web

  # Refuse to restart onto a tree with no build. `next start` against an empty .next
  # crash-loops and Caddy serves 502 — which is exactly how this script took the site down
  # on 2026-09-22 after a build failure it did not notice.
  if [ ! -f apps/web/.next/BUILD_ID ]; then
    echo "    FAIL: the build produced no .next/BUILD_ID — NOT restarting web" >&2
    echo "    Recover with: rm -rf apps/web/.next && pnpm --filter @whitespace/web build" >&2
    echo "    then: sudo systemctl start whitespace-web" >&2
    exit 1
  fi

  echo "==> restarting the stack"
  # The publisher and the keeper hold in-memory state that a restart throws away (the
  # publisher's mark EMA and venue books, which take a window to rebuild; the keeper's
  # in-flight deliveries), so they are restarted only when something they run changed.
  restart_if_changed publisher whitespace-publisher \
    services/price-publisher packages/shared packages/reporter packages/metrics \
    pnpm-lock.yaml deploy/systemd/whitespace-publisher.service
  restart_if_changed keeper whitespace-keeper \
    services/keeper packages/shared packages/reporter packages/metrics packages/txsender \
    pnpm-lock.yaml deploy/systemd/whitespace-keeper.service
  ws_ctl restart whitespace-api
  ws_ctl start whitespace-indexer whitespace-web
  UNITS_STOPPED_FOR_BUILD=0
  # The automation bots read candidates from the indexer's database, so they come up after
  # it. Two instances, two forwarder keys (services/liquidator/.env.a, .env.b).
  ws_ctl restart whitespace-bot@a whitespace-bot@b

  verify_running_build
}

# Whatever ends the run — a failed build, a failed install, a failed restart, Ctrl-C — the
# indexer and web must not be left stopped. Under `set -e` any failing command between the
# stop and the start used to exit right there, and the site stayed down until someone
# noticed and started the units by hand.
recover_on_exit() {
  local status=$?
  if [ "$UNITS_STOPPED_FOR_BUILD" = 1 ]; then
    echo "==> deploy failed with web and indexer stopped — bringing them back" >&2
    sudo systemctl start whitespace-indexer || echo "    could not start whitespace-indexer" >&2
    # Web only onto a complete build: `next start` on a tree without BUILD_ID crash-loops.
    # build_web's retry clears .next first, so a BUILD_ID here is a whole build — this
    # deploy's, or the previous one if the failure came before the build replaced it.
    if [ -f "$REPO/apps/web/.next/BUILD_ID" ]; then
      sudo systemctl start whitespace-web || echo "    could not start whitespace-web" >&2
    else
      echo "    whitespace-web NOT started: apps/web/.next has no BUILD_ID. The site is DOWN." >&2
      echo "    Recover with: rm -rf apps/web/.next && pnpm --filter @whitespace/web build" >&2
      echo "    then: sudo systemctl start whitespace-web" >&2
    fi
  fi
  exit "$status"
}

# `next build` can fail in "Collecting build traces" against a .next left behind by an
# earlier build. Observed 2026-09-22:
#
#   Collecting build traces ...
#   [Error: ENOENT: ... '.next/server/app/icon.svg/route.js.nft.json']
#
# The build then exits WITHOUT writing BUILD_ID or static/, while having already replaced
# server/ — so there is no usable tree left to fall back to. The same commit built cleanly
# on the dev machine, so it is stale on-box state, not the code.
#
# Retry once from a clean .next rather than pre-emptively deleting it every deploy: the
# incremental cache is what keeps an on-box build near 60s, and paying that cost on every
# deploy to defend against an occasional failure is the wrong trade.
build_web() {
  if pnpm --filter @whitespace/web build; then
    return 0
  fi
  echo "    build failed — clearing .next and retrying once" >&2
  rm -rf apps/web/.next
  pnpm --filter @whitespace/web build
}

# Ponder refuses a schema another build created, so each indexer build gets its own (see
# deploy/indexer-schema.sh); readers use the stable `ws1874` views Ponder repoints on ready.
write_indexer_build_env() {
  local schema
  schema=$(deploy/indexer-schema.sh)
  printf 'DATABASE_SCHEMA=%s\n' "$schema" > services/indexer/.env.build
  echo "    indexer schema: $schema (views: ws1874)"
}

ws_ctl() {
  local verb=$1
  shift
  for unit in "$@"; do sudo systemctl "$verb" "$unit"; done
}

# Succeeds when any of <paths> differs between the commit recorded under <name> and HEAD.
# Also succeeds when there is no record or the recorded commit is unknown (first run, a
# rewritten history): an unnecessary restart is cheap, a missed one runs stale code.
#
# Compared against what the unit last came up on, not against the pre-pull HEAD: a deploy
# that pulled and then failed before the restart would otherwise leave the next run seeing
# "nothing changed" and the old code running indefinitely.
changed_since() {
  local name=$1
  shift
  local stamp="$STATE_DIR/$name.sha" last
  [ -f "$stamp" ] || return 0
  last=$(cat "$stamp")
  git cat-file -e "${last}^{commit}" 2>/dev/null || return 0
  ! git diff --quiet "$last" HEAD -- "$@"
}

mark_deployed() {
  mkdir -p "$STATE_DIR"
  git rev-parse HEAD > "$STATE_DIR/$1.sha"
}

restart_if_changed() {
  local name=$1 unit=$2
  shift 2
  if changed_since "$name" "$@"; then
    ws_ctl restart "$unit"
    mark_deployed "$name"
  else
    echo "    $unit: nothing it runs changed — left running"
  fi
}

# A unit file change does nothing until it is copied over and systemd re-reads it; pulling
# a new MemoryMax or ExecStart and restarting used to keep running the old definition.
# One file per sudo call for the same sudoers reason as ws_ctl (the runbook lists the
# entries). Only .service/.timer files that exist in the repo are installed.
install_units_if_changed() {
  if ! changed_since units deploy/systemd; then
    return 0
  fi
  echo "==> installing changed systemd units"
  local f
  for f in deploy/systemd/*.service deploy/systemd/*.timer; do
    [ -f "$f" ] || continue
    sudo cp "$f" "/etc/systemd/system/$(basename "$f")"
  done
  sudo systemctl daemon-reload
  mark_deployed units
}

# "Deployed" and "running" are different claims. A build writes .next; only a restart makes
# `next start` serve it, and a restart that silently failed leaves the old bundle live with
# every other signal looking green. Assert the running server started after the build it is
# supposed to be serving, and fail the deploy loudly if it did not.
verify_running_build() {
  echo "==> verifying the running server is the build on disk"
  sleep "$VERIFY_DELAY_S"

  local build_epoch started_epoch
  build_epoch=$(stat -c %Y "$REPO/apps/web/.next/BUILD_ID")
  started_epoch=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value whitespace-web)" +%s)

  echo "    BUILD_ID written : $(date -d "@$build_epoch" '+%F %T')"
  echo "    web started      : $(date -d "@$started_epoch" '+%F %T')"

  if [ "$started_epoch" -lt "$build_epoch" ]; then
    echo "    FAIL: whitespace-web predates the build — it is serving a stale bundle" >&2
    return 1
  fi
  echo "    OK: the running server postdates the build"

  local failed=0 state
  for unit in whitespace-publisher whitespace-keeper whitespace-indexer whitespace-api whitespace-web \
    whitespace-bot@a whitespace-bot@b whitespace-balances.timer whitespace-backup.timer; do
    state=$(systemctl is-active "$unit" || true)
    printf '    %-28s %s\n' "$unit" "$state"
    [ "$state" = "active" ] || failed=1
  done
  if [ "$failed" -ne 0 ]; then
    echo "    FAIL: a unit above is not active" >&2
    return 1
  fi
}

main "$@"
