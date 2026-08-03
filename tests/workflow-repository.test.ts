import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowSaveInput } from "@contracts";
import { WorkflowRepository } from "../src/main/database/workflow-repository.ts";

function freshRepo(): WorkflowRepository {
  return freshRepoWithDb().repo;
}

function freshRepoWithDb(): { repo: WorkflowRepository; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const repo = new WorkflowRepository(db as never);
  repo.migrate();
  return { repo, db };
}

const sampleInput: WorkflowSaveInput = {
  name: "Investigation Flow",
  description: "Investigate then report",
  status: "active",
  favorite: false,
  owner: "Tester",
  projectPath: null,
  trigger: { type: "manual", detail: "unit test" },
  integrations: ["Kiro CLI", "Slack"],
  steps: [
    {
      name: "Investigate",
      kind: "investigate",
      summary: "Find root cause",
      cliId: "kiro",
      model: "kiro-default",
      instruction: "Investigate the failing path and report findings.",
      timeoutSeconds: 300,
      requiresApproval: false,
      continueOnError: false,
      enabled: true,
    },
    {
      name: "Notify",
      kind: "notify",
      summary: "Send summary",
      cliId: "shell",
      model: "local",
      instruction: "Send the report to the channel.",
      shellCommand: "echo done",
      timeoutSeconds: 60,
      requiresApproval: false,
      continueOnError: true,
      enabled: true,
    },
  ],
};

test("migrate seeds the five reference workflows from workflow.png", () => {
  const repo = freshRepo();
  const list = repo.list();

  assert.equal(list.length, 5);
  assert.deepEqual(
    list.map((workflow) => workflow.name).sort(),
    [
      "Bug Triage Flow",
      "Code Review Pipeline",
      "Content Creation Flow",
      "Deployment Approval Flow",
      "Research Analysis Flow",
    ],
  );
});

test("seeds include investigate (dieu tra) steps and match the reference diagram", () => {
  const repo = freshRepo();
  const list = repo.list();

  const investigateSteps = list.flatMap((workflow) =>
    workflow.steps.filter((step) => step.kind === "investigate"),
  );
  assert.ok(investigateSteps.length >= 1, "expected at least one investigate step");

  const content = list.find((workflow) => workflow.name === "Content Creation Flow");
  assert.ok(content, "Content Creation Flow should exist");
  assert.deepEqual(
    content.steps.map((step) => step.kind),
    ["trigger", "analyze", "review", "execute", "notify"],
  );
  assert.equal(content.stats.runs, 0);
  assert.equal(content.stats.successRate, 0);
  assert.equal(content.stats.lastRunAt, null);
});

test("migrate is idempotent and does not duplicate seeds", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new WorkflowRepository(db as never);
  repo.migrate();
  repo.migrate();
  assert.equal(repo.list().length, 5);
});

test("save creates a workflow with ordered steps and parsed integrations", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);

  assert.ok(saved.id.startsWith("wf-"));
  assert.equal(saved.steps.length, 2);
  assert.deepEqual(
    saved.steps.map((step) => step.order),
    [1, 2],
  );
  assert.equal(saved.steps[0].kind, "investigate");
  assert.equal(saved.steps[1].shellCommand, "echo done");
  assert.deepEqual(saved.integrations, ["Kiro CLI", "Slack"]);
  assert.equal(repo.list().length, 6);
});

test("save with an existing id updates in place and replaces steps", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);

  const updated = repo.save({
    ...sampleInput,
    id: saved.id,
    name: "Renamed Flow",
    steps: [sampleInput.steps[0]],
  });

  assert.equal(updated.id, saved.id);
  assert.equal(updated.name, "Renamed Flow");
  assert.equal(updated.steps.length, 1);
  assert.equal(repo.get(saved.id)?.name, "Renamed Flow");
});

test("run lifecycle recomputes stats from recorded runs", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);

  repo.createRun({
    id: "run-1",
    workflowId: saved.id,
    workflowName: saved.name,
    status: "running",
    triggeredBy: "manual",
    startedAt: new Date().toISOString(),
  });
  repo.finishRun("run-1", "success", 4200);

  const runs = repo.listRuns(saved.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "success");
  assert.equal(runs[0].durationMs, 4200);

  const stats = repo.get(saved.id)?.stats;
  assert.equal(stats?.runs, 1);
  assert.equal(stats?.successRate, 100);
  assert.equal(stats?.lastRunStatus, "success");
});

test("step runs are recorded and returned in order", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);
  repo.createRun({
    id: "run-2",
    workflowId: saved.id,
    workflowName: saved.name,
    status: "running",
    triggeredBy: "manual",
    startedAt: new Date().toISOString(),
  });
  repo.createStepRun({
    id: "sr-1",
    workflowRunId: "run-2",
    stepId: saved.steps[0].id,
    order: 1,
    name: "Investigate",
    kind: "investigate",
    cliId: "kiro",
    status: "running",
    startedAt: new Date().toISOString(),
  });
  repo.finishStepRun("sr-1", { status: "success", durationMs: 1500, exitCode: 0, output: "ok" });

  const run = repo.listRuns(saved.id).find((entry) => entry.id === "run-2");
  assert.ok(run);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, "success");
  assert.equal(run.steps[0].durationMs, 1500);
});

test("duplicate clones as a draft copy with fresh step ids", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);
  const copy = repo.duplicate(saved.id);

  assert.equal(copy.name, "Investigation Flow (copy)");
  assert.equal(copy.status, "draft");
  assert.equal(copy.favorite, false);
  assert.equal(copy.steps.length, saved.steps.length);
  assert.notEqual(copy.steps[0].id, saved.steps[0].id);
  assert.equal(repo.list().length, 7);
});

test("setStatus and toggleFavorite persist", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);

  assert.equal(repo.setStatus(saved.id, "paused").status, "paused");
  assert.equal(repo.get(saved.id)?.status, "paused");

  assert.equal(repo.toggleFavorite(saved.id).favorite, true);
  assert.equal(repo.toggleFavorite(saved.id).favorite, false);
});

test("remove deletes the workflow and its steps", () => {
  const repo = freshRepo();
  const saved = repo.save(sampleInput);

  repo.remove(saved.id);
  assert.equal(repo.get(saved.id), null);
  assert.equal(repo.list().length, 5);
});
