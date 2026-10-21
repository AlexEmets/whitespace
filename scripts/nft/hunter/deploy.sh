#!/usr/bin/env bash
# Deploy the Hunter collection to the selected chain and record its address.
#
# Usage:
#   CHAIN=1875 scripts/nft/hunter/deploy.sh            # deploy to mainnet, no initial mint
#   CHAIN=1875 scripts/nft/hunter/deploy.sh --dry-run  # simulate (no --broadcast), send nothing
#   CHAIN=1874 scripts/nft/hunter/deploy.sh            # (re)deploy to testnet
#
# By default it deploys a CLEAN collection (HUNTER_INITIAL_MINT=0): the contract is created and
# nothing is minted, so you then hand out badges with mint.sh. Override HUNTER_INITIAL_MINT /
# HUNTER_MINT_TO to seed the owner at deploy time instead.
#
# On success it writes the new address into deployments/hunter-<CHAIN>.json (preserving the file's
# note), which is where mint.sh / holders.sh and (for testnet) the frontend read it from.
# Whitechain requires --legacy; the owner key is passed to forge via env, never on the CLI.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

command -v forge >/dev/null 2>&1 || { echo "error: forge not found in PATH" >&2; exit 1; }

OWNER="$(owner_addr)"
INITIAL="${HUNTER_INITIAL_MINT:-0}"

echo "chain         : $CHAIN   rpc: $RPC"
echo "owner/minter  : $OWNER"
echo "initial mint  : $INITIAL"
if [[ "$HUNTER_DEPLOYED" -eq 1 ]]; then
  echo "WARNING: $DEPLOYMENT_FILE already records $HUNTER on chain $CHAIN."
  echo "         Deploying again creates a SECOND collection and overwrites that address."
fi

# Owner must be funded on this chain or the broadcast will fail with no balance.
BAL="$(cast balance "$OWNER" --rpc-url "$RPC")"
echo "owner balance : $(cast to-unit "$BAL" ether) WBT"
if [[ "$DRY_RUN" -eq 0 && "$BAL" == "0" ]]; then
  echo "error: owner has 0 WBT on chain $CHAIN — fund $OWNER before deploying." >&2
  exit 1
fi

cd "$REPO_ROOT/contracts"
# forge reads the key from this env var (the script calls vm.envUint("DEPLOYER_PRIVATE_KEY")),
# so it never appears in argv. The broadcast is signed by that same key inside the script.
export DEPLOYER_PRIVATE_KEY; DEPLOYER_PRIVATE_KEY="$(owner_pk)"
export HUNTER_INITIAL_MINT="$INITIAL"
[[ -n "${HUNTER_MINT_TO:-}" ]] && export HUNTER_MINT_TO

FORGE_ARGS=(script script/DeployHunter.s.sol:DeployHunterScript
  --rpc-url "$RPC" --legacy --slow --sender "$OWNER" -vvv)
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: simulating (no --broadcast) ..."
else
  FORGE_ARGS+=(--broadcast)
fi

forge "${FORGE_ARGS[@]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run done — nothing deployed."
  exit 0
fi

# Pull the deployed address from the broadcast artifact (the CREATE of contract "Hunter").
RUN="broadcast/DeployHunter.s.sol/$CHAIN/run-latest.json"
NEW="$(jq -r '[.transactions[] | select(.contractName=="Hunter" and (.transactionType|ascii_upcase)=="CREATE")][0].contractAddress // empty' "$RUN")"
[[ -n "$NEW" ]] || { echo "error: could not read deployed address from $RUN" >&2; exit 1; }
NEW="$(checksum "$NEW")"

tmp="$(mktemp)"
jq --arg a "$NEW" '.address=$a' "$DEPLOYMENT_FILE" > "$tmp" && mv "$tmp" "$DEPLOYMENT_FILE"

echo
echo "deployed Hunter: $NEW"
echo "recorded in    : $DEPLOYMENT_FILE"
echo "explorer       : $EXPLORER/address/$NEW"
echo "next           : CHAIN=$CHAIN scripts/nft/hunter/mint.sh 0xW1 0xW2 0xW3"
