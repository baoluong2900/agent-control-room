import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { appMigrations, appliedVersions, runMigrations, schemaVersion } from "../src/main/database/migrations.ts";
import type { SqliteDatabase } from "../src/main/database/sqlite-types.ts";

const latestVersion = Math.max(...appMigrations.map((migration) => migration.version));

async function memoryDb(): Promise<SqliteDatabase> {
  const sqlite = await import("node:sqlite");
  return new sqlite.DatabaseSync(":memory:") as unknown as SqliteDatabase;
}

function tempDir(label: string): string {
  return path.join(os.tmpdir(), `agentic-${label}-${Date.now()}-${Math.round(process.uptime() * 1e6)}`);
}

// The runner's mechanics are exercised with synthetic migrations. The real
// appMigrations list assumes DesktopDatabase.migrate() already created the legacy
// tables, so it is covered through DesktopDatabase.open() at the bottom instead.

test("a fresh database records each migration once, ascending, and reports its version", async () => {
  const db = await memoryDb();
  const ran: number[] = [];
  const migrations = [
    { version: 3, name: "three", up: () => ran.push(3) },
    { version: 1, name: "one", up: () => ran.push(1) },
    { version: 2, name: "two", up: () => ran.push(2) },
  ];

  const applied = runMigrations(db, migrations);

  assert.deepEqual(ran, [1, 2, 3], "list order must not decide execution order");
  assert.deepEqual(
    applied.map((entry) => entry.version),
    [1, 2, 3],
  );
  assert.deepEqual(appliedVersions(db), [1, 2, 3]);
  assert.equal(schemaVersion(db), 3);
  db.close();
});

test("an unmigrated database reports version 0", async () => {
  const db = await memoryDb();

  assert.equal(schemaVersion(db), 0);
  db.close();
});

test("re-running migrations is a no-op once versions are recorded", async () => {
  const db = await memoryDb();
  let runCount = 0;
  const migrations = [{ version: 1, name: "one", up: () => (runCount += 1) }];

  runMigrations(db, migrations);
  const second = runMigrations(db, migrations);

  assert.deepEqual(second, []);
  assert.equal(runCount, 1);
  db.close();
});

test("only the versions a database is missing get applied", async () => {
  const db = await memoryDb();
  const ran: number[] = [];
  const migrations = [
    { version: 1, name: "one", up: () => ran.push(1) },
    { version: 2, name: "two", up: () => ran.push(2) },
  ];

  runMigrations(db, migrations.slice(0, 1));
  assert.deepEqual(ran, [1]);

  const applied = runMigrations(db, migrations);

  assert.deepEqual(ran, [1, 2], "version 1 must not run a second time");
  assert.deepEqual(
    applied.map((entry) => entry.version),
    [2],
  );
  db.close();
});

test("a failing migration records nothing, rolls back its DDL, and retries next run", async () => {
  const db = await memoryDb();
  let attempts = 0;
  const migrations = [
    {
      version: 1,
      name: "flaky",
      up: (target: SqliteDatabase) => {
        attempts += 1;
        target.exec("create table flaky_marker (id integer primary key);");
        if (attempts === 1) throw new Error("boom");
      },
    },
  ];

  assert.throws(() => runMigrations(db, migrations), /Schema migration 1 \(flaky\) failed: boom/);
  assert.deepEqual(appliedVersions(db), [], "a failed migration must not be recorded");

  // The retry only succeeds if the rollback also undid the partial DDL —
  // otherwise the create would fail with "table already exists".
  const applied = runMigrations(db, migrations);

  assert.deepEqual(
    applied.map((entry) => entry.version),
    [1],
  );
  assert.deepEqual(appliedVersions(db), [1]);
  db.close();
});

test("a later version still applies after an earlier one failed and was retried", async () => {
  const db = await memoryDb();
  let attempts = 0;
  const migrations = [
    {
      version: 1,
      name: "first",
      up: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
    },
    { version: 2, name: "second", up: () => undefined },
  ];

  assert.throws(() => runMigrations(db, migrations), /Schema migration 1/);
  assert.deepEqual(appliedVersions(db), [], "version 2 must not run ahead of a failed version 1");

  runMigrations(db, migrations);

  assert.deepEqual(appliedVersions(db), [1, 2]);
  db.close();
});

test("opening the app database leaves it at the latest schema version", async () => {
  const dir = tempDir("schema-version");
  const db = await DesktopDatabase.open(dir);

  assert.equal(db.schemaVersion(), latestVersion);
  assert.equal(db.migrationsAppliedOnOpen().length, appMigrations.length, "a fresh file applies every version");
  db.close();

  const reopened = await DesktopDatabase.open(dir);

  assert.deepEqual(reopened.migrationsAppliedOnOpen(), [], "reopening must not re-apply anything");
  assert.equal(reopened.schemaVersion(), latestVersion);
  reopened.close();
});

test("versioned columns exist on the tables the app reads", async () => {
  const dir = tempDir("schema-columns");
  const db = await DesktopDatabase.open(dir);

  // Proves versions 2 and 3 actually landed against the legacy tables rather
  // than merely being recorded in schema_migrations.
  const connection = db.saveProviderConnection({ provider: "claude-code", accountLabel: "acct" });

  assert.equal(connection.lastVerifiedAt, undefined);
  assert.equal(connection.verificationDetail, undefined);
  db.close();
});

test("a pre-upgrade database gains the new columns without losing its rows", async () => {
  const dir = tempDir("legacy-upgrade");
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = await import("node:sqlite");

  // A file shaped like one that shipped before workflow-step agent binding and
  // provider base URLs existed, carrying rows a real user would expect to keep.
  const legacy = new sqlite.DatabaseSync(path.join(dir, "agentic-workspace.sqlite"));
  legacy.exec(`
    create table provider_connections (
      id text primary key, user_id text not null, provider text not null,
      auth_mode text not null, storage_mode text not null, account_label text,
      status text not null, token_reference text, quota_label text,
      created_at text not null, updated_at text not null, last_connected_at text
    );
    create table workflows (
      id text primary key, name text not null, project_id text,
      created_at text not null default current_timestamp
    );
    create table workflow_steps (
      id text primary key, workflow_id text not null, agent_cli_id text not null,
      step_order integer not null, prompt_template text not null
    );
    insert into provider_connections values
      ('c1','u1','custom-api','api-key','local','legacy acct','connected','ref-1','API key','2025-01-01','2025-01-01',null);
    insert into workflows (id, name, created_at) values ('wf1','Legacy WF','2025-01-01');
    insert into workflow_steps values ('s1','wf1','claude',1,'do the legacy thing');
  `);
  legacy.close();

  const db = await DesktopDatabase.open(dir);

  assert.equal(db.schemaVersion(), latestVersion);

  const connection = db.listProviderConnections().find((entry) => entry.id === "c1");
  assert.equal(connection?.accountLabel, "legacy acct", "an existing connection must survive the upgrade");
  assert.equal(connection?.baseUrl, undefined, "a legacy row has no proxy endpoint yet");

  const workflow = db.workflows.get("wf1");
  assert.equal(workflow?.name, "Legacy WF");
  assert.equal(workflow?.steps[0].instruction, "do the legacy thing");
  assert.equal(workflow?.steps[0].profileId, undefined, "a legacy step is unbound until the user picks a profile");

  db.close();
});

test("a legacy database gains the app-table columns version 9 owns, and keeps its task rows", async () => {
  const dir = tempDir("legacy-app-columns");
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = await import("node:sqlite");

  // The oldest shape of the three tables version 9 adopts: `tasks`, `agent_runs`
  // and `agent_profiles` with their original columns only, and no schema_migrations
  // row claiming otherwise. Until version 9 these columns were applied by
  // `ensureColumn` calls outside the migration list, so a fresh database passed
  // trivially and this upgrade path was the only thing that could break.
  const legacy = new sqlite.DatabaseSync(path.join(dir, "agentic-workspace.sqlite"));
  legacy.exec(`
    create table tasks (
      id text primary key, project_id text, title text not null, prompt text not null,
      status text not null, created_at text not null default current_timestamp, completed_at text
    );
    create table agent_runs (
      id text primary key, cli_id text not null, cwd text not null, prompt text not null,
      model text, status text not null, started_at text not null, ended_at text, exit_code integer
    );
    create table agent_profiles (
      id text primary key, name text not null, cli_id text not null,
      created_at text not null default current_timestamp
    );
    insert into tasks (id, project_id, title, prompt, status, created_at)
      values ('t1','/tmp/proj','Legacy task','do the old thing','open','2025-01-01');
    insert into agent_runs (id, cli_id, cwd, prompt, status, started_at)
      values ('r1','claude','/tmp/proj','legacy run','completed','2025-01-01');
    insert into agent_profiles (id, name, cli_id) values ('p1','Legacy profile','claude');
  `);
  legacy.close();

  const db = await DesktopDatabase.open(dir);
  assert.equal(db.schemaVersion(), latestVersion);

  // Read through the public API rather than pragma alone: a column that exists but
  // is not selected by the hydrator is not actually usable.
  const task = db.getTask("t1");
  assert.equal(task?.title, "Legacy task", "an existing task row must survive the upgrade");
  assert.equal(task?.automationEnabled, false, "the added column takes its declared default");
  assert.equal(task?.runCount, 0);
  assert.equal(task?.dueAt, null);
  assert.equal(task?.attemptCount, 0, "version 6 columns land on this fixture too");

  // The task is now schedulable, which requires every one of the added columns.
  const scheduled = db.saveTask({
    id: "t1",
    projectPath: "/tmp/proj",
    title: "Legacy task",
    prompt: "do the old thing",
    status: "open",
    assignedCliId: "codex",
    dueAt: "2025-01-02T00:00:00.000Z",
    automationEnabled: true,
  });
  assert.equal(scheduled.assignedCliId, "codex");
  assert.deepEqual(
    db.listDueTasks("2025-02-01T00:00:00.000Z").map((entry) => entry.id),
    ["t1"],
    "the due-task index and its columns must both work after the upgrade",
  );

  const columnsOf = (table: string) =>
    new Set(
      (db as unknown as { db: SqliteDatabase }).db
        .prepare(`pragma table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );

  for (const column of ["profile_id", "task_id", "conversation_id"]) {
    assert.ok(columnsOf("agent_runs").has(column), `agent_runs.${column} must exist after the upgrade`);
  }
  for (const column of ["provider_connection_id", "module", "options"]) {
    assert.ok(columnsOf("agent_profiles").has(column), `agent_profiles.${column} must exist after the upgrade`);
  }

  // The indexes moved into version 9 alongside the columns they cover.
  const indexes = new Set(
    (
      (db as unknown as { db: SqliteDatabase }).db
        .prepare("select name from sqlite_master where type = 'index'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  assert.ok(indexes.has("idx_tasks_due"), "the due-task index must be created after its columns exist");
  assert.ok(indexes.has("idx_agent_runs_task"), "the run-by-task index must be created after its column exists");

  db.close();
});

test("a legacy database with no schema_migrations gains every workflow column and keeps its seeds stable", async () => {
  const dir = tempDir("legacy-workflow-columns");
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = await import("node:sqlite");

  // Deliberately the oldest shape: the workflow tables exist with their original
  // four/five columns and nothing else, and there is no schema_migrations table
  // at all. Additive migrations pass trivially on a fresh database, so this is
  // the case that actually exercises them.
  const legacy = new sqlite.DatabaseSync(path.join(dir, "agentic-workspace.sqlite"));
  legacy.exec(`
    create table workflows (
      id text primary key, name text not null, project_id text,
      created_at text not null default current_timestamp
    );
    create table workflow_steps (
      id text primary key, workflow_id text not null, agent_cli_id text not null,
      step_order integer not null, prompt_template text not null
    );
    insert into workflows (id, name, created_at) values ('old-wf','Ancient WF','2024-05-01');
    insert into workflow_steps values ('old-step','old-wf','codex',1,'inspect the thing');
  `);
  const tableNames = (legacy.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
    name: string;
  }>).map((row) => row.name);
  assert.equal(tableNames.includes("schema_migrations"), false, "the fixture must predate versioning");
  legacy.close();

  const db = await DesktopDatabase.open(dir);
  assert.equal(db.schemaVersion(), latestVersion);

  const columnsOf = (table: string) =>
    new Set(
      (db.workflows as unknown as { db: SqliteDatabase }).db
        .prepare(`pragma table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );

  const workflowColumns = columnsOf("workflows");
  for (const column of ["description", "status", "favorite", "owner", "trigger_type", "updated_at"]) {
    assert.ok(workflowColumns.has(column), `workflows.${column} must exist after the upgrade`);
  }

  const stepColumns = columnsOf("workflow_steps");
  for (const column of ["name", "kind", "model", "profile_id", "provider_connection_id", "enabled"]) {
    assert.ok(stepColumns.has(column), `workflow_steps.${column} must exist after the upgrade`);
  }

  // The pre-existing workflow is preserved, and because the database was not
  // empty the seeds are skipped rather than dumped on top of the user's data.
  const preserved = db.workflows.get("old-wf");
  assert.equal(preserved?.name, "Ancient WF");
  assert.equal(preserved?.steps[0].instruction, "inspect the thing");
  const afterFirstOpen = db.workflows.list().length;
  db.close();

  // Reopening must be a no-op: no migration reruns, no duplicated seeds.
  const reopened = await DesktopDatabase.open(dir);
  assert.deepEqual(reopened.migrationsAppliedOnOpen(), []);
  assert.equal(reopened.workflows.list().length, afterFirstOpen);
  assert.deepEqual(appliedVersions((reopened.workflows as unknown as { db: SqliteDatabase }).db), appMigrations.map((m) => m.version));
  reopened.close();
});
