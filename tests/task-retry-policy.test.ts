import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service.ts";
import {
  BASE_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffMs,
  classifyFailure,
  isStalled,
  planRetry,
} from "../src/main/tasks/retry-policy.ts";

async function openDb(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `agentic-retry-${label}-${Date.now()}-${Math.random()}`));
}

test("a missing binary is permanent, a transient spawn error is not", () => {
  assert.equal(classifyFailure("spawn codex ENOENT"), "permanent");
  assert.equal(classifyFailure("claude: command not found"), "permanent");
  assert.equal(classifyFailure("EACCES: permission denied"), "permanent");
  assert.equal(classifyFailure("provider returned 429 rate limit"), "transient");
  assert.equal(classifyFailure("socket hang up"), "transient");
});

test("backoff doubles per attempt and stops at the ceiling", () => {
  const noJitter = () => 0;
  assert.equal(backoffMs(1, noJitter), BASE_BACKOFF_MS);
  assert.equal(backoffMs(2, noJitter), BASE_BACKOFF_MS * 2);
  assert.equal(backoffMs(3, noJitter), BASE_BACKOFF_MS * 4);
  assert.equal(backoffMs(20, noJitter), MAX_BACKOFF_MS);
  // Jitter only ever pushes the wait later, never earlier.
  assert.ok(backoffMs(1, () => 1) > BASE_BACKOFF_MS);
});

test("a transient failure schedules the next attempt, the last one gives up", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const first = planRetry({ attemptCount: 0, maxAttempts: 3, message: "socket hang up", now, random: () => 0 });
  assert.equal(first.attemptCount, 1);
  assert.equal(first.status, "open");
  assert.equal(first.nextRetryAt, new Date(now.getTime() + BASE_BACKOFF_MS).toISOString());

  const second = planRetry({ attemptCount: 1, maxAttempts: 3, message: "socket hang up", now, random: () => 0 });
  assert.equal(second.status, "open");
  assert.ok(Date.parse(second.nextRetryAt!) > Date.parse(first.nextRetryAt!));

  const last = planRetry({ attemptCount: 2, maxAttempts: 3, message: "socket hang up", now });
  assert.equal(last.attemptCount, 3);
  assert.equal(last.status, "failed");
  assert.equal(last.nextRetryAt, null);
});

test("a permanent failure burns the whole budget on the first attempt", () => {
  const decision = planRetry({ attemptCount: 0, maxAttempts: 3, message: "spawn nope ENOENT" });
  assert.equal(decision.status, "failed");
  assert.equal(decision.attemptCount, 3);
  assert.equal(decision.nextRetryAt, null);
});

test("a run is stalled only when it has gone silent", () => {
  const now = new Date("2026-01-01T06:00:00.000Z");
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();

  // Long-running but still writing output: must survive.
  assert.equal(
    isStalled({
      startedAt: threeHoursAgo,
      lastOutputAt: new Date(now.getTime() - 60_000).toISOString(),
      now,
    }),
    false,
  );

  // Same age, no output for an hour: hung.
  assert.equal(
    isStalled({
      startedAt: threeHoursAgo,
      lastOutputAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      now,
    }),
    true,
  );

  // Never produced a line at all, and past the silence window.
  assert.equal(isStalled({ startedAt: threeHoursAgo, lastOutputAt: null, now }), true);

  // Fresh run with no output yet is not stalled.
  assert.equal(
    isStalled({ startedAt: new Date(now.getTime() - 30_000).toISOString(), lastOutputAt: null, now }),
    false,
  );
});

test("a task that fails before its run is recorded does not stay due forever", async () => {
  const db = await openDb("infinite");
  // The regression lives in the branch where `start()` itself throws — the run
  // row never exists, so nothing downstream can settle the task. A stub manager
  // reproduces that deterministically; a real CLI would be queued and fail later
  // through `finishTaskRun`, which is a different path.
  const manager = {
    async start() {
      throw new Error("spawn nonexistent-cli ENOENT");
    },
  } as unknown as AgentProcessManager;
  const automation = new TaskAutomationService(db, manager, () => null);

  const task = db.saveTask({
    projectPath: process.cwd(),
    title: "Fails before the run row exists",
    prompt: "This CLI does not exist on PATH.",
    status: "open",
    assignedCliId: "custom",
    dueAt: new Date(Date.now() - 1000).toISOString(),
    automationEnabled: true,
  });
  assert.equal(task.attemptCount, 0);
  assert.equal(task.maxAttempts, DEFAULT_MAX_ATTEMPTS);

  const result = await automation.runDueTasks();
  assert.equal(result.started.length, 0);
  assert.equal(result.failed.length, 1);

  const after = db.getTask(task.id);
  assert.ok(after);
  // The old code left the row `open` with a past `due_at`, so it was respawned
  // on every 30-second tick. ENOENT is permanent, so it must stop immediately.
  assert.equal(after.status, "failed");
  assert.equal(after.attemptCount, DEFAULT_MAX_ATTEMPTS, "a hopeless failure must not burn three ticks");
  assert.ok(after.lastError?.includes("ENOENT"));
  assert.equal(
    db.listDueTasks().some((due) => due.id === task.id),
    false,
    "a task that just failed must not be immediately due again",
  );

  db.close();
});

test("backoff keeps a task out of the due list until its retry time", async () => {
  const db = await openDb("backoff");

  const task = db.saveTask({
    projectPath: process.cwd(),
    title: "Waiting on backoff",
    prompt: "noop",
    status: "open",
    assignedCliId: "shell",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    automationEnabled: true,
  });

  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  db.recordTaskFailure({
    id: task.id,
    attemptCount: 1,
    status: "open",
    nextRetryAt: future,
    lastError: "socket hang up",
  });

  assert.equal(db.listDueTasks().some((due) => due.id === task.id), false);
  assert.equal(
    db.listDueTasks(new Date(Date.now() + 6 * 60_000).toISOString()).some((due) => due.id === task.id),
    true,
    "the task becomes due again once the backoff has elapsed",
  );

  db.close();
});

test("an exhausted task is failed, invisible to the scheduler, and revivable", async () => {
  const db = await openDb("exhausted");

  const task = db.saveTask({
    projectPath: process.cwd(),
    title: "Out of attempts",
    prompt: "noop",
    status: "open",
    assignedCliId: "shell",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    automationEnabled: true,
    maxAttempts: 2,
  });
  assert.equal(task.maxAttempts, 2);

  db.recordTaskFailure({
    id: task.id,
    attemptCount: 2,
    status: "failed",
    nextRetryAt: null,
    lastError: "spawn nope ENOENT",
  });

  const failed = db.getTask(task.id);
  assert.equal(failed?.status, "failed");
  assert.equal(db.listDueTasks().some((due) => due.id === task.id), false);

  const revived = db.resetTaskRetries(task.id);
  assert.equal(revived?.status, "open");
  assert.equal(revived?.attemptCount, 0);
  assert.equal(revived?.lastError, null);
  assert.equal(db.listDueTasks().some((due) => due.id === task.id), true);

  db.close();
});

test("a failed agent run marks the task failed, not blocked", async () => {
  const db = await openDb("finish");

  const task = db.saveTask({
    projectPath: process.cwd(),
    title: "Agent exits non-zero",
    prompt: "noop",
    status: "open",
    assignedCliId: "shell",
    automationEnabled: true,
  });

  db.finishTaskRun(task.id, "failed", "run-1");
  assert.equal(db.getTask(task.id)?.status, "failed");

  // A later success clears the retry bookkeeping so the next failure starts over.
  db.recordTaskFailure({
    id: task.id,
    attemptCount: 2,
    status: "open",
    nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    lastError: "socket hang up",
  });
  db.finishTaskRun(task.id, "completed", "run-2");
  const done = db.getTask(task.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.attemptCount, 0);
  assert.equal(done?.nextRetryAt, null);
  assert.equal(done?.lastError, null);

  db.close();
});

test("a hung run is reaped while a slow but talkative one is left alone", async () => {
  const db = await openDb("stall");
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);

  const silent = db.saveTask({
    projectPath: process.cwd(),
    title: "Hung agent",
    prompt: "noop",
    status: "open",
    assignedCliId: "shell",
    automationEnabled: true,
  });
  const talkative = db.saveTask({
    projectPath: process.cwd(),
    title: "Slow but alive",
    prompt: "noop",
    status: "open",
    assignedCliId: "shell",
    automationEnabled: true,
  });

  const startedAt = new Date().toISOString();
  for (const [runId, taskId] of [
    ["run-silent", silent.id],
    ["run-talkative", talkative.id],
  ] as const) {
    db.createAgentRun({
      id: runId,
      cliId: "shell",
      cwd: process.cwd(),
      prompt: "noop",
      taskId,
      status: "planning",
      startedAt,
    });
    db.markTaskRunStarted(taskId, runId);
  }

  // The silence window is shrunk to a second so the two cases separate without
  // waiting fifteen real minutes: both runs are older than the window, but only
  // one of them writes a line just before the sweep.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  db.appendTerminalLog("run-talkative", "stdout", "still refactoring...");

  const reaped = await automation.sweepStalledTasks({ silenceMs: 1_000 });

  assert.equal(reaped.length, 1, "only the silent run is reaped");
  const hung = db.getTask(silent.id);
  // A stall is a transient failure, so the first one earns a backoff rather than
  // a terminal `failed` — what matters is that it left `investigating`.
  assert.equal(hung?.status, "open");
  assert.equal(hung?.attemptCount, 1);
  assert.ok(hung?.nextRetryAt, "the retry is scheduled, not immediate");
  assert.ok(hung?.lastError?.includes("no output"));
  assert.equal(db.getTask(talkative.id)?.status, "investigating", "a run still writing output survives");

  manager.stopAll();
  db.close();
});
