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
  /**
   * Which tables the step touches. `workflow` steps are the only ones that can
   * run against a workflow-only database (the in-memory harness the workflow
   * tests use); everything else needs tables `DesktopDatabase` creates.
   */
  scope?: "app" | "workflow";
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
    scope: "workflow",
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
  {
    version: 6,
    name: "task-retry-policy",
    up: (db) => {
      ensureColumns(db, "tasks", [
        { name: "attempt_count", ddl: "integer not null default 0" },
        { name: "max_attempts", ddl: "integer not null default 3" },
        { name: "next_retry_at", ddl: "text" },
        { name: "last_error", ddl: "text" },
      ]);
    },
  },
  {
    version: 7,
    name: "workflow-repository-legacy-columns",
    scope: "workflow",
    up: (db) => {
      // These columns were added by `ensureColumns` inside
      // `WorkflowRepository.migrate()` before this table existed, so a database
      // from any earlier build may already have some, all, or none of them.
      // `ensureColumns` is idempotent, which is what makes adopting them here
      // safe: this version is the single source of truth from now on, and the
      // repository only creates the baseline tables.
      ensureColumns(db, "workflows", [
        { name: "description", ddl: "text not null default ''" },
        { name: "status", ddl: "text not null default 'draft'" },
        { name: "favorite", ddl: "integer not null default 0" },
        { name: "owner", ddl: "text not null default 'You'" },
        { name: "project_path", ddl: "text" },
        { name: "trigger_type", ddl: "text not null default 'manual'" },
        { name: "trigger_schedule", ddl: "text" },
        { name: "trigger_detail", ddl: "text" },
        { name: "integrations", ddl: "text not null default '[]'" },
        { name: "baseline_runs", ddl: "integer not null default 0" },
        { name: "baseline_success_rate", ddl: "real not null default 0" },
        { name: "baseline_avg_duration_ms", ddl: "integer not null default 0" },
        { name: "baseline_last_run_at", ddl: "text" },
        { name: "updated_at", ddl: "text" },
      ]);

      ensureColumns(db, "workflow_steps", [
        { name: "name", ddl: "text not null default 'Step'" },
        { name: "kind", ddl: "text not null default 'execute'" },
        { name: "summary", ddl: "text not null default ''" },
        { name: "model", ddl: "text not null default ''" },
        // profile_id / provider_connection_id are owned by version 4 above and
        // deliberately not repeated here.
        { name: "shell_command", ddl: "text" },
        { name: "timeout_seconds", ddl: "integer not null default 600" },
        { name: "requires_approval", ddl: "integer not null default 0" },
        { name: "continue_on_error", ddl: "integer not null default 0" },
        { name: "enabled", ddl: "integer not null default 1" },
      ]);
    },
  },
  {
    version: 8,
    name: "knowledge-per-file-index",
    up: (db) => {
      // Backs the incremental scanner. `create table if not exists` rather than a
      // bare create because `DesktopDatabase.migrate()` also declares this table
      // in its baseline block, so a fresh database arrives here already holding
      // it while an upgrading one does not.
      db.exec(`
        create table if not exists knowledge_files (
          project_path text not null,
          path text not null,
          hash text not null,
          mtime text not null,
          bytes integer not null,
          insight_json text not null,
          primary key (project_path, path)
        );
      `);
    },
  },
  {
    version: 9,
    name: "app-legacy-additive-columns",
    up: (db) => {
      // The last additive columns still applied outside this list, by seven
      // `ensureColumn`/`ensureColumns` calls in `DesktopDatabase.migrate()`. They
      // predate versioning, so a database from any earlier build may already have
      // some, all, or none of them — the same situation version 7 resolved for the
      // workflow tables, and the same reason adopting them here is safe:
      // `ensureColumns` is idempotent. From this version on, this list is the only
      // place an additive column is declared.
      ensureColumns(db, "agent_runs", [
        { name: "profile_id", ddl: "text" },
        { name: "task_id", ddl: "text" },
        { name: "conversation_id", ddl: "text" },
      ]);

      ensureColumns(db, "agent_profiles", [
        { name: "provider_connection_id", ddl: "text" },
        { name: "module", ddl: "text" },
        { name: "options", ddl: "text" },
      ]);

      ensureColumns(db, "tasks", [
        { name: "parent_task_id", ddl: "text" },
        { name: "assigned_cli_id", ddl: "text" },
        { name: "assigned_model", ddl: "text" },
        { name: "due_at", ddl: "text" },
        { name: "difficulty", ddl: "text" },
        { name: "estimated_minutes", ddl: "integer" },
        { name: "automation_enabled", ddl: "integer not null default 0" },
        { name: "last_run_at", ddl: "text" },
        { name: "last_run_id", ddl: "text" },
        { name: "run_count", ddl: "integer not null default 0" },
      ]);

      // These two indexes cover columns added just above, so they cannot live in
      // the baseline block: on a database predating the columns, creating them
      // there would fail before this migration had a chance to run.
      db.exec(`
        create index if not exists idx_tasks_due on tasks (automation_enabled, status, due_at);
        create index if not exists idx_agent_runs_task on agent_runs (task_id, started_at desc);
      `);
    },
  },
];

/**
 * The subset of `appMigrations` that only alters workflow tables, in version
 * order. Used by `WorkflowRepository.bootstrap` so a workflow-only database gets
 * the same columns without tripping over tables it never creates.
 */
export function workflowMigrations(migrations: Migration[] = appMigrations): Migration[] {
  return migrations.filter((migration) => migration.scope === "workflow");
}

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
