import { ensureColumns, type SqliteDatabase } from "./sqlite-types";

/**
 * One versioned schema change. `up` must be safe to run against a database that
 * has never seen it; the runner guarantees it runs at most once per database, but
 * a local file can arrive here having already gained a column through the older
 * `ensureColumns` path, so additive steps still go through `ensureColumns`.
 */
export type Migration = {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
};

export type AppliedMigration = {
  version: number;
  name: string;
  appliedAt: string;
};

type VersionRow = { version: number };

/**
 * The ordered list of schema versions for the app database.
 *
 * Version 1 is the baseline: every `create table if not exists` and
 * `ensureColumns` call that shipped before this table existed. It is a no-op
 * because `DesktopDatabase.migrate()` still runs that block first — recording it
 * only gives later versions a floor to build on.
 *
 * Add new versions by appending. Never renumber or edit a released version: a
 * database that already recorded it will not run the edited body.
 */
export const appMigrations: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up: () => {
      // Intentionally empty — see the note above.
    },
  },
  {
    version: 2,
    name: "provider-connection-verification",
    up: (db) => {
      ensureColumns(db, "provider_connections", [
        { name: "last_verified_at", ddl: "text" },
        { name: "verification_detail", ddl: "text" },
      ]);
    },
  },
  {
    version: 3,
    name: "knowledge-scan-truncation",
    up: (db) => {
      ensureColumns(db, "knowledge_snapshots", [{ name: "truncation_json", ddl: "text" }]);
    },
  },
  {
    version: 4,
    name: "workflow-step-agent-binding",
    up: (db) => {
      ensureColumns(db, "workflow_steps", [
        { name: "profile_id", ddl: "text" },
        { name: "provider_connection_id", ddl: "text" },
      ]);
    },
  },
  {
    version: 5,
    name: "provider-connection-base-url",
    up: (db) => {
      ensureColumns(db, "provider_connections", [{ name: "base_url", ddl: "text" }]);
    },
  },
];

function ensureVersionTable(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);
}

/** Versions already recorded against this database, ascending. */
export function appliedVersions(db: SqliteDatabase): number[] {
  ensureVersionTable(db);
  const rows = db.prepare("select version from schema_migrations order by version asc").all() as VersionRow[];
  return rows.map((row) => row.version);
}

/** Highest recorded version, or 0 for a database that has never been migrated. */
export function schemaVersion(db: SqliteDatabase): number {
  const versions = appliedVersions(db);
  return versions.length === 0 ? 0 : versions[versions.length - 1];
}

/**
 * Runs every migration this database has not recorded yet, in ascending version
 * order, and returns the ones that ran.
 *
 * Each migration and its bookkeeping row commit together, so a body that throws
 * leaves no version recorded and the same step is retried on the next open. The
 * error is rethrown: a half-migrated database must not be handed to the app.
 */
export function runMigrations(db: SqliteDatabase, migrations: Migration[] = appMigrations): AppliedMigration[] {
  const already = new Set(appliedVersions(db));
  const pending = migrations
    .filter((migration) => !already.has(migration.version))
    .sort((left, right) => left.version - right.version);

  const applied: AppliedMigration[] = [];

  for (const migration of pending) {
    const appliedAt = new Date().toISOString();
    db.exec("begin");
    try {
      migration.up(db);
      db.prepare("insert into schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
        migration.version,
        migration.name,
        appliedAt,
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw new Error(
        `Schema migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    applied.push({ version: migration.version, name: migration.name, appliedAt });
  }

  return applied;
}
