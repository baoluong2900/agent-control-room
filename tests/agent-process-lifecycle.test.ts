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
