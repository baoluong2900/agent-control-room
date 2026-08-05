import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service.ts";

async function openDatabase(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `spawn-failure-${label}-${Date.now()}-${Math.random()}`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dueTask(db: DesktopDatabase, title: string) {
  return db.saveTask({
    title,
    prompt: "do work",
    projectPath: process.cwd(),
    assignedCliId: "shell",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    automationEnabled: true,
    status: "open",
  });
}

/**
 * A failure raised inside `spawnQueued` lands after `start()` has already
 * resolved, so the scheduler's own catch block never sees it. Without the
 * manager applying the retry policy itself the task was parked in `failed` with
 * `attempt_count` still 0 and no backoff, which the scheduler can never undo.
 */
test("a spawn failure after enqueue still consumes an attempt and earns a backoff", async () => {
  const db = await openDatabase("retry-accounting");
  const manager = new AgentProcessManager(db, () => null);
  const task = dueTask(db, "provider bound task");

  // resolveProviderEnv() throws inside spawnQueued: an explicit connection id
  // that resolves to nothing. Preflight passes because `shell` needs no binary.
  await manager
    .start({
      cliId: "shell",
      cwd: process.cwd(),
      prompt: "echo hi",
      shellCommand: "echo hi",
      taskId: task.id,
      providerConnectionId: "does-not-exist",
    })
    .catch(() => undefined);

  await sleep(400);

  const after = db.getTask(task.id);
  assert.equal(after?.attemptCount, 1, "the failed attempt was counted");
  assert.equal(after?.status, "open", "one attempt left means the task stays retryable");
  assert.ok(after?.nextRetryAt, "a backoff was scheduled");
  assert.match(after?.lastError ?? "", /Provider connection/);
  db.close();
});

/**
 * A permanent spawn failure burns the whole budget at once, so the task parks in
 * `failed` instead of being respawned every tick.
 */
test("a permanent spawn failure parks the task in failed", async () => {
  const db = await openDatabase("permanent");
  const manager = new AgentProcessManager(db, () => null);
  const task = dueTask(db, "missing cli task");

  await manager
    .start({
      cliId: "claude",
      cwd: process.cwd(),
      prompt: "echo hi",
      taskId: task.id,
      commandOverride: "definitely-not-a-real-binary-xyz",
    })
    .catch(() => undefined);

  await sleep(400);

  const after = db.getTask(task.id);
  assert.equal(after?.status, "failed", "a missing binary is hopeless, so it parks");
  assert.equal(after?.attemptCount, after?.maxAttempts, "the whole budget is burned at once");
  assert.equal(after?.nextRetryAt, null);
  db.close();
});

/**
 * stdout is flushed asynchronously and can arrive after the exit handler has
 * already recorded a terminal status. A status hint in that late output used to
 * resurrect the finished run into "coding"/"testing".
 */
test("output flushed after exit does not overwrite a terminal status", async () => {
  const db = await openDatabase("late-stdout");
  const manager = new AgentProcessManager(db, () => null);

  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "burst",
    // Enough output that the last chunks land after exit, and every line
    // matches a status hint ("implement"/"patch" -> coding).
    shellCommand: 'for i in $(seq 1 4000); do echo "implement patch line $i"; done',
  });

  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = db.listAgentRuns().find((run) => run.id === started.runId)?.status;
    if (status === "completed" || status === "failed") break;
    await sleep(25);
  }

  assert.equal(db.listAgentRuns().find((run) => run.id === started.runId)?.status, "completed");
  await sleep(500);
  assert.equal(
    db.listAgentRuns().find((run) => run.id === started.runId)?.status,
    "completed",
    "a late stdout hint must not relabel a finished run",
  );
  db.close();
});

/**
 * `markTaskRunStarted` flips a task to `investigating` at enqueue time, so a run
 * waiting behind the concurrency limit looks identical to a hung agent. Reaping
 * it failed a task whose agent had never even spawned.
 */
test("a queued run that never spawned is not reaped as stalled", async () => {
  const db = await openDatabase("queued-stall");
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);
  const task = dueTask(db, "queued task");

  // Saturate every concurrency slot with long-lived children.
  for (let index = 0; index < 3; index += 1) {
    await manager.start({ cliId: "shell", cwd: process.cwd(), prompt: "sleep 30", shellCommand: "sleep 30" });
  }
  const queuedRun = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "sleep 30",
    shellCommand: "sleep 30",
    taskId: task.id,
  });

  assert.equal(db.getAgentRun(queuedRun.runId)?.status, "queued", "the fourth run only queued");
  assert.equal(db.getTask(task.id)?.status, "investigating");

  const reaped = await automation.sweepStalledTasks({
    now: new Date(Date.now() + 20 * 60_000),
    silenceMs: 15 * 60_000,
  });

  assert.equal(reaped.length, 0, "a run with no child cannot be silent");
  assert.equal(db.getTask(task.id)?.status, "investigating", "the task keeps waiting for its slot");

  manager.stopAll();
  await sleep(300);
  db.close();
});

/**
 * Quitting used to drop the queue on the floor, leaving the run row `queued` and
 * its task `investigating` across every future restart.
 */
test("quitting settles queued runs and leaves their tasks retryable", async () => {
  const db = await openDatabase("quit-queue");
  const manager = new AgentProcessManager(db, () => null);
  const task = dueTask(db, "abandoned task");

  for (let index = 0; index < 3; index += 1) {
    await manager.start({ cliId: "shell", cwd: process.cwd(), prompt: "sleep 30", shellCommand: "sleep 30" });
  }
  const queuedRun = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "sleep 30",
    shellCommand: "sleep 30",
    taskId: task.id,
  });
  assert.equal(db.getAgentRun(queuedRun.runId)?.status, "queued");

  manager.stopAll();
  await sleep(400);

  assert.equal(db.getAgentRun(queuedRun.runId)?.status, "stopped", "the abandoned run was settled");
  const after = db.getTask(task.id);
  assert.equal(after?.status, "open", "the task is retryable on the next launch");
  assert.equal(after?.attemptCount, 0, "quitting is not the task's fault, so no attempt is spent");
  assert.equal(after?.nextRetryAt, null);
  db.close();
});
