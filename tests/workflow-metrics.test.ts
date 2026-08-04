import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowRunStatus, WorkflowSaveInput } from "@contracts";
import { WorkflowRepository } from "../src/main/database/workflow-repository.ts";
import { WorkflowService } from "../src/main/workflows/workflow-service.ts";

/**
 * `metrics()` compares the last 30 days against the 30 before, so every test here
 * pins `now` and plants runs at explicit `startedAt` values rather than letting the
 * clock decide which window a row lands in.
 */
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp `days` before the pinned `now`. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function freshService(): { service: WorkflowService; repo: WorkflowRepository } {
  const db = new DatabaseSync(":memory:");
  const repo = new WorkflowRepository(db as never);
  repo.migrate();
  // `migrate()` installs demo workflows. Unlike the other suites, which only ever
  // assert on their own rows, metrics aggregates the whole database — so the seeds
  // would land in every count here. Drop them for a genuinely empty baseline.
  db.exec("delete from workflow_runs");
  db.exec("delete from workflows");
  const service = new WorkflowService(
    { workflows: repo, listAgentProfiles: () => [], listProviderConnections: () => [] } as never,
    () => null,
  );
  return { service, repo };
}

function workflowInput(name: string, status: WorkflowSaveInput["status"] = "active"): WorkflowSaveInput {
  return {
    name,
    description: "Metrics fixture",
    status,
    favorite: false,
    owner: "Tester",
    projectPath: process.cwd(),
    trigger: { type: "manual" },
    integrations: [],
    steps: [
      {
        name: "Only",
        kind: "execute",
        summary: "Only",
        cliId: "shell",
        model: "none",
        instruction: "echo hi",
        shellCommand: "echo hi",
        timeoutSeconds: 30,
        requiresApproval: false,
        continueOnError: false,
        enabled: true,
      },
    ],
  };
}

/**
 * Plants a finished run directly. `createRun` takes an explicit `startedAt`, which
 * is the only way to put a row in the *previous* 30-day window — running the
 * workflow for real would always stamp it "now".
 */
let runSeq = 0;
function plantRun(repo: WorkflowRepository, workflowId: string, status: WorkflowRunStatus, startedAt: string): void {
  runSeq += 1;
  repo.createRun({
    id: `run-${runSeq}`,
    workflowId,
    workflowName: "Metrics fixture",
    status,
    triggeredBy: "manual",
    startedAt,
  });
}

test("metrics reports no deltas when there is no prior period to compare against", () => {
  const { service, repo } = freshService();
  const workflow = repo.save(workflowInput("Fresh"));
  plantRun(repo, workflow.id, "success", daysAgo(3));

  const metrics = service.metrics(NOW);

  // A change from zero is an infinite increase, not "+100%", so the cards show
  // no trend at all rather than a fabricated one.
  assert.equal(metrics.runsDeltaPercent, undefined, "no runs last period means no runs trend");
  assert.equal(metrics.successDeltaPercent, undefined, "no runs last period means no success trend");
});

test("metrics computes a positive run delta when this period beat the last", () => {
  const { service, repo } = freshService();
  const workflow = repo.save(workflowInput("Busier"));

  // Previous window: 2 runs. Current window: 3 runs. +50%.
  plantRun(repo, workflow.id, "success", daysAgo(45));
  plantRun(repo, workflow.id, "success", daysAgo(40));
  plantRun(repo, workflow.id, "success", daysAgo(20));
  plantRun(repo, workflow.id, "success", daysAgo(10));
  plantRun(repo, workflow.id, "success", daysAgo(2));

  assert.equal(service.metrics(NOW).runsDeltaPercent, 50);
});

test("metrics computes a negative run delta when this period fell behind", () => {
  const { service, repo } = freshService();
  const workflow = repo.save(workflowInput("Quieter"));

  // Previous window: 4 runs. Current window: 1 run. -75%.
  plantRun(repo, workflow.id, "success", daysAgo(50));
  plantRun(repo, workflow.id, "success", daysAgo(45));
  plantRun(repo, workflow.id, "success", daysAgo(40));
  plantRun(repo, workflow.id, "success", daysAgo(35));
  plantRun(repo, workflow.id, "success", daysAgo(5));

  const metrics = service.metrics(NOW);
  assert.equal(metrics.runsDeltaPercent, -75);
  assert.ok(metrics.runsDeltaPercent !== undefined && metrics.runsDeltaPercent < 0, "renderer keys the arrow off the sign");
});

test("metrics tracks the success-rate trend separately from run volume", () => {
  const { service, repo } = freshService();
  const workflow = repo.save(workflowInput("Recovering"));

  // Previous window: 1 of 2 succeeded (50%). Current: 2 of 2 (100%). +100%.
  plantRun(repo, workflow.id, "success", daysAgo(50));
  plantRun(repo, workflow.id, "failed", daysAgo(45));
  plantRun(repo, workflow.id, "success", daysAgo(10));
  plantRun(repo, workflow.id, "success", daysAgo(5));

  const metrics = service.metrics(NOW);
  assert.equal(metrics.successDeltaPercent, 100);
  // Volume was flat across the two windows, so that card must show no trend.
  assert.equal(metrics.runsDeltaPercent, 0);
});

test("countRunsInPeriod excludes runs outside the window on both ends", () => {
  const { repo } = freshService();
  const workflow = repo.save(workflowInput("Boundaries"));

  plantRun(repo, workflow.id, "success", daysAgo(31));
  plantRun(repo, workflow.id, "success", daysAgo(15));
  plantRun(repo, workflow.id, "failed", daysAgo(15));

  const counts = repo.countRunsInPeriod(daysAgo(30), NOW.toISOString());

  assert.equal(counts.runs, 2, "the 31-day-old run belongs to the previous window");
  assert.equal(counts.successes, 1);
});

test("countRunsInPeriod counts only workflows that existed at the end of the window", () => {
  const { repo } = freshService();
  repo.save(workflowInput("Active one"));
  repo.save(workflowInput("Paused one", "paused"));

  // Both were created "now", so a window that closed 30 days ago predates them.
  const past = repo.countRunsInPeriod(daysAgo(60), daysAgo(30));
  assert.equal(past.workflows, 0, "a workflow cannot exist before it was created");

  const present = repo.countRunsInPeriod(daysAgo(30), new Date(Date.now() + DAY_MS).toISOString());
  assert.equal(present.workflows, 2);
  assert.equal(present.activeWorkflows, 1, "only the active one counts toward the active card");
});

test("metrics defaults to the real clock when no time is pinned", () => {
  const { service, repo } = freshService();
  repo.save(workflowInput("Default clock"));

  // The argument exists for tests; production calls it with no arguments and must
  // still get a well-formed object rather than throwing on an undefined date.
  const metrics = service.metrics();
  assert.equal(metrics.totalWorkflows, 1);
  assert.equal(metrics.activeWorkflows, 1);
});
