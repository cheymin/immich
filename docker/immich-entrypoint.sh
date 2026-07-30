#!/bin/bash
# Bundled PostgreSQL entrypoint for the single-container Immich image.
#
# Keeps a self-contained Postgres instance on the /data volume so the image
# works with zero external configuration (no Supabase/Neon, no setup wizard).
# Users who DO supply DB_URL / DB_HOSTNAME env vars skip the bundled instance
# entirely and use their external database instead.
set -e

PG_DIR="/data/postgres"
PG_RUN="/run/postgresql"   # postgres requires a world-accessible socket dir
PG_PORT="${IMMICH_DB_PORT:-5432}"
PG_DB="${IMMICH_DB_NAME:-immich}"
PG_USER="${IMMICH_DB_USER:-immich}"
PG_PASSWORD="${IMMICH_DB_PASSWORD:-immich}"

# If the operator supplied an external DB connection, don't start a local one.
if [ -n "${DB_URL:-}" ] || [ -n "${DB_HOSTNAME:-}" ]; then
  echo "[entrypoint] External database configured via DB_URL/DB_HOSTNAME — skipping bundled Postgres."
  exec "$@"
fi

echo "[entrypoint] No external DB configured — starting bundled Postgres."

# Debian's postgresql package installs binaries under
# /usr/lib/postgresql/<ver>/bin (NOT in PATH), and `su postgres -c` inherits a
# minimal PATH without that dir. Locate it once and use absolute paths.
PG_BIN="$(dirname "$(find /usr/lib/postgresql -name initdb -type f 2>/dev/null | head -1)")"
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  echo "[entrypoint] FATAL: initdb not found under /usr/lib/postgresql" >&2
  exit 1
fi
echo "[entrypoint] Using Postgres binaries at $PG_BIN"

# Determine how to run postgres commands. As root we switch to the postgres
# user (Debian package creates it). As non-root (some runtimes like HF Spaces
# force a non-root container user) we run postgres directly as the current
# user — initdb supports running as a non-root user, we just have to make sure
# the data dir is owned by that user.
if [ "$(id -u)" = "0" ]; then
  RUN_AS_ROOT=1
  PG_USER_SWITCH="su postgres -c"
else
  RUN_AS_ROOT=0
  PG_USER_SWITCH=""
fi

# Helper: run a command as the postgres user (root case) or directly (non-root).
pg_exec() {
  if [ "$RUN_AS_ROOT" = "1" ]; then
    su postgres -c "$*"
  else
    eval "$*"
  fi
}

# Postgres needs a client-writable socket directory.
mkdir -p "$PG_RUN"
chmod 0777 "$PG_RUN"

# Initialise the data directory on first boot.
if [ ! -s "$PG_DIR/PG_VERSION" ]; then
  echo "[entrypoint] Initialising database cluster at $PG_DIR"
  mkdir -p "$(dirname "$PG_DIR")"
  if [ "$RUN_AS_ROOT" = "1" ]; then
    chown -R postgres:postgres "$(dirname "$PG_DIR")"
  fi
  pg_exec "$PG_BIN/initdb -D \"$PG_DIR\" -U postgres --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust"
fi

# Always make sure the data dir is owned by the postgres user (root case) or
# current user (non-root case).
if [ "$RUN_AS_ROOT" = "1" ]; then
  chown -R postgres:postgres "$PG_DIR"
fi

# Start Postgres: listen only on localhost (internal use), socket + TCP.
echo "[entrypoint] Starting Postgres on 127.0.0.1:$PG_PORT"
pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" -l /data/postgres.log -o \"-c listen_addresses=127.0.0.1 -c port=$PG_PORT\" start -w"

# Create the app database + role if missing (idempotent).
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'\" | grep -q 1 || $PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_database WHERE datname='$PG_DB'\" | grep -q 1 || $PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE DATABASE $PG_DB OWNER $PG_USER;\""
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"ALTER USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""

# Point Immich at the bundled instance. sslmode=disable because it's loopback.
export DB_HOSTNAME="127.0.0.1"
export DB_PORT="$PG_PORT"
export DB_USERNAME="$PG_USER"
export DB_PASSWORD="$PG_PASSWORD"
export DB_DATABASE_NAME="$PG_DB"
export DB_SSL_MODE="disable"

echo "[entrypoint] Bundled Postgres ready: $PG_USER@127.0.0.1:$PG_PORT/$PG_DB"

# Run the app; on exit, stop Postgres cleanly.
cleanup() {
  echo "[entrypoint] Stopping bundled Postgres"
  pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" stop -m fast -w" || true
}
trap cleanup EXIT INT TERM

exec "$@"
