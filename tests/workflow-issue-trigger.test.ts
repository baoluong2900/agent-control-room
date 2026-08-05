import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { listOpenIssues, parseIssueTrigger } from "../src/main/workflows/issue-poller.ts";
import { WorkflowSchedulerService } from "../src/main/workflows/workflow-scheduler.ts";
import type { WorkflowService } from "../src/main/workflows/workflow-service.ts";

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wf-issue",
    name: "Triage",
    description: "",
    status: "active",
    favorite: false,
    owner: "You",
    projectPath: "/tmp/repo",
    trigger: { type: "issue-created" },
    integrations: [],
    steps: [
      {
        id: "s1",
        name: "Run",
        kind: "execute",
        summary: "",
        cliId: "shell",
        model: "",
        shellCommand: "true",
        timeoutSeconds: 30,
        requiresApproval: false,
        continueOnError: false,
        enabled: true,
        order: 0,
      },
    ],
    stats: { runs: 0, successRate: 0, avgDurationMs: 0, lastRunAt: null },
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkflowDefinition;
}

function fakeWorkflows(definitions: WorkflowDefinition[]) {
  const runs: Array<{ workflowId: string; triggeredBy?: string }> = [];
  const service = {
    list: () => definitions,
    run: async (input: { workflowId: string; triggeredBy?: string }) => {
      runs.push(input);
      return { id: "run-1" };
    },
  } as unknown as WorkflowService;
  return { service, runs };
}

const issue = (number: number, title = `Issue ${number}`) => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  createdAt: "2026-08-06T00:00:00Z",
});

/** Scripted `gh`: each call returns the next batch, repeating the last. */
function fakeGh(batches: Array<ReturnType<typeof issue>[]>, options: { labelled?: number[] } = {}) {
  const calls: string[][] = [];
  let index = 0;

  const run = async (_cwd: string, args: string[]) => {
    calls.push(args);
    const labelIndex = args.indexOf("--label");
    if (labelIndex !== -1) {
      const allowed = new Set(options.labelled ?? []);
      const current = batches[Math.min(index - 1, batches.length - 1)] ?? [];
      return { ok: true, output: JSON.stringify(current.filter((entry) => allowed.has(entry.number))) };
    }
    const batch = batches[Math.min(index, batches.length - 1)] ?? [];
    index += 1;
    return { ok: true, output: JSON.stringify(batch) };
  };

  return { run, calls };
}

test("parseIssueTrigger reads a bare label or key=value", () => {
  assert.deepEqual(parseIssueTrigger(undefined), {}, "unconfigured watches every issue");
  assert.deepEqual(parseIssueTrigger("  "), {});
  assert.deepEqual(parseIssueTrigger("bug"), { label: "bug" });
  assert.deepEqual(parseIssueTrigger("label=needs triage"), { label: "needs triage" });
  assert.deepEqual(parseIssueTrigger("labels=bug"), { label: "bug" });
});

test("listOpenIssues returns null rather than an empty list when gh cannot answer", async () => {
  // The distinction that matters: "no issues" and "cannot tell" must not look the
  // same, or a logged-out gh would read as a quiet repo and later fire on everything.
  const notInstalled = await listOpenIssues("/tmp/repo", async () => ({ ok: false, output: "command not found" }));
  assert.equal(notInstalled, null);

  const loggedOut = await listOpenIssues("/tmp/repo", async () => ({ ok: false, output: "gh auth login required" }));
  assert.equal(loggedOut, null);

  const notJson = await listOpenIssues("/tmp/repo", async () => ({ ok: true, output: "A new release of gh is available" }));
  assert.equal(notJson, null);

  const empty = await listOpenIssues("/tmp/repo", async () => ({ ok: true, output: "[]" }));
  assert.deepEqual(empty, [], "an actually-empty repo is an empty list, not null");
});

test("listOpenIssues drops malformed entries instead of trusting the shape", async () => {
  const mixed = await listOpenIssues("/tmp/repo", async () => ({
    ok: true,
    output: JSON.stringify([issue(1), { number: "2" }, { title: "no number" }, null, issue(3)]),
  }));

  assert.deepEqual(mixed?.map((entry) => entry.number), [1, 3]);
});

test("the first poll seeds the baseline instead of firing", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const gh = fakeGh([[issue(1), issue(2)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  const fired = await scheduler.runIssueWorkflows();

  // Otherwise every issue already open would run the workflow on app launch.
  assert.deepEqual(fired, []);
  assert.deepEqual(runs, []);
});

test("a new issue fires the workflow once", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const gh = fakeGh([[issue(1)], [issue(1), issue(2)], [issue(1), issue(2)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));
  const fired = await scheduler.runIssueWorkflows(new Date(200_000));

  assert.deepEqual(fired, ["wf-issue"]);
  assert.equal(runs[0].triggeredBy, "issue-created");

  // The same issue is not new twice.
  const again = await scheduler.runIssueWorkflows(new Date(400_000));
  assert.deepEqual(again, []);
  assert.equal(runs.length, 1);
});

test("a burst of issues starts the workflow once, not once per issue", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const gh = fakeGh([[issue(1)], [issue(1), issue(2), issue(3), issue(4)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));
  const fired = await scheduler.runIssueWorkflows(new Date(200_000));

  assert.deepEqual(fired, ["wf-issue"], "a triage session should not start four runs");
  assert.equal(runs.length, 1);
});

test("a label filter only fires for matching issues", async () => {
  const { service, runs } = fakeWorkflows([workflow({ trigger: { type: "issue-created", detail: "bug" } })]);
  // Issue 2 is new but unlabelled; issue 3 is new and carries the label.
  const gh = fakeGh([[issue(1)], [issue(1), issue(2)], [issue(1), issue(2), issue(3)]], { labelled: [3] });
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));
  const unlabelled = await scheduler.runIssueWorkflows(new Date(200_000));
  assert.deepEqual(unlabelled, [], "a new issue without the label does not fire");

  const labelled = await scheduler.runIssueWorkflows(new Date(400_000));
  assert.deepEqual(labelled, ["wf-issue"]);
  assert.equal(runs.length, 1);
});

test("gh being unavailable is silent and does not poison the baseline", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  let available = false;
  const run = async (_cwd: string, _args: string[]) =>
    available ? { ok: true, output: JSON.stringify([issue(1), issue(2)]) } : { ok: false, output: "gh: not found" };
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, run);

  await scheduler.runIssueWorkflows(new Date(0));
  assert.deepEqual(runs, [], "no gh means no runs and no noise");

  // Once gh works, the first successful poll is a baseline — not a burst of runs
  // for every issue that existed while it was unavailable.
  available = true;
  const fired = await scheduler.runIssueWorkflows(new Date(200_000));
  assert.deepEqual(fired, [], "the first readable poll seeds instead of firing");
  assert.deepEqual(runs, []);
});

test("inactive, stepless and pathless workflows never spawn gh", async () => {
  const { service, runs } = fakeWorkflows([
    workflow({ id: "paused", status: "paused" }),
    workflow({ id: "no-path", projectPath: null }),
    workflow({ id: "no-steps", steps: [] }),
    workflow({ id: "other", trigger: { type: "schedule", schedule: "Daily, 9:00 AM" } }),
  ]);
  const gh = fakeGh([[issue(1)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));
  await scheduler.runIssueWorkflows(new Date(200_000));

  assert.deepEqual(gh.calls, [], "no network call for a workflow that cannot run");
  assert.deepEqual(runs, []);
});

test("workflows sharing a repo cost one gh call, not one each", async () => {
  const { service } = fakeWorkflows([
    workflow({ id: "a" }),
    workflow({ id: "b" }),
    workflow({ id: "c" }),
  ]);
  const gh = fakeGh([[issue(1)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));

  // Each poll is a network round-trip; three workflows on one repo must not mean
  // three calls per tick.
  assert.equal(gh.calls.length, 1);
});

test("a failed run does not re-fire the same issue", async () => {
  const definitions = [workflow()];
  const runs: string[] = [];
  const service = {
    list: () => definitions,
    run: async (input: { workflowId: string }) => {
      runs.push(input.workflowId);
      throw new Error("step exploded");
    },
  } as unknown as WorkflowService;
  const gh = fakeGh([[issue(1)], [issue(1), issue(2)], [issue(1), issue(2)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.runIssueWorkflows(new Date(0));
  const fired = await scheduler.runIssueWorkflows(new Date(200_000));

  assert.deepEqual(fired, [], "a throwing run is not reported as fired");
  assert.equal(runs.length, 1);

  await scheduler.runIssueWorkflows(new Date(400_000));
  assert.equal(runs.length, 1, "the failed issue is not retried on every tick");
});

test("seedIssueBaselines records without firing", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const gh = fakeGh([[issue(1)], [issue(1), issue(2)]]);
  const scheduler = new WorkflowSchedulerService(service, () => null, undefined, gh.run);

  await scheduler.seedIssueBaselines();
  assert.deepEqual(runs, []);

  const fired = await scheduler.runIssueWorkflows(new Date(200_000));
  assert.deepEqual(fired, ["wf-issue"], "only issues after the seed count as new");
});
