#!/bin/sh
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

# Postgres needs a client-writable socket directory.
mkdir -p "$PG_RUN"
chmod 0777 "$PG_RUN"

# Initialise the data directory on first boot.
if [ ! -s "$PG_DIR/PG_VERSION" ]; then
  echo "[entrypoint] Initialising database cluster at $PG_DIR"
  mkdir -p "$(dirname "$PG_DIR")"
  # initdb refuses to run as root; postgres user is created by the apt package.
  chown -R postgres:postgres "$(dirname "$PG_DIR")"
  su postgres -c "initdb -D \"$PG_DIR\" -U postgres --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust"
fi

# Always make sure postgres owns the data dir (covers volume reuse cases).
chown -R postgres:postgres "$PG_DIR"

# Start Postgres: listen only on localhost (internal use), socket + TCP.
echo "[entrypoint] Starting Postgres on 127.0.0.1:$PG_PORT"
su postgres -c "pg_ctl -D \"$PG_DIR\" -l /data/postgres.log -o \"-c listen_addresses=127.0.0.1 -c port=$PG_PORT\" start -w"

# Create the app database + role if missing (idempotent).
su postgres -c "psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'\" | grep -q 1 || psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""
su postgres -c "psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_database WHERE datname='$PG_DB'\" | grep -q 1 || psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE DATABASE $PG_DB OWNER $PG_USER;\""
su postgres -c "psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"ALTER USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""

# Point Immich at the bundled instance. sslmode=disable because it's loopback.
export DB_HOSTNAME="127.0.0.1"
export DB_PORT="$PG_PORT"
export DB_USERNAME="$PG_USER"
export DB_PASSWORD="$PG_PASSWORD"
export DB_DATABASE_NAME="$PG_DB"
export DB_SSL_MODE="disable"

echo "[entrypoint] Bundled Postgres ready: $PG_USER@$PG_HOSTNAME:$PG_PORT/$PG_DB"

# Run the app; on exit, stop Postgres cleanly.
cleanup() {
  echo "[entrypoint] Stopping bundled Postgres"
  su postgres -c "pg_ctl -D \"$PG_DIR\" stop -m fast -w" || true
}
trap cleanup EXIT INT TERM

exec "$@"
