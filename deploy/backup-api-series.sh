#!/usr/bin/env bash
# Nightly backup of the ONLY irreplaceable state on this box.
#
# The compose file calls its volume a cache rather than a system of record. That is true
# for everything Ponder owns — it can rebuild all of it from chain — and false for exactly
# one schema. services/api/src/indexSeries.ts creates and fills `api_series.index_candle`
# from a background timer sampling the publisher. Ponder neither owns nor reconstructs it,
# so if the volume is lost that history is gone permanently.
#
# Hence: back up one schema, not the database.
set -euo pipefail

DEST=/var/backups/whitespace
RETENTION_DAYS=14
STAMP=$(date +%Y-%m-%d)

mkdir -p "$DEST"
PGPASSWORD=whitespace pg_dump \
  -h 127.0.0.1 -p 5433 -U whitespace -d whitespace \
  -n api_series \
  | gzip > "$DEST/api_series-$STAMP.sql.gz"

find "$DEST" -name 'api_series-*.sql.gz' -mtime +$RETENTION_DAYS -delete

echo "backed up api_series to $DEST/api_series-$STAMP.sql.gz"
