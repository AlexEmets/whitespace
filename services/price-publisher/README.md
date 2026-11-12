# @whitespace/price-publisher

Turns live exchange order books into k-of-N signed v2 price reports. The keeper fetches one
report per order from here and delivers it on chain; nothing else in the stack can produce a
price the contracts will accept.

```
 Binance ┐
 Bybit   ┤  WebSocket top of book        per feed                     every 1 s
 OKX     ┼──────────────────────► ticks ─► filter ─► weighted median ─► EMA mark
 WhiteBIT┤                                           (index, bid, ask)     │
 WhiteBIT perp ┘                                                           ▼
                        keeper ── GET /v2/report?feed&timestamp&orderType ──► gate ─► signed report
```

## How it works

- **Venues.** `main.mjs` opens one WebSocket per (market, venue) pair that the market declares
  a symbol for in `@whitespace/shared/markets`. BTC, ETH, SOL and XRP use Binance, Bybit, OKX
  and WhiteBIT spot; WBT/USD uses WhiteBIT spot and WhiteBIT's `WBT_PERP` book
  (`whitebit_perp`). Ticks are stamped with receipt time, not exchange time.
- **Liveness.** Each socket is pinged every 8 s and torn down (`terminate`, then reconnect after
  2 s) if no frame of any kind arrives for 20 s, which catches half-open connections. While
  frames keep arriving within 10 s, the last top of book is re-issued every 500 ms, so a quiet
  but live book does not age out.
- **Filter** (`aggregator.mjs`). A venue tick is rejected if it is older than the staleness
  bound, has an invalid quote (`bid <= 0`, `ask < bid`), has a spread wider than the spread
  bound, or deviates from the median of the *other* candidates by more than the deviation bound
  (leave-one-out). A single candidate has no peers and passes the deviation check.
- **Index.** Weighted median of the healthy mids (all venue weights are currently 1). The index
  bid and ask are weighted medians of the healthy bids and asks. Even counts take the lower
  middle value, never an average.
- **Mark.** A fixed-cadence EMA of the index, sampled every 1 s over a 10 s window
  (alpha = 2/11). A missed sample leaves the mark alone but does not refresh its age. A mark not
  moved for 3 sample intervals is **stale**; the next real index reseeds it instead of blending
  into the pre-gap value.
- **Report.** `price` is the mark, `bid`/`ask` are the index quotes (the mark when there is no
  two-sided quote). The report binds `chainId`, the verifier address, `feedId` and the order's
  `timestamp`, which is taken verbatim from the request and never replaced by the local clock.
  Every configured signer key signs; signatures are sorted by signer address.

Bounds live in `@whitespace/shared/bounds`, never at the use site:

| Bound | Default | WBT/USD |
|---|---|---|
| Venue staleness | 2 000 ms | 8 000 ms |
| Spread width | 10 bps | 10 bps |
| Deviation from other venues | 50 bps | 50 bps |
| Minimum healthy venues | 3 | 2 |
| Mark EMA window / sample | 10 s / 1 s | 10 s / 1 s |

### The do-not-sign gate

`/v2/report` refuses rather than signing a bad price:

| Status | `error` | When |
|---|---|---|
| 400 | `timestamp_too_old` / `timestamp_in_future` | timestamp outside `[now - MAX_REPORT_AGE_S, now + MAX_CLOCK_SKEW_S]` |
| 400 | — | missing `feed`/`timestamp`/`orderType`, or a non-integer timestamp |
| 404 | — | feed not in `PUBLISHER_MARKETS` |
| 409 | `no_healthy_venues` | zero healthy venues: nothing to price with |
| 409 | `degraded_opens_blocked` | `MARKET_OPEN`/`LIMIT_OPEN` while degraded; closes still sign |
| 409 | `no_mark_yet` / `mark_stale` | no mark sampled yet, or the mark is stale |
| 409 | `insufficient_signer_keys` | fewer keys loaded than `k` |

**Degraded** means fewer healthy venues than the market's minimum. Entering it has a 2 s grace
(a feed must be continuously below the minimum that long once it has been healthy); leaving it is
immediate. A feed starts degraded until it is first proven healthy. Unhandled errors in the
HTTP handler answer 500 instead of crashing the process.

## Configuration

Every variable is optional and read by `src/config.mjs`. See [`.env.example`](.env.example).

| Variable | Default | |
|---|---|---|
| `PUBLISHER_CHAIN_ID` | `deployments/1874.json` `chainId`, else `1874` | chain id bound into every report |
| `PUBLISHER_VERIFIER_ADDRESS` | `deployments/1874.json` `contracts.verifier` | **fatal at startup if neither is set** |
| `PUBLISHER_HOST` | `127.0.0.1` | `/v2/report` signs for anyone who can reach it; widen only behind an authenticating proxy |
| `PUBLISHER_PORT` | `8787` | |
| `PUBLISHER_MAX_REPORT_AGE_S` | `10` (the on-chain report `maxAge`) | non-negative integer |
| `PUBLISHER_MAX_CLOCK_SKEW_S` | `2` | non-negative integer |
| `PUBLISHER_MARKETS` | all of `MARKET_FEEDS` | comma-separated; **replaces** the registry, an unknown name is fatal |
| `PUBLISHER_VENUES` | all of `VENUE_IDS` | comma-separated; **replaces** the registry |
| `PUBLISHER_SIGNATURE_THRESHOLD_K` | `3` | |
| `PUBLISHER_SIGNER_KEY_PATHS` | `$HOME/.whitespace-keys/signer.json` | comma-separated role-key JSON files |

`PUBLISHER_MARKETS` and `PUBLISHER_VENUES` override the shared registries rather than extending
them. A pinned list is the usual reason a newly listed market never leaves degraded (or answers
404 to the keeper). At startup the publisher logs `MISCONFIGURED` for any market whose enabled
venues cannot reach its minimum, and `WARNING` when fewer signer keys than `k` are loaded; neither
is fatal.

Set `PUBLISHER_SIGNER_KEY_PATHS` explicitly under a service manager: with `HOME` unset the default
path becomes `undefined/.whitespace-keys/signer.json` and startup fails with `ENOENT`.

## Running locally

```bash
cp .env.example .env    # then edit; key files must exist
pnpm --filter @whitespace/price-publisher start
curl -s localhost:8787/status | jq
```

The publisher connects to the real exchanges; no RPC or chain access is needed. For a full local
stack on anvil, see `tools/stack/acceptance-anvil.sh` in the [root README](../../README.md#quick-start).

## Tests

```bash
pnpm --filter @whitespace/price-publisher test
```

Unit tests cover the aggregator, EMA, engine, degraded hysteresis, mark staleness, per-market
bounds, venue parsers, live-book refresh, venue liveness, config, metrics and the HTTP server.
They make no network calls; the WebSocket layer (`src/venues/index.mjs`) and `main.mjs` are
exercised only by a live run.

## Operations

| Endpoint | |
|---|---|
| `GET /health` | 200 while at least one feed has a healthy venue; **503 when no feed has any** (nothing can be signed). Degraded is still 200. |
| `GET /status` | per feed: `mark`, `markAgeMs`, `markStale`, `healthyCount`, `healthyVenues`, `minHealthyVenues`, `degraded`, `noData`, `index`, `indexBid`, `indexAsk` |
| `GET /metrics` | Prometheus text |
| `GET /v2/report` | see the gate above |

Metrics, labelled by `feed`: `publisher_healthy_venues`, `publisher_min_healthy_venues`,
`publisher_degraded`, `publisher_mark_age_seconds` (-1 before the first sample),
`publisher_mark_stale`, `publisher_reports_signed_total` (also `order_type`) and
`publisher_reports_refused_total` (also `reason`).

Failure behaviour:

- **One venue down:** it drops out of the median; the market continues on the rest.
- **Below the minimum:** degraded. Opens are refused, closes and other exits still sign.
  Logged every second as `DEGRADED: healthy=x/y`.
- **No venue at all, or no index for 3 s:** every report for that feed is refused; `/health`
  turns 503 once every feed is in that state.
- **Process crash:** the keeper gets no report, orders go unfilled and traders reclaim collateral
  through the timeout path. Under systemd the unit restarts after 5 s.

Related: [phase 3 decisions](../../docs/decisions/phase-3-price-publisher.md),
[oracle hardening](../../docs/decisions/phase-2-oracle-hardening.md),
[server runbook](../../docs/runbooks/deploy-server.md),
[design spec §5](../../docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md).
