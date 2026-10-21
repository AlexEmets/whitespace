#!/usr/bin/env bash
# Show who currently holds Hunter badges — read straight from chain, no indexer.
#
# Usage:
#   scripts/nft/hunter/holders.sh            # table of every minted id -> current owner
#   scripts/nft/hunter/holders.sh --by-owner # grouped by wallet, with each wallet's count
#
# Token ids are sequential and never burned, so every id in 0..totalMinted-1 exists and has
# exactly one owner. We ask ownerOf() for each. `tokenURI` art is on-chain; this only lists
# holders. For a single wallet's balance use:  cast call <HUNTER> 'balanceOf(address)(uint256)' 0x..

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_deployed

BY_OWNER=0
[[ "${1:-}" == "--by-owner" ]] && BY_OWNER=1

N="$(total_minted)"
echo "Hunter        : $HUNTER (chain $CHAIN_ID)"
echo "minted        : $N / 100"
if [[ "$N" -eq 0 ]]; then
  echo "no badges minted yet."
  exit 0
fi

# id -> owner, collected once.
declare -a OWNERS
for ((id = 0; id < N; id++)); do
  OWNERS[id]="$(h_call 'ownerOf(uint256)(address)' "$id")"
done

if [[ "$BY_OWNER" -eq 0 ]]; then
  echo
  printf '%-6s  %s\n' "id" "owner"
  printf '%-6s  %s\n' "------" "------------------------------------------"
  for ((id = 0; id < N; id++)); do printf '#%-5s  %s\n' "$id" "${OWNERS[id]}"; done
  exit 0
fi

# Grouped: wallet -> space-separated ids.
declare -A IDS
for ((id = 0; id < N; id++)); do
  o="${OWNERS[id]}"
  IDS["$o"]="${IDS[$o]:-} $id"
done

echo
echo "holders: ${#IDS[@]}"
for o in "${!IDS[@]}"; do
  ids="${IDS[$o]# }"
  count="$(wc -w <<<"$ids")"
  printf '%s  count=%-3s ids=[%s]\n' "$o" "$count" "${ids// /, }"
done
