#!/usr/bin/env bash
# Deploy the public testnet stack. Run as the `whitespace` user.
#
# The one thing this script does that the design's sketch did not: it STOPS the web and
# indexer units before building, and starts them again after.
#
# That is not tidiness, it is arithmetic. Measured on this host: a bare Ubuntu 26.04 uses
# ~330 MB, dockerd + containerd another ~122 MB, and the running stack about 900 MB, out
# of 1909 MB total. `next build` peaks at ~807 MB of real (PSS) memory — a figure that did
# not change when pinned to two CPUs, so it is the compiler process, not worker
# parallelism, and it will not shrink on this 1-vCPU box either. Building with everything
# running therefore lands within a few tens of megabytes of the ceiling. Stopping the web
# server and the indexer frees ~307 MB and turns a coin flip into a routine build. The
# 2 GB swapfile is the backstop, not the plan.
set -euo pipefail

cd /home/whitespace/whitespace

echo "==> pulling"
git pull --ff-only

echo "==> installing dependencies"
pnpm install --frozen-lockfile

# One `sudo systemctl <verb> <single-unit>` per call, never a multi-unit line.
# /etc/sudoers.d/whitespace matches the WHOLE command including its arguments, so
# `systemctl restart a b c` is a different — and unpermitted — command from three
# separate restarts. Batching them fails with "I'm afraid I can't do that", which under
# `|| true` is swallowed silently: the build then runs against a live stack and the new
# bundle is never activated. Keep these loops.
ws_ctl() {
  local verb=$1
  shift
  for unit in "$@"; do sudo systemctl "$verb" "$unit"; done
}

echo "==> stopping memory-heavy units for the build"
ws_ctl stop whitespace-web whitespace-indexer

echo "==> building the frontend"
# NEXT_PUBLIC_* values are inlined into the bundle here, not read at runtime, so
# apps/web/.env.local must already hold the final public URLs before this runs.
pnpm --filter @whitespace/web build

echo "==> restarting the stack"
ws_ctl restart whitespace-publisher whitespace-keeper whitespace-api
ws_ctl start whitespace-indexer whitespace-web

echo "==> done"
systemctl --no-pager --plain is-active \
  whitespace-publisher whitespace-keeper whitespace-indexer whitespace-api whitespace-web || true
