#!/usr/bin/env bash
# Prints the Postgres schema this checkout's indexer build writes to: ws1874_<sha>, where <sha> is
# the last commit that touched anything the Ponder build depends on.
#
# Ponder refuses to start in a schema a DIFFERENT build created ("previously used by a different
# Ponder app"), so any change to the indexer's code or config needs a fresh schema. Readers never
# see these names: `ponder start --views-schema ws1874` repoints stable views at the newest build
# once it is ready, and the API and the automation bots read only those views.
set -euo pipefail
repo=${1:-$(cd "$(dirname "$0")/.." && pwd)}
sha=$(git -C "$repo" log -1 --format=%h --abbrev=10 -- services/indexer packages/shared deployments/1874.json)
[ -n "$sha" ] || { echo "indexer-schema: no commit touches the indexer" >&2; exit 1; }
echo "ws1874_${sha}"
