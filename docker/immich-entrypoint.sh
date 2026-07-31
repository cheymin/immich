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
PG_LOG="$PG_DIR/server.log"

# If the operator supplied an external DB connection, don't start a local one.
if [ -n "${DB_URL:-}" ] || [ -n "${DB_HOSTNAME:-}" ]; then
  echo "[entrypoint] External database configured via DB_URL/DB_HOSTNAME — skipping bundled Postgres."
  exec "$@"
fi

echo "[entrypoint] No external DB configured — starting bundled Postgres."

# Debian's postgresql package installs binaries under
# /usr/lib/postgresql/<ver>/bin (NOT in PATH). Locate it once and use absolute
# paths — `su`/`runuser` inherit a minimal PATH without that dir.
PG_BIN="$(dirname "$(find /usr/lib/postgresql -name initdb -type f 2>/dev/null | head -1)")"
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  echo "[entrypoint] FATAL: initdb not found under /usr/lib/postgresql" >&2
  exit 1
fi
echo "[entrypoint] Using Postgres binaries at $PG_BIN"

# Determine how to run postgres commands.
# - As root: switch to the postgres user (Debian package creates it).
# - As non-root (some runtimes like HF Spaces force this): run directly as the
#   current user. initdb supports non-root operation as long as the current
#   user owns the data dir.
if [ "$(id -u)" = "0" ]; then
  RUN_AS_ROOT=1
  echo "[entrypoint] Running as root — postgres commands will use 'runuser postgres'."
else
  RUN_AS_ROOT=0
  echo "[entrypoint] Running as non-root user '$(id -un)' (uid $(id -u)) — postgres will run as this user."
fi

# Helper: run a command as the postgres user (root case) or directly (non-root).
# Uses runuser instead of su: it doesn't clobber PATH/env the way su does and
# is the recommended tool for this on modern Debian.
pg_exec() {
  if [ "$RUN_AS_ROOT" = "1" ]; then
    runuser -u postgres -- bash -c "$*"
  else
    bash -c "$*"
  fi
}

# Postgres needs a client-writable socket directory.
mkdir -p "$PG_RUN"
chmod 0777 "$PG_RUN"

# Make sure /data and the postgres dir exist and are owned correctly.
# HF Spaces remounts /data on restart and may reset ownership, so do this
# unconditionally (not just on first initdb).
mkdir -p "$PG_DIR"
if [ "$RUN_AS_ROOT" = "1" ]; then
  chown postgres:postgres /data 2>/dev/null || true
  chown -R postgres:postgres "$PG_DIR"
else
  # Non-root: ensure current user owns the data dir (previous root-mode boot
  # may have left it owned by postgres, which we can't write to).
  chown -R "$(id -u):$(id -g)" "$PG_DIR" 2>/dev/null || true
fi
# Postgres refuses to start if the data directory has group/other write bits
# (mkdir defaults to 0755, HF volume mounts can be 0777). Force 0700.
chmod 0700 "$PG_DIR"

# Initialise the data directory on first boot.
if [ ! -s "$PG_DIR/PG_VERSION" ]; then
  echo "[entrypoint] Initialising database cluster at $PG_DIR"
  pg_exec "$PG_BIN/initdb -D \"$PG_DIR\" -U postgres --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust"
fi

# Recreate any missing standard runtime subdirectories. initdb creates these,
# but they can disappear after an unclean shutdown (container SIGKILL / OOM)
# combined with persistent-volume quirks on hosted runtimes such as HF Spaces.
# Postgres FATAls on a missing pg_notify instead of recreating it, so recreate
# the runtime/state dirs ourselves. These hold no user data — real data lives
# in base/, global/, pg_wal/, pg_xact/ which we do NOT touch.
if [ "$RUN_AS_ROOT" = "1" ]; then
  for subdir in pg_notify pg_stat_tmp pg_replslot pg_serial pg_snapshots pg_dynshmem pg_commit_ts pg_twophase pg_tblspc; do
    runuser -u postgres -- mkdir -p "$PG_DIR/$subdir" 2>/dev/null || mkdir -p "$PG_DIR/$subdir"
  done
  chown -R postgres:postgres "$PG_DIR" 2>/dev/null || true
else
  for subdir in pg_notify pg_stat_tmp pg_replslot pg_serial pg_snapshots pg_dynshmem pg_commit_ts pg_twophase pg_tblspc; do
    mkdir -p "$PG_DIR/$subdir"
  done
fi
# Also clear any half-written WAL segment that could block recovery. The
# recovery loop seen in the logs ("invalid record length") is normal after a
# crash, but a torn WAL file at the head can occasionally prevent startup.
# pg_resetwal is the safe tool for this, but only run it as a last resort and
# only if the server genuinely won't start — handled below after the first
# start attempt fails.

# Clean up stale lock files left by an unclean shutdown (container kill, OOM,
# etc.). pg_ctl refuses to start if postmaster.pid points at a dead process.
# Also remove postmaster.opts to avoid confusion. Only remove pid if no live
# postgres is actually running on it.
if [ -f "$PG_DIR/postmaster.pid" ]; then
  if ! pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" status" >/dev/null 2>&1; then
    echo "[entrypoint] Removing stale postmaster.pid"
    rm -f "$PG_DIR/postmaster.pid"
  fi
fi

# Start Postgres: listen only on localhost (internal use), socket + TCP.
# Log lives inside PG_DIR (owned by the postgres user) — /data itself may be
# root-owned after a volume remount.
#
# Use a long start timeout (-t 180). After an unclean shutdown, crash recovery
# fsyncs the entire data directory; on HF Spaces' persistent volume this can
# take well over a minute. The default pg_ctl timeout is 60s, which causes
# pg_ctl to report "server did not start in time" and exit — even though the
# postgres process is still alive and fsyncing in the background. That false
# failure then triggers the WAL-reset path, which conflicts with the still-
# running postgres (postmaster.pid lock) and wedges startup for real.
echo "[entrypoint] Starting Postgres on 127.0.0.1:$PG_PORT"
if ! pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" -l \"$PG_LOG\" -o \"-c listen_addresses=127.0.0.1 -c port=$PG_PORT\" start -w -t 180"; then
  # First start failed. Before attempting WAL reset, make absolutely sure no
  # postgres process is still running against this data dir — pg_ctl's -w may
  # have timed out while postgres was still doing crash-recovery fsync, leaving
  # a live process holding postmaster.pid. pg_resetwal refuses to run while
  # that pid file exists, and a second pg_ctl start would collide with it.
  echo "[entrypoint] First start failed — stopping any lingering postgres process"
  pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" stop -m immediate -w -t 30" 2>/dev/null || true
  # Force-kill anything still holding the data dir, then remove the pid file.
  if [ -f "$PG_DIR/postmaster.pid" ]; then
    OLD_PID=$(head -1 "$PG_DIR/postmaster.pid" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[entrypoint] Killing stale postgres PID $OLD_PID"
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 2
    fi
    rm -f "$PG_DIR/postmaster.pid"
  fi

  # Now attempt WAL reset recovery. Only on an existing data dir (not a fresh
  # initdb). pg_resetwal advances the WAL position past a torn segment — the
  # documented recovery tool for the "invalid record length" symptom seen in
  # crash recovery. It does not touch table data.
  if [ -s "$PG_DIR/PG_VERSION" ]; then
    echo "[entrypoint] Attempting WAL reset recovery"
    pg_exec "$PG_BIN/pg_resetwal -f \"$PG_DIR\"" || true
    # Retry the start once, still with the long timeout.
    if ! pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" -l \"$PG_LOG\" -o \"-c listen_addresses=127.0.0.1 -c port=$PG_PORT\" start -w -t 180"; then
      echo "[entrypoint] FATAL: Postgres failed to start after WAL reset. Server log follows:" >&2
      echo "----- BEGIN $PG_LOG -----" >&2
      cat "$PG_LOG" >&2 2>/dev/null || echo "(could not read $PG_LOG)" >&2
      echo "----- END $PG_LOG -----" >&2
      exit 1
    fi
    echo "[entrypoint] Recovered via WAL reset — Postgres started on second attempt"
  else
    echo "[entrypoint] FATAL: Postgres failed to start. Server log follows:" >&2
    echo "----- BEGIN $PG_LOG -----" >&2
    cat "$PG_LOG" >&2 2>/dev/null || echo "(could not read $PG_LOG)" >&2
    echo "----- END $PG_LOG -----" >&2
    exit 1
  fi
fi

# Create the app database + role if missing (idempotent).
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'\" | grep -q 1 || $PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -tc \"SELECT 1 FROM pg_database WHERE datname='$PG_DB'\" | grep -q 1 || $PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"CREATE DATABASE $PG_DB OWNER $PG_USER;\""
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -c \"ALTER USER $PG_USER WITH PASSWORD '$PG_PASSWORD';\""

# Pre-create ALL extensions Immich needs in the app database as a superuser.
# Immich's InitialMigration (1744910873969) runs CREATE EXTENSION for these,
# but the app role isn't a superuser so it can't create them itself (Postgres
# requires superuser for most extensions). Pre-creating them as the postgres
# superuser means the migration's CREATE EXTENSION IF NOT EXISTS becomes a
# no-op. Full list from server/src/schema/migrations/1744910873969-InitialMigration.ts
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS \\\"uuid-ossp\\\";\"" || echo "[entrypoint] WARNING: could not create uuid-ossp extension"
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS unaccent;\"" || echo "[entrypoint] WARNING: could not create unaccent extension"
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS cube;\"" || echo "[entrypoint] WARNING: could not create cube extension"
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS earthdistance;\"" || echo "[entrypoint] WARNING: could not create earthdistance extension"
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS pg_trgm;\"" || echo "[entrypoint] WARNING: could not create pg_trgm extension"
pg_exec "$PG_BIN/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d \"$PG_DB\" -c \"CREATE EXTENSION IF NOT EXISTS vector CASCADE;\"" || echo "[entrypoint] WARNING: could not create vector extension"

# Point Immich at the bundled instance. sslmode=disable because it's loopback.
export DB_HOSTNAME="127.0.0.1"
export DB_PORT="$PG_PORT"
export DB_USERNAME="$PG_USER"
export DB_PASSWORD="$PG_PASSWORD"
export DB_DATABASE_NAME="$PG_DB"
export DB_SSL_MODE="disable"

echo "[entrypoint] Bundled Postgres ready: $PG_USER@127.0.0.1:$PG_PORT/$PG_DB"

# ---- Optional S3 mount via s3fs ------------------------------------------
# If S3_* env vars are set, mount the bucket at /data/s3 so Immich can store
# media on S3 while keeping its DB on the local /data volume. Immich itself
# has no native S3 support — this mount makes S3 behave as a local filesystem.
#
# Required env:
#   S3_BUCKET          - bucket name
#   S3_ACCESS_KEY      - access key id
#   S3_SECRET_KEY      - secret access key
# Optional:
#   S3_ENDPOINT        - e.g. https://s3.us-east-005.backblazeb2.com (omit for AWS)
#   S3_REGION          - region (default: auto)
#   S3_MOUNT           - mount path (default: /data/s3)
S3_MOUNT_DIR="${S3_MOUNT:-/data/s3}"
if [ -n "${S3_BUCKET:-}" ] && [ -n "${S3_ACCESS_KEY:-}" ] && [ -n "${S3_SECRET_KEY:-}" ]; then
  echo "[entrypoint] S3 bucket configured — mounting ${S3_BUCKET} at ${S3_MOUNT_DIR}"
  mkdir -p "$S3_MOUNT_DIR"
  # Write credentials in the format s3fs expects.
  echo "${S3_ACCESS_KEY}:${S3_SECRET_KEY}" > /tmp/.s3fs-creds
  chmod 600 /tmp/.s3fs-creds

  # s3fs runs as a background daemon by default (no -f). Build the option set.
  S3FS_OPTS="passwd_file=/tmp/.s3fs-creds,url=${S3_ENDPOINT:-https://s3.amazonaws.com}"
  S3FS_OPTS="$S3FS_OPTS,endpoint=${S3_REGION:-us-east-1}"
  # allow_other lets the node process (non-root on HF Spaces) read the mount.
  S3FS_OPTS="$S3FS_OPTS,allow_other"
  # umask makes files group-readable so non-root workers can access them.
  S3FS_OPTS="$S3FS_OPTS,umask=0002"
  # Connect immediately and fail fast if credentials/endpoint are wrong.
  S3FS_OPTS="$S3FS_OPTS,connect_timeout=10,readwrite_timeout=30"

  if ! s3fs "${S3_BUCKET}:" "$S3_MOUNT_DIR" -o "$S3FS_OPTS" 2>/tmp/s3fs.err; then
    echo "[entrypoint] FATAL: s3fs mount failed:" >&2
    cat /tmp/s3fs.err >&2 2>/dev/null || true
    # Don't exit — let Immich fall back to local storage so the app still starts.
    echo "[entrypoint] Continuing with local storage only — S3 media unavailable" >&2
  else
    echo "[entrypoint] S3 mounted at ${S3_MOUNT_DIR}"
  fi
  rm -f /tmp/.s3fs-creds
else
  echo "[entrypoint] No S3 configured — using local storage on /data"
fi

# Run the app; on exit, stop Postgres cleanly.
cleanup() {
  echo "[entrypoint] Stopping bundled Postgres"
  # Unmount S3 first (if mounted) so pending writes flush before postgres stops.
  if mountpoint -q "$S3_MOUNT_DIR" 2>/dev/null; then
    fusermount -u "$S3_MOUNT_DIR" 2>/dev/null || umount "$S3_MOUNT_DIR" 2>/dev/null || true
  fi
  pg_exec "$PG_BIN/pg_ctl -D \"$PG_DIR\" stop -m fast -w" || true
}
trap cleanup EXIT INT TERM

exec "$@"
