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

Install/refresh unit files after a pull that changed `deploy/systemd/`:

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whitespace-bot@a whitespace-bot@b whitespace-balances.timer whitespace-backup.timer
```

`/etc/sudoers.d/whitespace` must allow single-unit `systemctl start|stop|restart|is-active`
for every unit above, including `whitespace-bot@a` and `whitespace-bot@b`.

## Secrets

Keys live in `~/.whitespace-keys/` (dir 700, files 600): `keeper.json`, `signer*.json`,
`bot-a.json`, `bot-b.json`. Deploy-time keys (owner, gov, manager, lp) are **not** kept on
the box. `deploy/alerts.env` (git-ignored) holds the Telegram token for alerts.

## Routine deploy

`deploy/deploy.sh` as `whitespace`: pull, install, build web with web+indexer stopped,
restart everything, then verify every unit and timer is `active` and that the web process
started after the build it serves. It exits non-zero on any failure.

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
| disk alert | `du -sh /var/lib/docker /var/backups/whitespace` | prune backups (14-day retention) |
