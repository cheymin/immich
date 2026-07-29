import { Kysely, sql } from 'kysely';
import { schemaFromCode } from '@immich/sql-tools';
import type { DatabaseColumn, DatabaseTable } from '@immich/sql-tools';
import 'src/schema'; // registers all @DatabaseTable decorators for schemaFromCode
import type { DB } from 'src/schema';

// Map Postgres column types (sql-tools ColumnType) to SQLite storage classes.
function mapColumnType(col: DatabaseColumn): string {
  if (col.isArray) {
    return 'TEXT'; // PG arrays serialised as JSON text
  }
  switch (col.type) {
    case 'boolean':
      return 'INTEGER';
    case 'smallint':
    case 'integer':
    case 'serial':
    case 'bigint':
      return 'INTEGER';
    case 'real':
    case 'double precision':
      return 'REAL';
    case 'bytea':
      return 'BLOB';
    case 'jsonb':
      return 'TEXT';
    case 'uuid':
    case 'text':
    case 'character':
    case 'character varying':
    case '"char"':
    case 'polygon':
    case 'date':
    case 'timestamp':
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'time':
    case 'time with time zone':
    case 'time without time zone':
    case 'enum':
    case 'vector':
      return 'TEXT';
    default:
      return 'TEXT';
  }
}

// Translate a Postgres column default to a SQLite-compatible literal.
// Returns null when the default cannot be safely expressed (e.g. uuid
// generators, which the application supplies itself).
function mapColumnDefault(col: DatabaseColumn): string | null {
  const d = col.default;
  if (d === undefined || d === null || d === '') {
    return null;
  }
  // Normalise to string for pattern matching. schemaFromCode types default as
  // string, but be defensive: decorators may supply raw JS booleans/numbers.
  const s = typeof d === 'string' ? d : String(d);
  if (s === 'true') {
    return '1';
  }
  if (s === 'false') {
    return '0';
  }
  if (/now\(\)|CURRENT_TIMESTAMP/i.test(s)) {
    return 'CURRENT_TIMESTAMP';
  }
  if (/uuid_generate_v4|immich_uuid_v7|gen_random_uuid/i.test(s)) {
    return null;
  }
  // Strip Postgres type casts (e.g. ''::text, 0::int).
  let cleaned = s.replace(/::[a-zA-Z][a-zA-Z0-9 "'().]*/g, '').trim();
  if (cleaned === '') {
    return null;
  }
  // Numeric literal.
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return cleaned;
  }
  // Already-quoted string literal.
  if (/^'.*'$/.test(cleaned)) {
    return cleaned;
  }
  // Anything else (PG expressions) — omit to avoid runtime errors.
  return null;
}

function buildCreateTable(table: DatabaseTable): string {
  const columnDefs: string[] = [];
  const primaryKeyColumns: string[] = [];

  for (const col of table.columns) {
    const parts: string[] = [`"${col.name}"`, mapColumnType(col)];
    if (!col.nullable) {
      parts.push('NOT NULL');
    }
    const def = mapColumnDefault(col);
    if (def !== null) {
      parts.push(`DEFAULT ${def}`);
    }
    // Single-column primary key is declared inline; composite PKs are declared
    // at table level below.
    if (col.primary && table.columns.filter((c) => c.primary).length === 1) {
      parts.push('PRIMARY KEY');
    }
    if (col.primary) {
      primaryKeyColumns.push(col.name);
    }
    columnDefs.push(parts.join(' '));
  }

  if (primaryKeyColumns.length > 1) {
    columnDefs.push(`PRIMARY KEY (${primaryKeyColumns.map((c) => `"${c}"`).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n  ${columnDefs.join(',\n  ')}\n);`;
}

function buildUniqueIndexes(table: DatabaseTable): string[] {
  const out: string[] = [];
  for (const constraint of table.constraints ?? []) {
    // ConstraintType.UNIQUE === 'unique'. Other constraint variants (primary,
    // foreign, check) are intentionally skipped here.
    const c = constraint as { type: string; columnNames?: string[] };
    if (c.type !== 'unique') {
      continue;
    }
    const cols = c.columnNames ?? [];
    if (cols.length === 0) {
      continue;
    }
    const indexName = `${table.name}_${cols.join('_')}_uq`;
    out.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${table.name}" (${cols.map((c) => `"${c}"`).join(', ')});`,
    );
  }
  // Also honour explicit unique indexes declared on the table.
  for (const index of table.indexes ?? []) {
    if (!index.unique) {
      continue;
    }
    const cols = index.columnNames ?? [];
    if (cols.length === 0) {
      continue;
    }
    out.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${index.name}" ON "${table.name}" (${cols.map((c) => `"${c}"`).join(', ')});`,
    );
  }
  return out;
}

/**
 * Creates the full Immich schema in a SQLite database using SQLite-compatible
 * DDL derived from the code-defined schema (via @immich/sql-tools). Safe to run
 * repeatedly: every statement is idempotent (IF NOT EXISTS). Foreign-key
 * constraints are intentionally omitted to avoid creation-order issues;
 * referential integrity is enforced by the application layer.
 */
export async function initSqliteSchema(db: Kysely<DB>): Promise<string[]> {
  const schema = schemaFromCode({ overrides: true, namingStrategy: 'default' });
  const statements: string[] = [];

  // Order tables by name for deterministic, reproducible output.
  const tables = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));

  for (const table of tables) {
    statements.push(buildCreateTable(table));
  }
  for (const table of tables) {
    statements.push(...buildUniqueIndexes(table));
  }

  // Kysely's migration tracking table and Immich's own migrations table are not
  // decorator-defined, so create them explicitly. They are normally created by
  // Kysely migrations, which are skipped on the SQLite build.
  statements.push(
    `CREATE TABLE IF NOT EXISTS "kysely_migrations" (\n  "timestamp" TEXT NOT NULL,\n  "name" TEXT NOT NULL\n);`,
  );
  statements.push(
    `CREATE TABLE IF NOT EXISTS "migrations" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "name" TEXT NOT NULL,\n  "timestamp" INTEGER NOT NULL\n);`,
  );

  // Disable FK enforcement while creating tables (some may reference others
  // not yet created), then re-enable afterwards.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  for (const stmt of statements) {
    await sql.raw(stmt).execute(db);
  }
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  return statements;
}
