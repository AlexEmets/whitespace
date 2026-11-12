# @whitespace/liquidator

The automation bot. It watches every open position and every resting LIMIT/STOP entry and
fires the triggers the contracts will not fire on their own: **liquidations, take-profits,
stop-losses and limit/stop entries**, all through `WhitespaceTradesUpKeep.performUpkeep`.
Production runs two instances side by side, each with its own allowlisted forwarder key.

```
indexer Postgres ──candidates──► sweep ──re-read slot──► chain (TradingStorage, PairInfos, …)
price-publisher /status ─prices─►  │
                                   ▼  triggerRules + gates
                     performUpkeep(SimplifiedTradeId[], timestamp) ──► TradesUpKeep
                                   │
          keeper delivers a signed report for the request ──► callback fills or cancels
```

Each trigger is only a price request. The fill still happens in the callback, against a
freshly signed report, and the callback runs its own hit check. A trigger that was wrong
comes back cancelled (`NOT_HIT`). It does not fill at a bad price.

## How a sweep works

`src/automationEngine.mjs`, scheduled by a single-flight loop (`src/sweepLoop.mjs`): the
next sweep starts `LIQUIDATOR_POLLING_INTERVAL_MS` after the previous one *ends*, and two
sweeps never overlap.

1. **Candidates** come from the indexer's `position` and `limit_order` tables, read fresh
   every sweep, so nothing is kept in memory between sweeps. A database failure fails the
   whole sweep, because acting on a partial view would silently skip positions. A missing
   `limit_order` table only disables LIMIT/STOP automation (logged once, and published as
   `liquidator_limit_order_table_available`).
2. **One publisher `/status` snapshot** gives the mark and bid/ask a report would carry
   right now. A feed the publisher marks `markStale`/`noData` is treated as untradeable.
3. **Per candidate**, up to `LIQUIDATOR_EVALUATION_CONCURRENCY` at a time and isolated, so a
   failed read costs that candidate and not the sweep:
   - the slot is re-read from chain, and a slot that is gone is skipped (lost race, indexer
     lag, reorg);
   - `src/triggerRules.mjs` decides with the contract's own hit conditions on chain values;
   - per-kind gates apply (table below), and triggers that would come back
     `BACKDATED_EXECUTION`, `NO_TP`, `NO_SL` or `PENDING_TRIGGER` are skipped.
4. **Dedupe** by `(trader, pair, index, kind)`, chunk into batches of at most
   `LIQUIDATOR_MAX_BATCH_SIZE`, and send them all at once (pipelined).

Rules worth knowing:

- **At most one close kind per position**, in LIQ > SL > TP order. When LIQ is hit but
  gated, SL and TP are held back too, because the callback would turn them into a
  liquidation anyway.
- **The trigger timestamp is taken just before each send.** It becomes the request
  timestamp, and the price upkeep rejects a report older than `maxAge` (10 s). Each send
  carries a deadline `LIQUIDATOR_DELIVERY_MARGIN_SEC` short of that window. Nothing is
  broadcast after the deadline, and an expired send is counted, not dead-lettered.
- **Cooldown.** A sent key (success or failure) is not re-sent for
  `LIQUIDATOR_TRIGGER_COOLDOWN_MS`. LIMIT/STOP entries that the callback keeps cancelling
  back off exponentially up to `LIQUIDATOR_OPEN_BACKOFF_MAX_MS`. Close kinds never back off.
- **Batch isolation.** If a multi-trigger batch reverts, its keys go out one per
  transaction on the next sweep, and only the key that then reverts alone is cooled down.
- **Gas self-check.** Below `LIQUIDATOR_MIN_GAS_BALANCE_WEI` the instance sends nothing and
  logs `FORWARDER … OUT OF GAS`. If the balance read itself fails, sending continues.

### Gates per kind (`src/degradedMode.mjs`)

| | sequencer STALLED | RECOVERING | degraded market |
|---|---|---|---|
| LIQ | blocked | blocked | blocked unless `LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED` |
| SL, TP | blocked | allowed | allowed |
| OPEN (LIMIT/STOP) | blocked | allowed | blocked (the publisher will not sign opens) |

The sequencer state (`src/sequencerLiveness.mjs`) comes only from block timestamps. A head
older than the stall threshold means STALLED. After blocks resume, the state stays
RECOVERING for the recovery window. Failing to reach our own RPC is not treated as a stall.

### Two instances

Each trigger key has one owner, picked by an FNV-1a hash of the key modulo
`LIQUIDATOR_INSTANCE_COUNT`, and the owner sends it at once. The other instance holds back
and takes over only if the trigger is still hit and still not pending on chain
`LIQUIDATOR_TAKEOVER_MS` after it first saw it. That happens when the owner is down, out of
gas or stuck. With the default count of 1, an instance owns everything. If two such
instances run together, both fire every trigger, and the one that loses the race gets a
`PENDING_TRIGGER`/`NO_TRADE` status back. That costs gas but does not revert.

### Transactions

Every send goes through [`@whitespace/txsender`](../../packages/txsender), which keeps one
nonce queue per forwarder key. This service runs it in pipeline mode with a 4 s receipt
timeout and at most 2 same-nonce bumps. Reverts are not retried: the next sweep decides
again from chain state. Batches that run out of retries go to the dead letter.

## Configuration

Environment only (`src/config.mjs`). Contract addresses fall back to
[`deployments/1874.json`](../../deployments/1874.json), and startup fails if an address is
in neither place. A malformed number or boolean also fails startup.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | **required** | The indexer's Postgres |
| `LIQUIDATOR_FORWARDER_KEY_PATH` | **required** | Role key file (`~/.whitespace-keys/<role>.json`, `[{ address, private_key }]`); the key is never logged |
| `DATABASE_SCHEMA` | `public` | Schema the indexer's tables are read from |
| `LIQUIDATOR_INSTANCE_NAME` | `automation-bot` | Log prefix |
| `LIQUIDATOR_INSTANCE_COUNT` | `1` | Instances that split the triggers |
| `LIQUIDATOR_INSTANCE_INDEX` | from `LIQUIDATOR_INSTANCE_ID`, else `0` | This instance's slot, below the count |
| `LIQUIDATOR_INSTANCE_ID` | – | One letter: `a` → index 0, `b` → index 1 (set by the systemd template) |
| `LIQUIDATOR_TAKEOVER_MS` | `10000` | Delay before taking over the other instance's triggers |
| `LIQUIDATOR_RPC_URLS` | `https://rpc.testnet.whitechain.io` | Comma-separated; viem `fallback()` when more than one |
| `LIQUIDATOR_PUBLISHER_URL` | `http://127.0.0.1:8787` | price-publisher base URL (`/status`) |
| `LIQUIDATOR_CHAIN_ID` | manifest `chainId`, else `1874` | |
| `LIQUIDATOR_{TRADES_UPKEEP,TRADING,TRADING_STORAGE,PAIR_INFOS,PAIRS_STORAGE}_ADDRESS` | manifest | |
| `LIQUIDATOR_POLLING_INTERVAL_MS` | `2000` | Pause between sweeps; also the liveness poll interval |
| `LIQUIDATOR_MAX_BATCH_SIZE` | `20` | Triggers per `performUpkeep` |
| `LIQUIDATOR_TRIGGER_COOLDOWN_MS` | `30000` | No re-send of a key for this long |
| `LIQUIDATOR_OPEN_BACKOFF_MAX_MS` | `900000` | Ceiling of the LIMIT/STOP backoff |
| `LIQUIDATOR_REPORT_MAX_AGE_SEC` | `10` | Must match `WhitespacePriceUpKeep.maxAge` |
| `LIQUIDATOR_DELIVERY_MARGIN_SEC` | `4` | Part of that window left for the keeper |
| `LIQUIDATOR_EVALUATION_CONCURRENCY` | `16` | Candidates evaluated at once |
| `LIQUIDATOR_MAX_RETRIES` | `3` | Send retries before dead-lettering |
| `LIQUIDATOR_RECEIPT_TIMEOUT_MS` | `4000` | Before a same-nonce replacement |
| `LIQUIDATOR_MIN_GAS_BALANCE_WEI` | `10000000000000000` (0.01 WBT) | Below this, send nothing |
| `LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED` | `false` | Allow LIQ while a market is degraded |
| `LIQUIDATOR_SEQUENCER_STALL_THRESHOLD_MS` | `30000` | Head age that counts as a stall |
| `LIQUIDATOR_SEQUENCER_RECOVERY_WINDOW_MS` | `300000` | LIQ hold-off after blocks resume |
| `LIQUIDATOR_MAX_INDEXER_LAG_SEC` | `30` | Warn when the indexer is further behind |
| `LIQUIDATOR_DB_CONNECT_TIMEOUT_MS` | `3000` | |
| `LIQUIDATOR_DB_STATEMENT_TIMEOUT_MS` | `5000` | |
| `LIQUIDATOR_DEAD_LETTER_PATH` | in memory only | JSON Lines dead-letter file |
| `LIQUIDATOR_METRICS_HOST` / `_PORT` | `127.0.0.1` / `9464` | Must differ per instance on one host |
| `LIQUIDATOR_HEALTH_MAX_SWEEP_AGE_MS` | `60000` | `/health` fails after this long without a sweep |

[`.env.example`](.env.example) is annotated per variable. Note that it sets
`LIQUIDATOR_LIQUIDATE_WHEN_DEGRADED=true`, and its comment still describes `true` as the
default. The code default is `false`.

## Running locally

```bash
# needs a synced indexer database and a running price-publisher
cp services/liquidator/.env.example services/liquidator/.env.a   # edit key path, DB, port
cd services/liquidator && node --env-file=.env.a src/main.mjs
```

On startup the bot logs its configuration (the database password is removed) and its
forwarder address. Use a second env file with a different key, metrics port and dead-letter
path to run a second instance. The full local stack, both bots included, is booted by
`tools/stack/acceptance-anvil.sh run` (see the [root README](../../README.md#quick-start)).

## Tests

```bash
pnpm --filter @whitespace/liquidator test     # node --test, no network
```

## Operations

- **Endpoints:** `GET /health` returns 200 `{ ok, lastSweepAgeMs }`, or 503 once no sweep has
  completed for `LIQUIDATOR_HEALTH_MAX_SWEEP_AGE_MS`, so a stuck sweep is reported as down.
  `GET /metrics` returns Prometheus text.
- **Key metrics:** `liquidator_triggers_{attempted,sent,failed,expired}_total`,
  `liquidator_takeovers_total`, `liquidator_gas_low`, `liquidator_forwarder_balance`,
  `liquidator_indexer_lag_{blocks,seconds}`, `liquidator_sequencer_state`,
  `liquidator_rpc_healthy{endpoint}` (scheme and host only), `liquidator_dead_letter_depth`,
  and the shared sender's `liquidator_tx_*` counters.
- **Gas:** each forwarder pays for its own triggers, so its balance goes down over time.
  Watch `liquidator_gas_low` and top it up. While one instance is out of gas, the other
  takes over its triggers.
- **Indexer lag:** a lagging indexer never causes a wrong trigger, but a position opened
  after the indexer's last block is not a candidate yet. The lag is published every sweep.
- **Shutdown:** SIGTERM/SIGINT stop scheduling, give an in-flight sweep up to 20 s to
  finish, then exit 0. A fatal startup error exits 1.
- **systemd:** `deploy/systemd/whitespace-bot@.service` is a template. Instances `a` and
  `b` read `services/liquidator/.env.<instance>` and get `LIQUIDATOR_INSTANCE_COUNT=2`
  and `LIQUIDATOR_INSTANCE_ID=%i`. See
  [`docs/runbooks/deploy-server.md`](../../docs/runbooks/deploy-server.md).

Design and history: [`docs/decisions/phase-6-liquidator.md`](../../docs/decisions/phase-6-liquidator.md)
(§11 covers the automation bot).
