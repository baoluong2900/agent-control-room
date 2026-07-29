export type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

/**
 * Adds missing columns to an existing table so older local databases keep working
 * without a destructive re-create.
 */
export function ensureColumns(
  db: SqliteDatabase,
  table: string,
  columns: Array<{ name: string; ddl: string }>,
): void {
  const existing = new Set(
    (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );

  for (const column of columns) {
    if (existing.has(column.name)) continue;
    db.exec(`alter table ${table} add column ${column.name} ${column.ddl};`);
  }
}
