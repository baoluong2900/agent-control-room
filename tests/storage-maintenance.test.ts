import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { logRetention } from "../src/main/database/log-retention.ts";
import {
  describeCleanupScope,
  describeMaintenance,
  formatBytes,
  storageTone,
  STORAGE_SUGGEST_CLEANUP_BYTES,
  STORAGE_SUGGEST_CLEANUP_ROWS,
} from "../src/renderer/settings/storage-panel.ts";

/**
 * Storage reporting and the manual cleanup behind it. Diagnostics already showed
 * the database size; what was missing was any way to act on it, so these tests
 * pin the two claims the button makes: expired logs are gone, and the freed space
 * is actually returned rather than left on sqlite's free list.
 */

async function openDatabase(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `agentic-${label}-${Date.now()}-${Math.random()}`));
}

/**
 * A finished run with `rows` log lines, ended `endedDaysAgo` days ago.
 *
 * `endedAt` is written on insert rather than via `updateAgentRunStatus`, which
 * always stamps *now* — a backdated end is exactly what the retention sweep keys
 * off, so it has to be set directly.
 */
function seedFinishedRun(db: DesktopDatabase, runId: string, rows: number, endedDaysAgo: number): void {
  const endedAt = new Date(Date.now() - endedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.createAgentRun({
    id: runId,
    cliId: "shell",
    model: "shell",
    prompt: "seed",
    cwd: process.cwd(),
    status: "completed",
    startedAt: endedAt,
    endedAt,
    exitCode: 0,
  });
  for (let index = 0; index < rows; index += 1) {
    // Wide messages so the sweep has real bytes to reclaim, not just row counts.
    db.appendTerminalLog(runId, "stdout", `${runId} line ${index} ${"x".repeat(512)}\n`);
  }
}

test("the storage report names the file and counts its log rows", async () => {
  const db = await openDatabase("storage-report");
  seedFinishedRun(db, "run-report", 40, 1);

  const report = db.storageReport();

  assert.match(report.path, /agentic-workspace\.sqlite$/, "the report names the sqlite file it measured");
  assert.ok(report.sizeBytes > 0, `expected a non-zero size, got ${report.sizeBytes}`);
  assert.equal(report.terminalLogRows, 40);
  assert.ok(report.schemaVersion > 0, "a migrated database reports its schema version");
  assert.equal(report.retentionDays, logRetention.maxRunAgeDays, "the panel states the same policy the sweep uses");

  db.close();
});

test("cleanup removes logs from old finished runs and keeps recent ones", async () => {
  const db = await openDatabase("storage-cleanup");
  seedFinishedRun(db, "run-old", 300, logRetention.maxRunAgeDays + 5);
  seedFinishedRun(db, "run-recent", 120, 1);

  const before = db.storageReport();
  assert.equal(before.terminalLogRows, 420);

  const result = db.runMaintenance();

  assert.equal(result.ok, true, result.message);
  assert.equal(result.removedRows, 300, "only the expired run's rows are dropped");
  assert.equal(db.countTerminalLogs("run-old"), 0);
  assert.equal(db.countTerminalLogs("run-recent"), 120, "logs inside the retention window survive");
  assert.equal(db.storageReport().terminalLogRows, 120);

  db.close();
});

test("cleanup reclaims space rather than leaving it on sqlite's free list", async () => {
  const db = await openDatabase("storage-vacuum");
  // Large enough that the freed pages are visible against sqlite's own overhead.
  seedFinishedRun(db, "run-bulk", 4000, logRetention.maxRunAgeDays + 10);

  const before = db.storageReport().sizeBytes;
  const result = db.runMaintenance();
  const after = db.storageReport().sizeBytes;

  assert.equal(result.ok, true, result.message);
  assert.ok(result.removedRows >= 4000 * 0.5, `expected the bulk rows removed, got ${result.removedRows}`);
  // The point of the vacuum: a plain delete leaves page_count unchanged, so this
  // assertion fails if the vacuum is dropped.
  assert.ok(after < before, `expected the file to shrink, went ${before} -> ${after}`);
  assert.equal(result.bytesBefore, before);
  assert.equal(result.bytesAfter, after);
  assert.equal(result.bytesReclaimed, before - after, "the reported delta is the real one");

  db.close();
});

test("an in-flight run's logs are never swept, however old the run looks", async () => {
  const db = await openDatabase("storage-inflight");
  db.createAgentRun({
    id: "run-live",
    cliId: "shell",
    model: "shell",
    prompt: "seed",
    cwd: process.cwd(),
    status: "coding",
    startedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  db.appendTerminalLog("run-live", "stdout", "still streaming\n");

  const result = db.runMaintenance();

  assert.equal(result.ok, true, result.message);
  assert.equal(db.countTerminalLogs("run-live"), 1, "a run with no ended_at is not expired");

  db.close();
});

test("cleanup on an empty store reports that there was nothing to remove", async () => {
  const db = await openDatabase("storage-empty");

  const result = db.runMaintenance();

  assert.equal(result.ok, true, result.message);
  assert.equal(result.removedRows, 0);
  assert.match(result.message, /No logs older than/);
  assert.match(describeMaintenance(result), /already compact/);

  db.close();
});

test("manual cleanup cannot override the retention window", async () => {
  const db = await openDatabase("storage-fixed-age");
  seedFinishedRun(db, "run-too-recent", 12, logRetention.maxRunAgeDays - 1);

  const result = db.runMaintenance();

  assert.equal(result.ok, true, result.message);
  assert.equal(result.removedRows, 0);
  assert.equal(db.countTerminalLogs("run-too-recent"), 12, "logs inside the fixed policy survive manual cleanup");
  db.close();
});

test("byte formatting stays readable and never renders an undefined unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-1), "0 B", "a nonsense size must not render as NaN");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 5.5), "5.5 MB");
  assert.equal(formatBytes(1024 * 1024 * 64), "64 MB");
  // Past the unit list: the exponent is clamped rather than indexing off the end.
  assert.match(formatBytes(1024 ** 6), /TB$/);
});

test("the tone warns on either a large file or a large row count", () => {
  const base = { path: "/tmp/db.sqlite", schemaVersion: 9, retentionDays: 30 };

  assert.equal(storageTone(null), "ok", "no report yet is not a warning");
  assert.equal(storageTone({ ...base, sizeBytes: 1024, terminalLogRows: 10 }), "ok");
  assert.equal(
    storageTone({ ...base, sizeBytes: STORAGE_SUGGEST_CLEANUP_BYTES, terminalLogRows: 10 }),
    "warn",
    "a big file warns even with few rows",
  );
  assert.equal(
    storageTone({ ...base, sizeBytes: 1024, terminalLogRows: STORAGE_SUGGEST_CLEANUP_ROWS }),
    "warn",
    "many rows warn even in a small file",
  );
});

test("the cleanup scope names the retention window instead of being vague", () => {
  assert.match(describeCleanupScope(null), /Reading local storage/);
  assert.match(
    describeCleanupScope({ path: "/tmp/db.sqlite", schemaVersion: 9, sizeBytes: 1, terminalLogRows: 1, retentionDays: 30 }),
    /more than 30 days ago/,
  );
});

test("a delete that could not vacuum is not reported as a no-op", () => {
  // The failure mode worth distinguishing: rows really were removed, but the file
  // did not shrink. Reporting "0 B reclaimed" alone would read as nothing happened.
  const message = describeMaintenance({
    ok: true,
    removedRows: 1200,
    bytesBefore: 5_000_000,
    bytesAfter: 5_000_000,
    bytesReclaimed: 0,
    message: "vacuum blocked",
  });

  assert.match(message, /1,200 log rows removed/);
  assert.match(message, /did not shrink/);

  const failed = describeMaintenance({
    ok: false,
    removedRows: 0,
    bytesBefore: 1,
    bytesAfter: 1,
    bytesReclaimed: 0,
    message: "database is locked",
  });
  assert.match(failed, /Cleanup failed: database is locked/);
});
