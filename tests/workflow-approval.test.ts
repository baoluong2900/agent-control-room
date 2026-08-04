import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowSaveInput } from "@contracts";
import { WorkflowRepository } from "../src/main/database/workflow-repository.ts";
import { WorkflowService } from "../src/main/workflows/workflow-service.ts";

/**
 * The service only touches `db.workflows` plus the two lookups the provider
 * resolver needs, so a repository wrapper is enough to exercise the approval gate
 * without booting Electron or the full database. The empty provider/profile lists
 * make every step here resolve to no credentials, which is what an unbound shell
 * step should do — `workflow-agent-binding.test.ts` covers the bound case.
 */
function freshService(): { service: WorkflowService; repo: WorkflowRepository } {
  const db = new DatabaseSync(":memory:");
  const repo = new WorkflowRepository(db as never);
  repo.migrate();
  const service = new WorkflowService(
    { workflows: repo, listAgentProfiles: () => [], listProviderConnections: () => [] } as never,
    () => null,
  );
  return { service, repo };
}

function shellStep(name: string, command: string): WorkflowSaveInput["steps"][number] {
  return {
    name,
    kind: "execute",
    summary: name,
    cliId: "shell",
    model: "none",
    instruction: command,
    shellCommand: command,
    timeoutSeconds: 30,
    requiresApproval: false,
    continueOnError: false,
    enabled: true,
  };
}

function workflowWith(steps: WorkflowSaveInput["steps"]): WorkflowSaveInput {
  return {
    name: "Approval Flow",
    description: "Gate in the middle",
    status: "active",
    favorite: false,
    owner: "Tester",
    projectPath: process.cwd(),
    trigger: { type: "manual" },
    integrations: [],
    steps,
  };
}

function stepRun(steps: WorkflowStepRuns, name: string) {
  const found = steps.find((step) => step.name === name);
  assert.ok(found, `expected a step run for "${name}"`);
  return found;
}

type WorkflowStepRuns = Array<{ name: string; status: string; output?: string | null }>;

test("an approval step parks the run instead of ending it", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([
      shellStep("First", "echo first"),
      {
        ...shellStep("Sign off", "echo gate"),
        kind: "approval",
      },
      shellStep("Last", "echo last"),
    ]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });

  assert.equal(parked.status, "waiting-approval");
  assert.equal(service.isWaitingForApproval(parked.id), true);
  assert.equal(stepRun(parked.steps, "First").status, "success");
  assert.equal(stepRun(parked.steps, "Sign off").status, "waiting-approval");
  // The gated step and everything after it must not have executed yet.
  assert.equal(
    parked.steps.some((step) => step.name === "Last"),
    false,
  );
});

test("approving a gate resumes the remaining steps and completes the run", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([
      shellStep("First", "echo first"),
      { ...shellStep("Sign off", "echo gate"), kind: "approval" },
      shellStep("Last", "echo last"),
    ]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  const resumed = await service.approve(parked.id);

  assert.equal(resumed.status, "success");
  assert.equal(service.isWaitingForApproval(parked.id), false);
  assert.equal(stepRun(resumed.steps, "Sign off").status, "success");
  assert.equal(stepRun(resumed.steps, "Sign off").output, "Approved by user.");
  assert.equal(stepRun(resumed.steps, "Last").status, "success");
  assert.ok((resumed.durationMs ?? 0) >= 0);
});

test("a step flagged requiresApproval still executes once it is approved", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([
      { ...shellStep("Deploy", "echo deployed"), requiresApproval: true },
      shellStep("Notify", "echo notified"),
    ]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  assert.equal(parked.status, "waiting-approval");

  const resumed = await service.approve(parked.id);
  assert.equal(resumed.status, "success");

  // Unlike an `approval` step, this one carries a command that must have run,
  // so it gets a second step-run row holding the real output.
  const deployRuns = resumed.steps.filter((step) => step.name === "Deploy");
  assert.equal(deployRuns.length, 2);
  assert.ok(deployRuns.some((step) => step.output === "Approved by user."));
  assert.ok(deployRuns.some((step) => (step.output ?? "").includes("deployed")));
  assert.equal(stepRun(resumed.steps, "Notify").status, "success");
});

test("rejecting a gate cancels the run and skips the remaining steps", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([
      { ...shellStep("Sign off", "echo gate"), kind: "approval" },
      shellStep("Never runs", "echo nope"),
    ]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  const rejected = await service.reject(parked.id, "not ready");

  assert.equal(rejected.status, "cancelled");
  assert.equal(service.isWaitingForApproval(parked.id), false);
  assert.equal(stepRun(rejected.steps, "Sign off").status, "cancelled");
  assert.match(stepRun(rejected.steps, "Sign off").output ?? "", /not ready/);
  assert.equal(
    rejected.steps.some((step) => step.name === "Never runs"),
    false,
  );
});

test("cancelling a parked run settles the gate the same way a rejection does", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([{ ...shellStep("Sign off", "echo gate"), kind: "approval" }, shellStep("Never runs", "echo nope")]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  await service.cancel(parked.id);

  const finished = repo.getRun(parked.id);
  assert.equal(finished?.status, "cancelled");
  assert.equal(service.isWaitingForApproval(parked.id), false);
});

test("approve and reject reject run ids that are not waiting on a gate", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(workflowWith([shellStep("Only", "echo only")]));

  const finished = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  assert.equal(finished.status, "success");

  await assert.rejects(() => service.approve(finished.id), /is not waiting for approval/);
  await assert.rejects(() => service.reject(finished.id), /is not waiting for approval/);
});

test("a dry run walks straight through approval gates", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([
      { ...shellStep("Deploy", "echo deployed"), requiresApproval: true },
      { ...shellStep("Sign off", "echo gate"), kind: "approval" },
    ]),
  );

  const result = await service.run({ workflowId: workflow.id, triggeredBy: "manual", dryRun: true });

  assert.equal(result.status, "success");
  assert.equal(service.isWaitingForApproval(result.id), false);
  assert.match(stepRun(result.steps, "Deploy").output ?? "", /\[dry-run\]/);
});

test("run stats exclude a run that is still parked on a gate", async () => {
  const { service, repo } = freshService();
  const workflow = repo.save(
    workflowWith([{ ...shellStep("Sign off", "echo gate"), kind: "approval" }, shellStep("Last", "echo last")]),
  );

  const parked = await service.run({ workflowId: workflow.id, triggeredBy: "manual" });
  assert.equal(repo.get(workflow.id)?.stats.runs, 0);

  await service.approve(parked.id);
  const after = repo.get(workflow.id);
  assert.equal(after?.stats.runs, 1);
  assert.equal(after?.stats.successRate, 100);
});
