import { createPostgres, DatabaseSslMode } from '@immich/sql-tools';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Path to the persisted database configuration written by the first-run setup
// wizard. Stored on the /data volume so it survives container restarts.
export const DB_CONFIG_PATH = process.env.IMMICH_DB_CONFIG_PATH || '/data/db-config.json';

export type DbConfig = {
  // Either a full connection URL, or individual parts.
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: string;
};

let loaded = false;

/**
 * Read the persisted database configuration (if any) into process.env so the
 * existing zod-based env parsing in ConfigRepository picks it up. Idempotent.
 *
 * This is the single hook point: it runs at the very start of the standalone
 * getEnv() function, before EnvSchema.safeParse(process.env), guaranteeing the
 * file values are visible everywhere config is read (app.module top-level,
 * main.ts early DB probes, DI consumers).
 *
 * Precedence: values already present in process.env (set by the container
 * runtime, e.g. HF Space secrets) win over the file — the file is only a
 * fallback for the first-run wizard case where no env vars are supplied.
 */
export function loadDbConfigFromStore(): void {
  if (loaded) {
    return;
  }
  loaded = true;

  if (!existsSync(DB_CONFIG_PATH)) {
    return;
  }

  let config: DbConfig;
  try {
    config = JSON.parse(readFileSync(DB_CONFIG_PATH, 'utf8')) as DbConfig;
  } catch {
    return;
  }

  if (config.url) {
    process.env.DB_URL ??= config.url;
    return;
  }

  // Only set env vars that aren't already defined by the container runtime.
  if (config.host) {
    process.env.DB_HOSTNAME ??= config.host;
  }
  if (config.port != null) {
    process.env.DB_PORT ??= String(config.port);
  }
  if (config.username) {
    process.env.DB_USERNAME ??= config.username;
  }
  if (config.password) {
    process.env.DB_PASSWORD ??= config.password;
  }
  if (config.database) {
    process.env.DB_DATABASE_NAME ??= config.database;
  }
  if (config.ssl) {
    process.env.DB_SSL_MODE ??= config.ssl;
  }
}

/**
 * Whether a database connection has been configured either via the container
 * environment or the persisted config file. When false, the first-run setup
 * wizard is served instead of booting the workers.
 */
export function isDbConfigured(): boolean {
  if (existsSync(DB_CONFIG_PATH)) {
    return true;
  }
  // Env vars set directly by the container runtime (HF Space secrets, docker
  // -e, etc.) also count as configured.
  return !!(process.env.DB_URL || process.env.DB_HOSTNAME);
}

/**
 * Persist the wizard-submitted configuration to disk so subsequent boots load
 * it via loadDbConfigFromStore().
 */
export function saveDbConfig(config: DbConfig): void {
  mkdirSync(dirname(DB_CONFIG_PATH), { recursive: true });
  writeFileSync(DB_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Validate a database configuration by opening (and closing) a real Postgres
 * connection. Throws on failure with the underlying error message.
 */
export async function testDbConnection(config: DbConfig): Promise<void> {
  const params =
    config.url != null && config.url !== ''
      ? { connectionType: 'url' as const, url: config.url }
      : {
          connectionType: 'parts' as const,
          host: config.host || 'localhost',
          port: config.port || 5432,
          username: config.username || 'postgres',
          password: config.password || '',
          database: config.database || 'immich',
          ...(config.ssl ? { ssl: config.ssl as DatabaseSslMode } : {}),
        };

  const sql = createPostgres({ connection: params, maxConnections: 1 });
  try {
    // A trivial query proves auth + reachability.
    await sql`SELECT 1`;
  } finally {
    await sql.end();
  }
}
