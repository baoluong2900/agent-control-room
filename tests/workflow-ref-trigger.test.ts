import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { WorkflowSchedulerService, parseRefTrigger } from "../src/main/workflows/workflow-scheduler.ts";
import type { WorkflowService } from "../src/main/workflows/workflow-service.ts";

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wf-1",
    name: "Ref watcher",
    description: "",
    status: "active",
    favorite: false,
    owner: "You",
    projectPath: "/tmp/repo",
    trigger: { type: "git-push" },
    integrations: [],
    steps: [
      {
        id: "s1",
        name: "Run",
        kind: "execute",
        summary: "",
        cliId: "shell",
        model: "",
        shellCommand: "echo hi",
        timeoutSeconds: 60,
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

/** A WorkflowService stand-in that records the runs it was asked for. */
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

/** A scripted git: each ref returns the next SHA in its queue, repeating the last. */
function fakeGit(shas: Record<string, string[]>, branch = "main") {
  const calls: string[][] = [];
  const cursors = new Map<string, number>();

  const run = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "branch") return { ok: true, output: `${branch}\n` };
    if (args[0] === "rev-parse") {
      const ref = args[1] ?? "HEAD";
      const queue = shas[ref];
      if (!queue || queue.length === 0) return { ok: false, output: `fatal: ambiguous argument '${ref}'` };
      const index = cursors.get(ref) ?? 0;
      cursors.set(ref, Math.min(index + 1, queue.length - 1));
      return { ok: true, output: `${queue[index]}\n` };
    }
    return { ok: false, output: "unsupported" };
  };

  return { run, calls };
}

test("parseRefTrigger reads the shapes users actually type", () => {
  assert.deepEqual(parseRefTrigger(undefined), {}, "unconfigured watches HEAD");
  assert.deepEqual(parseRefTrigger("   "), {});
  assert.deepEqual(parseRefTrigger("main"), { branch: "main" });
  // `origin/main` is how people write "the pushed branch", so it must not be read
  // as a branch literally named that.
  assert.deepEqual(parseRefTrigger("origin/main"), { remote: "origin", branch: "main" });
  assert.deepEqual(parseRefTrigger("branch=develop, remote=upstream"), { branch: "develop", remote: "upstream" });
  assert.deepEqual(parseRefTrigger("ref=release"), { branch: "release" });
  // Garbage degrades to a branch name rather than throwing; the runner then simply
  // never resolves it and stays quiet.
  assert.deepEqual(parseRefTrigger("GitHub • main"), { branch: "GitHub • main" });
});

test("the first poll seeds the baseline instead of firing", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const git = fakeGit({ HEAD: ["aaaaaaa1"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  const fired = await scheduler.runRefChangeWorkflows();

  // Firing here would run every ref workflow once on every app launch.
  assert.deepEqual(fired, []);
  assert.deepEqual(runs, []);
});

test("a moved ref fires the workflow exactly once", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const git = fakeGit({ HEAD: ["aaaaaaa1", "bbbbbbb2", "bbbbbbb2"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, ["wf-1"]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggeredBy, "git-push");

  // Same SHA on the next poll: nothing more to do.
  const again = await scheduler.runRefChangeWorkflows(new Date(400_000));
  assert.deepEqual(again, []);
  assert.equal(runs.length, 1);
});

test("a workflow that commits does not retrigger itself", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  // Every poll sees a brand new SHA, which is what a self-committing workflow does.
  const git = fakeGit({ HEAD: ["1111111a", "2222222b", "3333333c", "4444444d"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  await scheduler.runRefChangeWorkflows(new Date(1_000));
  await scheduler.runRefChangeWorkflows(new Date(2_000));
  await scheduler.runRefChangeWorkflows(new Date(3_000));

  // The cooldown is what stops an infinite loop; without it this would be 3 runs.
  assert.equal(runs.length, 1, "the cooldown swallowed the self-caused commits");
});

test("a branch filter ignores movement while another branch is checked out", async () => {
  const { service, runs } = fakeWorkflows([workflow({ trigger: { type: "git-push", detail: "main" } })]);
  const git = fakeGit({ main: ["1111111a", "2222222b", "2222222b"] }, "feature/x");
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, [], "HEAD moved, but not the watched branch on this checkout");
  assert.deepEqual(runs, []);
});

test("a remote-qualified trigger watches the remote-tracking ref", async () => {
  const { service, runs } = fakeWorkflows([workflow({ trigger: { type: "git-push", detail: "origin/main" } })]);
  const git = fakeGit({ "refs/remotes/origin/main": ["1111111a", "2222222b", "2222222b"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, ["wf-1"]);
  assert.equal(runs.length, 1);
  assert.ok(
    git.calls.some((args) => args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main"),
    "the remote-tracking ref is the one polled",
  );
  assert.equal(
    git.calls.some((args) => args[0] === "branch"),
    false,
    "a remote ref needs no local checkout check",
  );
});

test("an unresolvable ref or non-repo folder stays silent", async () => {
  const { service, runs } = fakeWorkflows([workflow({ trigger: { type: "git-push", detail: "nope" } })]);
  const git = fakeGit({ HEAD: ["1111111a"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, [], "a missing ref is not an error the user needs shouting about");
  assert.deepEqual(runs, []);
});

test("rev-parse echoing its input back is not treated as a SHA", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  // `git rev-parse` prints the argument verbatim when it cannot resolve it.
  const echoing = async (_cwd: string, args: string[]) =>
    args[0] === "rev-parse" ? { ok: true, output: "HEAD\n" } : { ok: true, output: "main\n" };
  const scheduler = new WorkflowSchedulerService(service, () => null, echoing);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, []);
  assert.deepEqual(runs, []);
});

test("inactive, stepless, and pathless workflows are skipped", async () => {
  const { service, runs } = fakeWorkflows([
    workflow({ id: "paused", status: "paused" }),
    workflow({ id: "no-path", projectPath: null }),
    workflow({ id: "no-steps", steps: [] }),
  ]);
  const git = fakeGit({ HEAD: ["1111111a", "2222222b"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, []);
  assert.deepEqual(runs, []);
  assert.deepEqual(git.calls, [], "no git process is spawned for a workflow that cannot run");
});

test("seedRefBaselines records SHAs without running anything", async () => {
  const { service, runs } = fakeWorkflows([workflow()]);
  const git = fakeGit({ HEAD: ["1111111a", "2222222b", "2222222b"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.seedRefBaselines();
  assert.deepEqual(runs, [], "seeding never fires");

  // The next poll sees the second SHA, which is a genuine change from the seed.
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));
  assert.deepEqual(fired, ["wf-1"]);
});

test("a failed run does not re-fire the same commit", async () => {
  const definitions = [workflow()];
  const runs: string[] = [];
  const service = {
    list: () => definitions,
    run: async (input: { workflowId: string }) => {
      runs.push(input.workflowId);
      throw new Error("step exploded");
    },
  } as unknown as WorkflowService;
  const git = fakeGit({ HEAD: ["1111111a", "2222222b", "2222222b", "2222222b"] });
  const scheduler = new WorkflowSchedulerService(service, () => null, git.run);

  await scheduler.runRefChangeWorkflows(new Date(0));
  const fired = await scheduler.runRefChangeWorkflows(new Date(200_000));

  assert.deepEqual(fired, [], "a throwing run is not reported as fired");
  assert.equal(runs.length, 1);

  // The SHA was recorded before the run was attempted, so the failure is not retried
  // forever against the same commit.
  await scheduler.runRefChangeWorkflows(new Date(400_000));
  assert.equal(runs.length, 1, "the failed commit is not retried on every tick");
});
