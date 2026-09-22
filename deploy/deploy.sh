#!/usr/bin/env bash
# Deploy the public testnet stack. Run as the `whitespace` user.
set -euo pipefail

# EVERYTHING lives inside main(), which is called on the last line, and that structure is
# load-bearing rather than stylistic. bash reads a script incrementally, keeping a byte
# offset into the file — and the first thing this script does is `git pull`, which can
# rewrite the script itself. When a pull changes this file's length mid-run, the offset
# then lands in the wrong place of the new text and bash executes a mix of the old and new
# versions. Observed exactly that: a fixed `deploy.sh` was pulled and the run still used
# the previous body. A function body is parsed in full before any of it executes, so
# wrapping the work here makes a self-modifying pull harmless.
main() {
  cd /home/whitespace/whitespace

  echo "==> pulling"
  git pull --ff-only

  echo "==> installing dependencies"
  pnpm install --frozen-lockfile

  echo "==> stopping memory-heavy units for the build"
  # One `sudo systemctl <verb> <single-unit>` per call, never a multi-unit line.
  # /etc/sudoers.d/whitespace matches the WHOLE command including its arguments, so
  # `systemctl restart a b c` is a different — and unpermitted — command from three
  # separate restarts. Batching them fails with "I'm afraid I can't do that".
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
    echo "    The site is currently DOWN (web was stopped for the build)." >&2
    echo "    Recover with: rm -rf apps/web/.next && pnpm --filter @whitespace/web build" >&2
    echo "    then: sudo systemctl start whitespace-indexer whitespace-web" >&2
    exit 1
  fi

  echo "==> restarting the stack"
  ws_ctl restart whitespace-publisher whitespace-keeper whitespace-api
  ws_ctl start whitespace-indexer whitespace-web

  verify_running_build
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

ws_ctl() {
  local verb=$1
  shift
  for unit in "$@"; do sudo systemctl "$verb" "$unit"; done
}

# "Deployed" and "running" are different claims. A build writes .next; only a restart makes
# `next start` serve it, and a restart that silently failed leaves the old bundle live with
# every other signal looking green. Assert the running server started after the build it is
# supposed to be serving, and fail the deploy loudly if it did not.
verify_running_build() {
  echo "==> verifying the running server is the build on disk"
  sleep 5

  local build_epoch started_epoch
  build_epoch=$(stat -c %Y /home/whitespace/whitespace/apps/web/.next/BUILD_ID)
  started_epoch=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value whitespace-web)" +%s)

  echo "    BUILD_ID written : $(date -d "@$build_epoch" '+%F %T')"
  echo "    web started      : $(date -d "@$started_epoch" '+%F %T')"

  if [ "$started_epoch" -lt "$build_epoch" ]; then
    echo "    FAIL: whitespace-web predates the build — it is serving a stale bundle" >&2
    return 1
  fi
  echo "    OK: the running server postdates the build"

  for unit in whitespace-publisher whitespace-keeper whitespace-indexer whitespace-api whitespace-web; do
    printf '    %-24s %s\n' "$unit" "$(systemctl is-active "$unit")"
  done
}

main "$@"
