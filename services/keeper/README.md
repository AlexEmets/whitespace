# @whitespace/keeper

Delivers a signed price for every order. The keeper watches `PriceRequestedV2` on the price
upkeep, fetches a report for that exact order from the price publisher, and submits it with
`performUpkeep`. Every order type that needs a price (`MARKET_OPEN`, `MARKET_CLOSE`,
`LIMIT_OPEN`, `LIMIT_CLOSE`, `REMOVE_COLLATERAL`) goes through it: without the keeper, nothing is
filled.

```
 trader ──openTrade()──► Trading ──► WhitespacePriceUpKeep ──PriceRequestedV2──┐
                                              ▲                                │ eth_getLogs
                                              │ performUpkeep(report, orderId) ▼
                                              └──────────────────────────── keeper
                                                                               │ GET /v2/report
                                                                               ▼
                                                                        price-publisher
```

## How it works

1. **Watch** (`watcher.mjs`). Every poll reads the chain head, then `eth_getLogs` for
   `PriceRequestedV2` from the cursor to the head, in windows of at most 9 000 blocks and at
   most 20 windows per poll. The orders in a window are handled `KEEPER_CONCURRENCY` at a time.
   The cursor advances, and is persisted, only after **every** order in the window has been
   handled. A failed poll leaves it untouched, so the same bounded window is read again.
2. **Fetch** (`keeperEngine.mjs`, `reportSource.mjs`). Each order has a deadline of its
   on-chain `timestamp` + 10 s (the report `maxAge`). The keeper asks the publisher for
   `feed`, `orderType` and that `timestamp`, taken verbatim from the log and never replaced by
   the local clock. A single request is abandoned after 2 s.
   - Retried with backoff (250 ms, doubling, capped at 2 s) while the deadline allows: network
     errors, 409 (degraded, no data, stale mark), 429, 5xx, and 400 `timestamp_in_future`
     (publisher clock behind the block).
   - Not retried: any other 400 and 404 (bad request, unknown feed, timestamp too old).
3. **Deliver** (`txSender.mjs` on [`@whitespace/txsender`](../../packages/txsender)). The report
   and order id are encoded into `performUpkeep` calldata and sent from the forwarder key with:
   - **pipeline mode**: nonces are allocated serially, but the next order is broadcast without
     waiting for the previous receipt, so a burst still lands inside its 10 s window;
   - **30% gas headroom** over the estimate, because pipelined estimates do not see the sends
     still in flight ahead of them;
   - **no retry on revert**: a revert means the upkeep's rails refused the report (stale,
     wrong timestamp, deviation, halt), and the same report would only revert again;
   - **a deadline**: nothing is broadcast or re-broadcast after it.

Every order ends in one of three outcomes:

| Outcome | Metric | |
|---|---|---|
| delivered | `keeper_orders_delivered_total` | `performUpkeep` mined successfully |
| given up | `keeper_orders_given_up_total` | expired before handling, no report before the deadline, a non-retryable refusal, or the delivery deadline passed |
| failed | `keeper_orders_failed_total` | the send was dead-lettered after its retries |

An order that is given up or fails stays pending on chain; the trader's collateral comes back
through the timeout reclaim. The keeper never retries it past its deadline.

### Cursor and restarts

With `KEEPER_CURSOR_PATH` set, the next block to scan is written atomically (temp file and
rename) after each window, and a restart resumes from it, clamped to at most
`KEEPER_MAX_LOOKBACK_BLOCKS` behind the head. Without it, or if the file is unreadable (logged as
`cursor file unreadable`), the keeper starts at the head and orders placed while it was down are
never filled.

## Configuration

Every variable is optional and read by `src/config.mjs`. See [`.env.example`](.env.example).
Numeric values are validated at startup; an invalid one is fatal.

| Variable | Default | |
|---|---|---|
| `KEEPER_CHAIN_ID` | `deployments/1874.json` `chainId`, else `1874` | logged at startup |
| `KEEPER_PRICE_UPKEEP_ADDRESS` | `deployments/1874.json` `contracts.priceUpKeep` | **fatal at startup if neither is set** |
| `KEEPER_RPC_URLS` | `https://rpc.testnet.whitechain.io` | comma-separated; more than one enables viem `fallback` failover |
| `KEEPER_PUBLISHER_URL` | `http://127.0.0.1:8787` | price-publisher base URL |
| `KEEPER_FORWARDER_KEY_PATH` | `$HOME/.whitespace-keys/keeper.json` | role key of the EOA that signs and pays for deliveries |
| `KEEPER_POLLING_INTERVAL_MS` | `1000` | integer ≥ 1 |
| `KEEPER_CONCURRENCY` | `16` | orders handled at once per window, integer ≥ 1 |
| `KEEPER_MAX_RETRIES` | `3` | send retries before a dead letter, integer ≥ 0 |
| `KEEPER_RECEIPT_TIMEOUT_MS` | `30000` | then the same nonce is re-broadcast at 1.2x gas |
| `KEEPER_MAX_GAS_BUMPS` | `3` | same-nonce replacements per attempt, integer ≥ 0 |
| `KEEPER_DEAD_LETTER_PATH` | unset: in memory only | JSON Lines, append-only |
| `KEEPER_CURSOR_PATH` | unset: not persisted | see above |
| `KEEPER_MAX_LOOKBACK_BLOCKS` | `300` | integer ≥ 1 |
| `KEEPER_METRICS_HOST` | `127.0.0.1` | `/metrics` exposes the forwarder's nonce and backlog |
| `KEEPER_METRICS_PORT` | `9465` | the liquidator uses 9464 |

Set `KEEPER_FORWARDER_KEY_PATH` explicitly under a service manager: with `HOME` unset the default
path becomes `undefined/.whitespace-keys/keeper.json` and startup fails with `ENOENT`. The key is
never logged; only the derived forwarder address is.

## Running locally

```bash
cp .env.example .env    # then edit; the forwarder key file must exist and hold gas
pnpm --filter @whitespace/price-publisher start &
pnpm --filter @whitespace/keeper start
curl -s localhost:9465/health | jq
```

For a full local stack on anvil, see `tools/stack/acceptance-anvil.sh` in the
[root README](../../README.md#quick-start).

## Tests

```bash
pnpm --filter @whitespace/keeper test
```

Unit tests use mock clients and a fake publisher: config validation, cursor persistence, the
watcher's range chunking, cursor and concurrency, the engine's retry and deadline rules, the
report sources and the tx sender wiring. `main.mjs` and `rpc.mjs` are exercised only by a live
run.

## Operations

| Endpoint | |
|---|---|
| `GET /health` | 200 while polling succeeds; **503 before the first successful poll or once the last one is older than max(30 s, 10 × polling interval)**. Body: `cursor`, `head`, `lastPollAgeMs`, `staleAfterMs`, `nonce`, `queued`, `deadLetters`. |
| `GET /metrics` | Prometheus text |

Metrics: `keeper_price_requests_total`, `keeper_orders_delivered_total`,
`keeper_orders_failed_total`, `keeper_orders_given_up_total`, `keeper_report_retries_total`,
`keeper_watcher_errors_total`, `keeper_cursor_block`, `keeper_head_block`,
`keeper_last_poll_age_seconds` (-1 before the first poll), plus the sender's `keeper_tx_*`,
`keeper_nonce_resyncs_total`, `keeper_dead_letter_depth` and `keeper_queue_depth`.

Things that matter in practice:

- **The forwarder pays gas for every delivery.** When it runs dry, orders stay pending. Check its
  balance first when fills stop.
- **RPC rate limits** show up as watcher errors and late orders: an order seen after its 10 s
  window is given up immediately.
- **Publisher refusals** (`degraded_opens_blocked`, `mark_stale`) are retried until the deadline,
  then given up; closes are not blocked by a degraded feed.
- **Dead letters** are kept in `KEEPER_DEAD_LETTER_PATH`. `retryDeadLetters()` exists on the
  sender but the service never calls it on its own.
- Logs are prefixed `[keeper]`; `GAVE UP` and `FAILED` lines name the `orderId` and the reason.

Related: [phase 3 decisions](../../docs/decisions/phase-3-price-publisher.md),
[server runbook](../../docs/runbooks/deploy-server.md),
[price publisher](../price-publisher/README.md),
[design spec §5.1](../../docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md).
