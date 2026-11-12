# @whitespace/api

The read API behind the terminal: REST and WebSocket over the Postgres database that
[`services/indexer`](../indexer) writes. Live index and mark prices come from
[`services/price-publisher`](../price-publisher). The API has one write endpoint,
`POST /faucet/wbt`, which sends native gas to new wallets.

```
apps/web ──HTTP / WS──► services/api ──SQL──► Postgres (indexer schema + api_series + api_faucet)
                              │
                              └──GET /status──► price-publisher (live index/mark, index candles)
```

Plain `node:http` with a small router (`src/router.ts`), `ws` for WebSocket, and `pg`. All
responses are JSON. Every amount is a decimal string, and `NUMERIC` values never become JS
floats.

## Endpoints

The route list has one source of truth:
[`packages/shared/src/api.mjs`](../../packages/shared/src/api.mjs) (`API_ENDPOINTS`,
`WS_CHANNELS`, `WS_LIMITS`). The web app renders it as the public reference at `/docs/api`
(`apps/web/src/app/docs/api/page.tsx`). `test/apiReference.test.ts` checks it against the
running server: the same routes as `registeredRoutes()`, the same `?limit=` defaults and
maximums, the same candle and health thresholds, and the same WebSocket channels and
limits. A route or limit changed on only one side fails the suite.

| Group | Routes |
|---|---|
| Markets & prices | `GET /markets`, `/markets/:pairIndex`, `/markets/:pairIndex/candles`, `/price/:pairIndex` |
| Wallets | `GET /positions/:address`, `/positions/:address/history`, `/orders/:address`, `/orders/:address/history`, `/limit-orders/:address`, `/fees/:address`, `/pnl/:address` |
| Points | `GET /points/leaderboard`, `/points/:address` |
| LP vault | `GET /vault/settlements` |
| Status | `GET /health`, and `POST /faucet/wbt` (internal; left out of the public reference) |

Behaviour that applies across routes:

- **Errors.** A bad path parameter or `?limit=` returns 400, and an unknown route returns
  404. Any other failure returns 500 `{ "error": "internal error" }`, and the detail is
  logged on the server, not returned to the caller.
- **CORS.** Only origins in `CORS_ALLOWED_ORIGINS` are allowed, and the matching origin is
  echoed back (never `*`).
- **Prices.** `/price/:pairIndex` prefers the publisher's live index and mark. If the
  publisher cannot be reached, it falls back to the last on-chain report, and the
  `source` field says which one answered. The publisher response is cached for 900 ms.
- **Candles.** The chart uses the index series that the API records itself. When that
  series has no data, the indexer's trade/report `candle` table is used instead.
- **Health.** `GET /health` reads the indexer's `sync_status`. It returns `ok`,
  `degraded` when the lag is over 30 s, or `down` when the lag is over 5 min or there is no
  row.

### WebSocket

Connect to `/ws` and send `{ "type": "subscribe" | "unsubscribe", "channel": "<channel>" }`.
The channels are `price:<pairIndex>`, `candles:<pairIndex>:<interval>`,
`positions:<address>`, `orders:<address>`, `limitOrders:<address>` and `fees:<address>`.
Each carries the same payload as the matching REST route. The server polls every subscribed
channel every 2 s and pushes `{ type: "update", channel, data }` only when the payload has
changed. There are no Postgres notifications.

Limits: 64 subscriptions per socket, 20 sockets per client (IPv4 address or IPv6 /64),
1000 in total. A refused connection is closed with code 1013. Messages over 4 KiB close the
socket. A ping every 30 s keeps proxied connections open, and a client that misses a pong
is terminated.

### Faucet

`POST /faucet/wbt` with `{ "address": "0x…" }` sends `FAUCET_WBT_AMOUNT` native WBT from a
server-side key, so that a new wallet can pay for its first transaction. Each address and
each client IP gets one claim per `FAUCET_COOLDOWN_HOURS`. The client IP is the last
`X-Forwarded-For` entry, which is the one Caddy appends. Concurrent claims are serialized
with advisory locks. The responses are:

- 503 when the faucet is disabled, has no key, or is out of funds;
- 429 when the cooldown is active;
- 502 on an RPC or send failure.

## Background work (long-running process only)

When started as a server (`src/server.ts` run directly, not `createApp()`), the API:

1. creates its own schemas `api_series` (index candles) and `api_faucet` (claims), retrying
   with backoff up to 30 s between attempts while Postgres is unavailable. The HTTP server
   listens in the meantime;
2. starts the **index recorder**, which samples the publisher's mark for every market every
   5 s and upserts OHLC rows for each candle interval. Feeds that are degraded or have no
   data produce no tick, so an outage shows as a gap in the chart.

These two schemas belong to the API and are not touched by indexer redeploys.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | **required** | Read lazily on the first query: without it the process starts, but every data route returns 500 |
| `INDEXER_SCHEMA` | `public` | Schema (or stable views schema) the indexer writes to; bare lowercase identifier |
| `PORT` | `3001` | Only when run directly |
| `HOST` | `127.0.0.1` | `0.0.0.0` must be set explicitly |
| `CHAIN_ID` | `1874` | Selects the `sync_status` row and the faucet chain |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100` | Comma-separated |
| `PUBLISHER_URL` | `http://127.0.0.1:8787` | An empty string turns the publisher client off (on-chain fallback only) |
| `PG_POOL_MAX` | `10` | |
| `PG_CONNECT_TIMEOUT_MS` | `5000` | |
| `PG_STATEMENT_TIMEOUT_MS` | `15000` | Server-side, per statement |
| `PG_IDLE_TIMEOUT_MS` | `30000` | |
| `FAUCET_WBT_ENABLED` | `true` | Only the exact value `false` disables it |
| `FAUCET_WBT_AMOUNT` | `0.3` | WBT per claim |
| `FAUCET_COOLDOWN_HOURS` | `24` | |
| `FAUCET_KEY_PATH` | `~/.whitespace-keys/faucet.json` | Role key file; never logged |
| `FAUCET_RPC_URLS` | `https://rpc.testnet.whitechain.io` | Comma-separated; the first is used to send |

[`.env.example`](.env.example) covers the core variables. Its header says those are every
variable the API reads, which is no longer true: the `PG_*` and `FAUCET_*` variables above
are not in it.

## Running locally

```bash
docker compose up -d postgres                     # the indexer must be writing to it
cp services/api/.env.example services/api/.env
cd services/api
set -a && . ./.env && set +a
pnpm dev                                          # tsx watch src/server.ts; `pnpm start` without watch
curl -s localhost:${PORT:-3001}/health
```

`.env.example` sets `PORT=4000`, while the code default is 3001. `PORT` must match the API
URL that `apps/web` is configured with.

## Tests

```bash
pnpm --filter @whitespace/api test     # vitest run
```

The suite runs against a **real, temporary Postgres**. `test/globalSetup.ts` starts one
with the local `initdb`/`pg_ctl`/`psql` binaries, so those must be on `PATH`. Set
`TEST_DATABASE_URL` to use an existing database instead. The test files run one at a time
against that single database. `PUBLISHER_URL` is set to empty, so price tests use the
on-chain fallback unless a test starts its own publisher stub.

## Operations

- Bind to loopback. In production only Caddy reaches the API.
- SIGTERM/SIGINT stop the recorder and close the server. A bind error such as `EADDRINUSE`
  exits 1 so that systemd restarts the service.
- systemd: `deploy/systemd/whitespace-api.service` runs `tsx src/server.ts` with
  `services/api/.env`. See [`docs/runbooks/deploy-server.md`](../../docs/runbooks/deploy-server.md).
- In production `INDEXER_SCHEMA` points at the indexer's stable `ws1874` views, so an
  indexer redeploy does not change what the API reads.

Design notes, decimal precision and WebSocket trade-offs:
[`docs/decisions/phase-4-indexer-api.md`](../../docs/decisions/phase-4-indexer-api.md).
