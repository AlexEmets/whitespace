#!/usr/bin/env bash
# Alerts before the stack stalls for want of gas or disk.
#
# The keeper pays gas for every price delivery and the two automation bots for every trigger.
# When one of them runs dry nothing fails loudly — orders just stop filling and positions stop
# being liquidated — so this checks their WBT balances (and the disk) every 30 minutes from a
# systemd timer and posts to Telegram when something is below its floor.
#
# Config (deploy/alerts.env, not committed):
#   RPC_URL               upstream JSON-RPC (default: the public 1874 endpoint)
#   WATCH_ADDRESSES       "name=0xaddr name=0xaddr ..."
#   MIN_BALANCE_WEI       floor per address (default 0.02 WBT)
#   DISK_MAX_PERCENT      alert above this root-fs usage (default 85)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   optional; without them alerts go to the journal only
set -euo pipefail

main() {
  local here
  here=$(cd "$(dirname "$0")" && pwd)
  [ -f "$here/alerts.env" ] && . "$here/alerts.env"

  local rpc=${RPC_URL:-https://rpc.testnet.whitechain.io}
  local floor=${MIN_BALANCE_WEI:-20000000000000000}
  local disk_max=${DISK_MAX_PERCENT:-85}
  local problems=()

  for entry in ${WATCH_ADDRESSES:-}; do
    local name=${entry%%=*} addr=${entry#*=}
    local hex wei
    if ! hex=$(balance_hex "$rpc" "$addr"); then
      problems+=("$name ($addr): balance unreadable from $rpc")
      continue
    fi
    wei=$(hex_to_dec "$hex")
    if [ "$(compare "$wei" "$floor")" = "lt" ]; then
      problems+=("$name ($addr): $(to_eth "$wei") WBT, below $(to_eth "$floor")")
    fi
  done

  local used
  used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  if [ "$used" -gt "$disk_max" ]; then
    problems+=("disk: / is ${used}% full (threshold ${disk_max}%)")
  fi

  if [ ${#problems[@]} -eq 0 ]; then
    echo "ok: all balances above floor, disk ${used}%"
    return 0
  fi

  local text
  text=$(printf 'Whitespace testnet alert (%s)\n' "$(hostname)"; printf -- '- %s\n' "${problems[@]}")
  echo "$text" >&2
  notify "$text"
  return 1
}

balance_hex() {
  local body
  body=$(curl -fsS --max-time 10 -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$2\",\"latest\"]}" "$1") || return 1
  local result
  result=$(printf '%s' "$body" | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
  [ -n "$result" ] || return 1
  printf '%s' "$result"
}

# Arbitrary-precision via python3: balances overflow bash's 64-bit arithmetic.
hex_to_dec() { python3 -c "print(int('$1', 16))"; }
compare() { python3 -c "a,b=$1,$2; print('lt' if a<b else 'ge')"; }
to_eth() { python3 -c "print(f'{$1/10**18:.4f}')"; }

notify() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "(telegram not configured; alert logged only)" >&2
    return 0
  fi
  curl -fsS --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null || echo "telegram send failed" >&2
}

main "$@"
