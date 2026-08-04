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
