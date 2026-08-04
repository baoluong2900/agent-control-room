import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clampTail, logRetention, truncateLogMessage } from "../src/main/database/log-retention.ts";

/**
 * The message-clamping helpers are pure, so they are tested directly. The row and
 * age caps need a real table, so those tests drive raw SQL against an in-memory
 * database mirroring the `terminal_logs`/`agent_runs` shape — `DesktopDatabase.open`
 * wants an Electron userData path, which these do not need.
 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table terminal_logs (
      id integer primary key autoincrement,
      run_id text not null,
      stream text not null,
      message text not null,
      created_at text not null
    );
    create table agent_runs (
      id text primary key,
      status text not null,
      started_at text not null,
      ended_at text
    );
  `);
  return db;
}

test("a message under the cap is stored byte-for-byte", () => {
  const message = "compiled 42 modules in 1.2s";
  const result = truncateLogMessage(message);

  assert.equal(result.message, message);
  assert.equal(result.droppedBytes, 0, "nothing was dropped, so nothing is reported");
});

test("an oversized message keeps both ends and drops the middle", () => {
  // A realistic failure: a huge dump bracketed by the two lines that matter.
  const head = "Running build...\n";
  const tail = "\nError: exited with code 1";
  const message = `${head}${"x".repeat(80_000)}${tail}`;

  const result = truncateLogMessage(message);

  assert.ok(result.message.startsWith(head), "the command that produced the dump is still visible");
  assert.ok(result.message.endsWith(tail), "the outcome is still visible");
  assert.ok(result.droppedBytes > 0);
  assert.ok(
    Buffer.byteLength(result.message, "utf8") <= logRetention.maxMessageBytes,
    "the stored row respects the cap",
  );
});

test("truncation announces itself inside the message", () => {
  const result = truncateLogMessage("y".repeat(500_000));

  // The marker rides along in the stored text on purpose: it reaches the terminal
  // pane with no contract or UI change, so a truncation is never silent.
  assert.match(result.message, /trimmed by the log retention policy/);
  assert.match(result.message, /MB|KB/, "the marker names how much was lost");
});

test("truncation never splits a multi-byte character", () => {
  // Every character is 4 bytes, so a naive byte slice lands mid-codepoint.
  const result = truncateLogMessage("🙂".repeat(20_000));

  assert.ok(!result.message.includes("�"), "no replacement characters were introduced");
  assert.ok(Buffer.byteLength(result.message, "utf8") <= logRetention.maxMessageBytes);
});

test("clampTail keeps the end of an accumulating buffer", () => {
  const clamped = clampTail("abcdefghij", 4);
  assert.equal(clamped, "ghij");
  assert.equal(clampTail("abc", 10), "abc", "a buffer under the cap is untouched");
});

test("pruning keeps the newest rows and drops the oldest", () => {
  const db = freshDb();
  const insert = db.prepare("insert into terminal_logs (run_id, stream, message, created_at) values (?, ?, ?, ?)");
  for (let index = 0; index < 40; index += 1) {
    insert.run("run-1", "stdout", `line ${index}`, new Date(1_700_000_000_000 + index).toISOString());
  }

  db.prepare(
    `delete from terminal_logs
     where run_id = ?
       and id not in (select id from terminal_logs where run_id = ? order by id desc limit ?)`,
  ).run("run-1", "run-1", 10);

  const rows = db.prepare("select message from terminal_logs where run_id = ? order by id asc").all("run-1") as Array<{
    message: string;
  }>;

  assert.equal(rows.length, 10);
  // The terminal renders the tail, so recency is what a reopened pane needs.
  assert.equal(rows[0].message, "line 30");
  assert.equal(rows[9].message, "line 39");
});

test("pruning one run leaves other runs alone", () => {
  const db = freshDb();
  const insert = db.prepare("insert into terminal_logs (run_id, stream, message, created_at) values (?, ?, ?, ?)");
  for (let index = 0; index < 20; index += 1) {
    insert.run("noisy", "stdout", `noise ${index}`, "2026-06-01T00:00:00.000Z");
    insert.run("quiet", "stdout", `quiet ${index}`, "2026-06-01T00:00:00.000Z");
  }

  db.prepare(
    `delete from terminal_logs
     where run_id = ?
       and id not in (select id from terminal_logs where run_id = ? order by id desc limit ?)`,
  ).run("noisy", "noisy", 5);

  const noisy = db.prepare("select count(*) as total from terminal_logs where run_id = 'noisy'").get() as {
    total: number;
  };
  const quiet = db.prepare("select count(*) as total from terminal_logs where run_id = 'quiet'").get() as {
    total: number;
  };

  assert.equal(noisy.total, 5);
  assert.equal(quiet.total, 20, "a second run's scrollback is not collateral damage");
});

test("the age sweep drops finished runs but never one still in flight", () => {
  const db = freshDb();
  db.prepare("insert into agent_runs (id, status, started_at, ended_at) values (?, ?, ?, ?)").run(
    "old",
    "completed",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T01:00:00.000Z",
  );
  db.prepare("insert into agent_runs (id, status, started_at, ended_at) values (?, ?, ?, ?)").run(
    "recent",
    "completed",
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T01:00:00.000Z",
  );
  // A run with no ended_at is still going; its logs are the ones being watched.
  db.prepare("insert into agent_runs (id, status, started_at, ended_at) values (?, ?, ?, ?)").run(
    "live",
    "running",
    "2026-01-01T00:00:00.000Z",
    null,
  );

  const insert = db.prepare("insert into terminal_logs (run_id, stream, message, created_at) values (?, ?, ?, ?)");
  for (const runId of ["old", "recent", "live"]) {
    insert.run(runId, "stdout", "hello", "2026-01-01T00:00:00.000Z");
  }

  db.prepare(
    `delete from terminal_logs
     where run_id in (select id from agent_runs where ended_at is not null and ended_at < ?)`,
  ).run("2026-05-01T00:00:00.000Z");

  const remaining = db.prepare("select run_id from terminal_logs order by run_id asc").all() as Array<{
    run_id: string;
  }>;

  assert.deepEqual(
    remaining.map((row) => row.run_id),
    ["live", "recent"],
    "only the long-finished run was swept",
  );
});

test("the retention caps are ordered sensibly against the terminal's read size", () => {
  // listTerminalLogs defaults to 400 rows, so the stored cap must exceed it or the
  // pane would scroll back to a hard wall that the policy created.
  assert.ok(logRetention.maxRowsPerRun > 400, "scrollback stays generous");
  assert.ok(
    logRetention.pruneIntervalRows < logRetention.maxRowsPerRun,
    "a run cannot overshoot the cap by more than one prune interval",
  );
});
