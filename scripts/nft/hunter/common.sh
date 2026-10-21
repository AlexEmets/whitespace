#!/usr/bin/env bash
# Shared setup for the Hunter bug-bounty NFT scripts (contracts/src/nft/Hunter.sol).
# Sourced by deploy.sh / mint.sh / holders.sh — not meant to be run on its own.
#
# Chain is selected with CHAIN (default 1874 = Whitechain testnet; 1875 = mainnet). Each chain
# has its own deployments/hunter-<CHAIN>.json — the same file the frontend reads for testnet —
# so there is one source of truth per chain and nothing to pass on the command line. The owner
# key is read from a 0600 file on demand, so it never has to be typed into a command.

set -euo pipefail

export PATH="$PATH:$HOME/.foundry/bin"

# --- locations ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OWNER_KEY_FILE="${HUNTER_OWNER_KEY_FILE:-$HOME/.whitespace-keys/owner.json}"

# --- chain / contract --------------------------------------------------------------------
CHAIN="${CHAIN:-1874}"
case "$CHAIN" in
  1874) DEFAULT_RPC="https://rpc.testnet.whitechain.io"; EXPLORER="https://explorer.testnet.whitechain.io" ;;
  1875) DEFAULT_RPC="https://rpc.whitechain.io";         EXPLORER="https://explorer.whitechain.io" ;;
  *) echo "error: unknown CHAIN='$CHAIN' (use 1874 testnet or 1875 mainnet)" >&2; exit 1 ;;
esac
RPC="${WHITESPACE_RPC:-$DEFAULT_RPC}"
CHAIN_ID="$CHAIN"
DEPLOYMENT_FILE="$REPO_ROOT/deployments/hunter-$CHAIN.json"

for bin in cast jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' not found in PATH" >&2; exit 1; }
done

# Contract address for this chain. May be zero/empty before the first deploy — deploy.sh runs
# fine in that state; mint.sh / holders.sh call require_deployed to refuse until it is set.
ZERO=0x0000000000000000000000000000000000000000
HUNTER=""
HUNTER_DEPLOYED=0
if [[ -f "$DEPLOYMENT_FILE" ]]; then
  HUNTER="$(jq -r '.address // ""' "$DEPLOYMENT_FILE")"
  [[ -n "$HUNTER" && "$HUNTER" != "null" && "${HUNTER,,}" != "$ZERO" ]] && HUNTER_DEPLOYED=1
fi

# --- helpers -----------------------------------------------------------------------------

# Refuse to continue unless a contract is recorded for this chain. mint/holders need it.
require_deployed() {
  if [[ "$HUNTER_DEPLOYED" -ne 1 ]]; then
    echo "error: Hunter is not deployed on chain $CHAIN." >&2
    echo "       $DEPLOYMENT_FILE has a zero/empty address. Run deploy.sh first:" >&2
    echo "         CHAIN=$CHAIN scripts/nft/hunter/deploy.sh" >&2
    exit 1
  fi
}

# Echo the owner private key read from the 0600 json file. Used only as `$(owner_pk)` inside a
# --private-key argument (or via DEPLOYER_PRIVATE_KEY env for forge), so the key stays out of
# shell history and script text.
owner_pk() {
  [[ -f "$OWNER_KEY_FILE" ]] || { echo "error: owner key file $OWNER_KEY_FILE not found" >&2; return 1; }
  jq -r 'if type=="array" then .[0].private_key else .private_key end' "$OWNER_KEY_FILE"
}

# Echo the owner address (public) from the same file.
owner_addr() {
  jq -r 'if type=="array" then .[0].address else .address end' "$OWNER_KEY_FILE"
}

# Validate + checksum an address. Exits the script on anything that is not a 20-byte address.
checksum() {
  cast to-check-sum-address "$1" 2>/dev/null || { echo "error: invalid address: $1" >&2; exit 1; }
}

# Read-only contract calls.
h_call() { cast call "$HUNTER" "$@" --rpc-url "$RPC"; }
total_minted() { h_call 'totalMinted()(uint256)'; }
remaining()    { h_call 'remaining()(uint256)'; }
