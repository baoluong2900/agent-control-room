import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service.ts";
import { buildTaskPlan } from "../src/main/tasks/task-planner.ts";

test("task planner splits scheduled requirements across multiple agent roles", () => {
  const dueAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const plan = buildTaskPlan({
    projectPath: process.cwd(),
    request:
      "Add a full schedule task automation flow with SQLite migration, IPC, Electron scheduler, multi-agent assignment, difficulty analysis, subtasks, and verification.",
    dueAt,
    preferredCliId: "codex",
    model: "gpt-5-codex",
    automationEnabled: true,
  });

  assert.equal(plan.parent.automationEnabled, false);
  assert.ok(plan.summary.subtaskCount >= 5);
  assert.ok(plan.summary.agentCount >= 3);
  assert.ok(plan.summary.difficulty === "large" || plan.summary.difficulty === "epic");
  assert.ok(plan.subtasks.every((task) => task.automationEnabled));
  assert.ok(plan.subtasks.every((task) => task.dueAt));
});

test("task automation runs due scheduled tasks and links agent history", async () => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-task-automation-${Date.now()}`));
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);

  const task = db.saveTask({
    projectPath: process.cwd(),
    title: "Verify scheduled shell task",
    prompt: "Print a deterministic scheduled task verification message.",
    status: "open",
    assignedCliId: "shell",
    assignedModel: "none",
    dueAt: new Date(Date.now() - 1000).toISOString(),
    difficulty: "small",
    estimatedMinutes: 5,
    automationEnabled: true,
  });

  const result = await automation.runDueTasks();
  assert.equal(result.failed.length, 0);
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].id, task.id);
  assert.equal(result.started[0].status, "investigating");

  await waitFor(() => db.getTask(task.id)?.status === "done");

  const completed = db.getTask(task.id);
  assert.equal(completed?.status, "done");
  assert.equal(completed?.runCount, 1);
  assert.ok(completed?.lastRunId);

  const linkedRun = db.listAgentRuns().find((run) => run.taskId === task.id);
  assert.equal(linkedRun?.status, "completed");
  assert.equal(linkedRun?.cliId, "shell");

  manager.stopAll();
  db.close();
});

async function waitFor(assertion: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for scheduled task completion.");
}
