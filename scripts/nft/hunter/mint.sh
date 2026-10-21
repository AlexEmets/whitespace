#!/usr/bin/env bash
# Mint Hunter bug-bounty badges to one or more wallets (owner only).
#
# Usage:
#   scripts/nft/hunter/mint.sh 0xWALLET                 # one badge to one wallet   -> mint()
#   scripts/nft/hunter/mint.sh 0xW1 0xW2 0xW3           # one badge to each wallet  -> airdrop()
#   scripts/nft/hunter/mint.sh --count 5 0xWALLET       # N badges into one wallet  -> mintBatch()
#   scripts/nft/hunter/mint.sh --dry-run 0xW1 0xW2      # preflight only, send nothing
#
# Token ids are assigned sequentially in mint order (0,1,2,...), so after the tx this script
# reports exactly which id each recipient received without parsing logs. Supply is hard-capped
# at 100; the script refuses before sending if the request would exceed what remains.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_deployed

DRY_RUN=0
COUNT=1
ADDRS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --count)   COUNT="${2:?--count needs a number}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "error: unknown flag: $1" >&2; exit 1 ;;
    *)         ADDRS+=("$(checksum "$1")"); shift ;;
  esac
done

[[ ${#ADDRS[@]} -ge 1 ]] || { echo "error: give at least one recipient address" >&2; exit 1; }
[[ "$COUNT" =~ ^[0-9]+$ && "$COUNT" -ge 1 ]] || { echo "error: --count must be a positive integer" >&2; exit 1; }
if [[ "$COUNT" -gt 1 && ${#ADDRS[@]} -ne 1 ]]; then
  echo "error: --count N only works with exactly one recipient (that is mintBatch)" >&2
  exit 1
fi

# How many tokens this call mints, and the function it uses.
if [[ "$COUNT" -gt 1 ]]; then
  QTY="$COUNT"; MODE="mintBatch"
elif [[ ${#ADDRS[@]} -eq 1 ]]; then
  QTY=1; MODE="mint"
else
  QTY=${#ADDRS[@]}; MODE="airdrop"
fi

START="$(total_minted)"           # id the next mint will use == count minted so far
REM="$(remaining)"

echo "Hunter        : $HUNTER (chain $CHAIN_ID)"
echo "minted so far : $START / 100   (remaining: $REM)"
echo "mode          : $MODE  minting $QTY badge(s)"
echo "recipients    :"
if [[ "$MODE" == "mintBatch" ]]; then
  printf '  %s  x%s  -> ids %s..%s\n' "${ADDRS[0]}" "$QTY" "$START" "$((START + QTY - 1))"
else
  i="$START"
  for a in "${ADDRS[@]}"; do printf '  %s  -> id %s\n' "$a" "$i"; i=$((i + 1)); done
fi

if [[ "$QTY" -gt "$REM" ]]; then
  echo "error: need $QTY but only $REM remain of the 100 cap — refusing to send" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: nothing sent."
  exit 0
fi

echo "sending from owner $(owner_addr) ..."
case "$MODE" in
  mint)
    cast send "$HUNTER" "mint(address)" "${ADDRS[0]}" \
      --rpc-url "$RPC" --private-key "$(owner_pk)" --legacy ;;
  mintBatch)
    cast send "$HUNTER" "mintBatch(address,uint256)" "${ADDRS[0]}" "$QTY" \
      --rpc-url "$RPC" --private-key "$(owner_pk)" --legacy ;;
  airdrop)
    list="[$(IFS=,; echo "${ADDRS[*]}")]"
    cast send "$HUNTER" "airdrop(address[])" "$list" \
      --rpc-url "$RPC" --private-key "$(owner_pk)" --legacy ;;
esac

END="$(total_minted)"
echo
echo "done. minted so far: $END / 100   (remaining: $(remaining))"
echo "explorer: $EXPLORER/address/$HUNTER"
