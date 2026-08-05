import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";

/** Waits for a run to leave the running set, i.e. its child process has exited. */
async function waitForExit(manager: AgentProcessManager, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!manager.sessions().some((session) => session.runId === runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never exited`);
}

async function openDatabase(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `agentic-${label}-${Date.now()}-${Math.random()}`));
}

function statusOf(db: DesktopDatabase, runId: string): string | undefined {
  return db.listAgentRuns().find((run) => run.id === runId)?.status;
}

async function waitForStatus(db: DesktopDatabase, runId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (statusOf(db, runId) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

async function waitForSessionCount(manager: AgentProcessManager, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.sessions().length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session count never reached ${count}`);
}

/**
 * Waits until the queue has actually filled every concurrency slot. Session
 * count alone is not enough: a run is listed the moment it is queued, so four
 * sessions can still mean two spawned and two waiting while the drain loop
 * awaits its next spawn.
 */
async function waitForRunningCount(manager: AgentProcessManager, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (manager.sessions().filter((session) => session.status !== "queued").length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`running count never reached ${count}`);
}

test("stopping a run keeps the stopped status once SIGTERM lands", async () => {
  const db = await openDatabase("stop-status");
  const manager = new AgentProcessManager(db, () => null);

  // A long-lived child, so stop() is what ends it rather than natural completion.
  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "sleep 30",
    shellCommand: "sleep 30",
  });

  await manager.stop(started.runId);
  assert.equal(statusOf(db, started.runId), "stopped");

  // The exit handler fires after stop() returns; it must not relabel the run.
  await waitForExit(manager, started.runId);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(statusOf(db, started.runId), "stopped");
  db.close();
});

test("a run that fails on its own is still recorded as failed", async () => {
  const db = await openDatabase("exit-failed");
  const manager = new AgentProcessManager(db, () => null);

  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "exit 3",
    shellCommand: "exit 3",
  });

  await waitForExit(manager, started.runId);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(statusOf(db, started.runId), "failed");
  db.close();
});

test("stopAll lets the app close the database without a late write throwing", async () => {
  const db = await openDatabase("shutdown");
  const manager = new AgentProcessManager(db, () => null);

  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "sleep 30",
    shellCommand: "sleep 30",
  });

  // The real quit path: signal every child, then close the database immediately.
  // The children exit afterwards, so their handlers must not touch the handle.
  manager.stopAll();
  db.close();

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!manager.sessions().some((session) => session.runId === started.runId));
});

test("agent starts beyond the concurrency limit stay queued until a slot opens", async () => {
  const db = await openDatabase("concurrency-limit");
  const manager = new AgentProcessManager(db, () => null);

  const runs = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      manager.start({
        cliId: "shell",
        cwd: process.cwd(),
        prompt: `sleep ${index}`,
        shellCommand: "sleep 30",
      }),
    ),
  );

  await waitForSessionCount(manager, 4);
  await waitForRunningCount(manager, 3);
  const sessions = manager.sessions();
  assert.equal(sessions.filter((session) => session.status === "queued").length, 1);
  assert.equal(sessions.filter((session) => session.status !== "queued").length, 3);
  assert.equal(statusOf(db, runs[3].runId), "queued");

  await manager.stop(runs[0].runId);
  await waitForStatus(db, runs[3].runId, "planning");
  assert.equal(manager.sessions().filter((session) => session.status !== "queued").length, 3);

  manager.stopAll();
  db.close();
});

test("a queued run can be cancelled before it ever spawns", async () => {
  const db = await openDatabase("cancel-queued");
  const manager = new AgentProcessManager(db, () => null);

  const runs = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      manager.start({
        cliId: "shell",
        cwd: process.cwd(),
        prompt: `queued ${index}`,
        shellCommand: "sleep 30",
      }),
    ),
  );
  await waitForSessionCount(manager, 4);

  await manager.stop(runs[3].runId);

  assert.equal(statusOf(db, runs[3].runId), "stopped");
  assert.equal(manager.sessions().some((session) => session.runId === runs[3].runId), false);

  manager.stopAll();
  db.close();
});

test("a run whose CLI is not installed fails loudly instead of queueing forever", async () => {
  // Regression: queueing made start() resolve before the spawn was attempted,
  // so an unresolvable binary handed the caller a healthy "queued" handle and
  // the UI showed an agent that would never run.
  const db = await openDatabase("missing-binary");
  const manager = new AgentProcessManager(db, () => null);

  await assert.rejects(
    manager.start({
      cliId: "custom",
      cwd: process.cwd(),
      prompt: "hello",
      commandOverride: "definitely-not-a-real-binary-xyz",
    }),
    /not found/,
  );

  assert.equal(manager.sessions().length, 0, "a run that cannot spawn must not sit in the queue");
  const failed = db.listAgentRuns().find((run) => run.status === "failed");
  assert.ok(failed, "the failure is recorded in history");

  manager.stopAll();
  db.close();
});

test("restarting a finished run creates a new run with the original command", async () => {
  const db = await openDatabase("restart-finished");
  const manager = new AgentProcessManager(db, () => null);

  const first = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "printf restart-ok",
    shellCommand: "printf restart-ok",
  });
  await waitForExit(manager, first.runId);
  await waitForStatus(db, first.runId, "completed");

  const second = await manager.restart(first.runId);
  assert.notEqual(second.runId, first.runId);
  await waitForExit(manager, second.runId);
  await waitForStatus(db, second.runId, "completed");

  const logs = db.listTerminalLogs(second.runId);
  assert.ok(logs.some((row) => row.message.includes("restart-ok")), "the restarted run used the saved prompt");
  db.close();
});

test("restarting a live run stops it and queues a replacement", async () => {
  const db = await openDatabase("restart-live");
  const manager = new AgentProcessManager(db, () => null);

  const first = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "sleep 30",
    shellCommand: "sleep 30",
  });

  await waitForStatus(db, first.runId, "planning");
  const second = await manager.restart(first.runId);

  assert.equal(statusOf(db, first.runId), "stopped");
  assert.notEqual(second.runId, first.runId);
  assert.ok(manager.sessions().some((session) => session.runId === second.runId));

  manager.stopAll();
  db.close();
});
