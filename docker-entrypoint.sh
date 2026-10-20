#!/bin/sh
set -eu

db_path="${DB_PATH:-/data/helpdesk.db}"
db_dir="$(dirname "$db_path")"

mkdir -p "$db_dir"
chown node:node "$db_dir"
for file in "$db_path" "$db_path-wal" "$db_path-shm"; do
  if [ -e "$file" ]; then
    chown node:node "$file"
  fi
done

exec su-exec node "$@"
