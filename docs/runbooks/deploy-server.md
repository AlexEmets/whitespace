# Runbook: the testnet server

The host every `deploy/systemd/*.service` points its `Documentation=` at.

## Host

Hetzner CPX12 (1 vCPU / 2 GB + 2 GB swap), Ubuntu, user `whitespace`, repo at
`/home/whitespace/whitespace`. Caddy terminates TLS for `www.whitespace.finance` with a
direct A record (`deploy/Caddyfile`); ufw opens only 22, 80, 443.

**Only Caddy listens on a public interface.** Every service binds 127.0.0.1:

| unit | port | bind set by |
|---|---|---|
| whitespace-web | 3000 | `next start -H 127.0.0.1` (unit) |
| whitespace-api | 4000 | `HOST` env, default 127.0.0.1 |
| eRPC (docker) | 4001 | `docker-compose.yml` `127.0.0.1:4001` |
| Postgres (docker) | 5433 | `docker-compose.yml` `127.0.0.1:5433` |
| whitespace-publisher | 8787 | `PUBLISHER_HOST`, default 127.0.0.1 |
| whitespace-keeper metrics | 9465 | `KEEPER_METRICS_HOST`, default 127.0.0.1 |
| whitespace-bot@a / @b metrics | 9466 / 9467 | `LIQUIDATOR_METRICS_HOST`, default 127.0.0.1 |
| whitespace-indexer (Ponder) | 42069 | `ponder start --hostname 127.0.0.1` (unit) |

Check after any change: `ss -ltnp | grep -v 127.0.0.1` must list only Caddy (and sshd).

## Units

```
whitespace-publisher   price publisher (5 signer keys, k=3)
whitespace-keeper      delivers reports for every PriceRequestedV2
whitespace-indexer     Ponder → Postgres
whitespace-api         REST + WS
whitespace-web         Next.js
whitespace-bot@a/@b    automation: liquidations, TP/SL, limit/stop entries
whitespace-balances.timer   gas + disk check every 30 min (deploy/check-balances.sh)
whitespace-backup.timer     daily pg_dump of api_series (deploy/backup-api-series.sh)
```

`deploy.sh` installs the unit files itself whenever `deploy/systemd/` changed since it last
did (one `sudo cp deploy/systemd/<file> /etc/systemd/system/<file>` per file, then
`sudo systemctl daemon-reload`; the commit is recorded in `~/.whitespace-deploy/units.sha`).
First install, or by hand:

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whitespace-bot@a whitespace-bot@b whitespace-balances.timer whitespace-backup.timer
```

`/etc/sudoers.d/whitespace` must allow single-unit `systemctl start|stop|restart|is-active`
for every unit above, including `whitespace-bot@a` and `whitespace-bot@b`, plus
`systemctl daemon-reload` and, for each file in `deploy/systemd/`, exactly
`/usr/bin/cp deploy/systemd/<file> /etc/systemd/system/<file>` (sudoers matches the whole
command, so list each file).

## Memory budget

The box has 1909 MB usable. Limits are set in two places that must add up together:

| what | soft (MemoryHigh) | hard | V8 heap |
|---|---|---|---|
| Postgres (docker) | — | `mem_limit` 600m (+600m swap), `oom_score_adj -900` | — |
| eRPC (docker) | — | `mem_limit` 160m | — |
| indexer | 272M | 320M | 208 |
| web | 184M | 240M | 144 |
| api | 136M | 176M | 104 |
| publisher | 80M | 96M | 56 |
| keeper | 88M | 104M | 64 |
| bot@a, bot@b | 88M each | 104M each | 64 |

Hard limits sum to 1904 MB, soft limits to 1696 MB. Postgres runs with
`max_connections=60, shared_buffers=128MB, work_mem=4MB` (`docker-compose.yml`); its
clients use at most 12 (Ponder, `PONDER_DB_POOL_MAX`) + 10 (API, `PG_POOL_MAX`) + 2 per bot.
`node --test deploy/test/*.test.mjs` checks all of this; run it after changing any limit.

A changed `docker-compose.yml` only applies once the container is recreated (data volume
kept): `docker compose up -d postgres` (and `docker compose --profile hosted up -d erpc`).
Check with `docker inspect whitespace-postgres --format '{{.HostConfig.Memory}} {{.Config.Cmd}}'`.

If Postgres is in a crash/recovery loop (`docker logs whitespace-postgres` shows
"terminated by signal 9" / "database system was interrupted"): check `dmesg | grep -i oom`
for the victim, stop the bots and web to free memory, let recovery finish, then bring units
back one at a time. The API retries its schema setup and keeps serving through a restart;
it no longer needs restarting after Postgres comes back.

## Indexer schemas (the views pattern)

Ponder will not start in a schema another build created, so every indexer build writes its own
schema, `ws1874_<sha>` (`deploy/indexer-schema.sh`, written to `services/indexer/.env.build` by
`deploy.sh`). `ponder start --views-schema ws1874` repoints the stable views in `ws1874` at the
new build once it has synced. **Readers only ever use `ws1874`:** the API via
`INDEXER_SCHEMA=ws1874`, the bots via `DATABASE_SCHEMA=ws1874`. During a resync the views still
show the previous build. Old build schemas can be removed with `ponder db prune`.

## Secrets

Keys live in `~/.whitespace-keys/` (dir 700, files 600): `keeper.json`, `signer*.json`,
`bot-a.json`, `bot-b.json`. Deploy-time keys (owner, gov, manager, lp) are **not** kept on
the box. `deploy/alerts.env` (git-ignored) holds the Telegram token for alerts.

## Routine deploy

`deploy/deploy.sh` as `whitespace`: pull, install, install changed unit files, build web
with web+indexer stopped, restart api/indexer/web/bots — and the publisher and keeper only
when something they run changed since they last came up (their code, the packages they
use, `pnpm-lock.yaml` or their unit file; recorded in `~/.whitespace-deploy/*.sha`, so a
deploy that failed before restarting them still restarts them next time). To force one:
`rm ~/.whitespace-deploy/publisher.sha`. Then verify every unit and timer is `active`
and that the web process started after the build it serves. It exits non-zero on any
failure — and if it fails while web and indexer are stopped, an exit trap starts the
indexer again, and web too when `apps/web/.next/BUILD_ID` exists (otherwise it prints the
rebuild command; the site is down until then). `node --test deploy/test/*.test.mjs` runs
the script against a scratch clone with stubbed sudo/systemctl/pnpm.

## Log limits

Install once per host (and again if `deploy/journald` or `deploy/logrotate` change):

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo cp deploy/journald/whitespace.conf /etc/systemd/journald.conf.d/whitespace.conf
sudo systemctl restart systemd-journald
sudo cp deploy/logrotate/rsyslog /etc/logrotate.d/rsyslog
```

**Why (2026-10-09 outage).** journald forwarded every service line to rsyslog, which rotated
`/var/log/syslog` weekly with no size cap. RPC rate-limit stack traces from Ponder and the
bots grew it to 28 GB, the disk hit 100%, Postgres could not write WAL and crash-looped
("database system is in recovery mode"), and every API route returned 500. The disk alert
fired every 30 minutes the whole time, but Telegram was not configured, so it went nowhere —
**set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `deploy/alerts.env`**.

Freeing space after such an event (logs are expendable; the database is not):

```bash
sudo truncate -s 0 /var/log/syslog.1 /var/log/syslog
sudo systemctl restart rsyslog
docker restart whitespace-postgres      # if it does not recover by itself
```

## Alerts

`check-balances.sh` alerts to Telegram when the keeper or a bot forwarder is under
0.02 WBT, a balance cannot be read, or `/` is over 85% full. Test it with
`sudo systemctl start whitespace-balances.service && journalctl -u whitespace-balances -n 20`.

## Incidents

| symptom | first check | fix |
|---|---|---|
| orders stay pending | `journalctl -u whitespace-keeper -n 100`; keeper gas | fund keeper; restart keeper |
| no liquidations / TP / SL | bot logs, `curl 127.0.0.1:9466/metrics` | fund bot; check indexer lag |
| opens refused, closes work | publisher `/status` degraded | venue outage — by design |
| site 502 | `systemctl status whitespace-web`; `.next/BUILD_ID` | rerun `deploy/deploy.sh` |
| indexer lag grows | Ponder logs, RPC 429s | eRPC health; restart indexer |
| disk alert | `du -xh --max-depth=2 /var \| sort -h \| tail` | logs: see Log limits; backups: prune (14-day retention) |
| API 500 "recovery mode" | `df -h /` | disk full: see Log limits |
