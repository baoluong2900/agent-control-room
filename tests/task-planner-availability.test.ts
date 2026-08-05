import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCliId } from "../src/contracts/agent.ts";
import { buildTaskPlan } from "../src/main/tasks/task-planner.ts";

const REQUEST =
  "Refactor the workflow scheduler so retries use exponential backoff, add database migrations for the new columns, " +
  "and wire the electron IPC surface to the renderer. Cover it with tests.";

/** Every CLI a plan's steps were assigned to. */
function assignedClis(plan: ReturnType<typeof buildTaskPlan>): AgentCliId[] {
  return [...new Set(plan.subtasks.map((subtask) => subtask.assignedCliId as AgentCliId))];
}

test("a plan never assigns a CLI that is not installed", () => {
  // The bug this phase fixes: the planner hardcoded kiro/claude/gemini/shell per
  // step regardless of the machine, so a plan could contain steps that simply
  // could not run and the user only learned that when they failed.
  const available: AgentCliId[] = ["codex", "shell"];
  const plan = buildTaskPlan({ request: REQUEST, availableCliIds: available });

  for (const cliId of assignedClis(plan)) {
    assert.ok(available.includes(cliId), `${cliId} is not installed but was assigned`);
  }
  assert.ok(plan.subtasks.length > 0, "the plan still has steps");
});

test("a single installed CLI takes every non-shell role", () => {
  const plan = buildTaskPlan({ request: REQUEST, availableCliIds: ["claude", "shell"] });

  const clis = assignedClis(plan);
  assert.deepEqual(
    [...clis].sort(),
    ["claude", "shell"],
    `expected only claude and shell, got ${JSON.stringify(clis)}`,
  );
  assert.ok(plan.summary.reassignedSteps?.length, "the reassignment is reported, not silent");
});

test("a missing intended CLI falls back rather than leaving the step empty", () => {
  // kiro is the intended Investigate agent; without it the step must still get a
  // real CLI, not an empty assignment or a dead one.
  const plan = buildTaskPlan({ request: REQUEST, availableCliIds: ["gemini", "shell"] });

  for (const subtask of plan.subtasks) {
    assert.ok(subtask.assignedCliId, `${subtask.title} has no CLI assigned`);
    assert.ok(["gemini", "shell"].includes(subtask.assignedCliId as string));
  }
});

test("with no agent CLI installed the plan says so instead of pretending", () => {
  const plan = buildTaskPlan({ request: REQUEST, availableCliIds: ["shell"] });

  assert.equal(plan.summary.noAgentsAvailable, true, "the UI needs to be able to warn about this");
  assert.deepEqual(assignedClis(plan), ["shell"], "and every step falls back to the shell");
});

test("a preferred CLI that is not installed is ignored", () => {
  const plan = buildTaskPlan({
    request: REQUEST,
    preferredCliId: "aider",
    availableCliIds: ["codex", "shell"],
  });

  assert.equal(
    plan.subtasks.some((subtask) => subtask.assignedCliId === "aider"),
    false,
    "an uninstalled preference is a broken step, not a preference",
  );
  assert.equal(plan.parent.assignedCliId, "codex", "the parent takes a CLI that actually exists");
});

test("a preferred CLI that is installed is honoured", () => {
  const plan = buildTaskPlan({
    request: REQUEST,
    preferredCliId: "cursor",
    availableCliIds: ["cursor", "claude", "shell"],
  });

  assert.equal(plan.parent.assignedCliId, "cursor");
  assert.ok(
    plan.subtasks.some((subtask) => subtask.assignedCliId === "cursor"),
    "the preference drives the Execute step",
  );
});

test("omitting availableCliIds preserves the historical assignments", () => {
  // Callers that never opted in — existing tests, harnesses — must be unaffected,
  // since "not told" is different from "nothing installed".
  const plan = buildTaskPlan({ request: REQUEST });

  const clis = assignedClis(plan);
  assert.ok(clis.includes("kiro"), "kiro is still the intended Investigate agent");
  assert.ok(clis.includes("claude"), "claude is still the intended Plan agent");
  assert.equal(plan.summary.noAgentsAvailable, undefined, "no claim is made either way");
  assert.equal(plan.summary.reassignedSteps, undefined);
});

test("the plan reports itself as a template", () => {
  // Phase 2: the UI has to be able to say what this is rather than implying the
  // plan analysed the codebase.
  const plan = buildTaskPlan({ request: REQUEST });
  assert.equal(plan.summary.source, "template");
});

test("planning stays deterministic for the same input", () => {
  const first = buildTaskPlan({ request: REQUEST, availableCliIds: ["codex", "claude", "shell"] });
  const second = buildTaskPlan({ request: REQUEST, availableCliIds: ["codex", "claude", "shell"] });

  assert.deepEqual(
    first.subtasks.map((subtask) => [subtask.title, subtask.assignedCliId]),
    second.subtasks.map((subtask) => [subtask.title, subtask.assignedCliId]),
  );
  assert.equal(first.summary.difficulty, second.summary.difficulty);
});

test("reassignment notes name the step and both CLIs", () => {
  const plan = buildTaskPlan({ request: REQUEST, availableCliIds: ["codex", "shell"] });

  const notes = plan.summary.reassignedSteps ?? [];
  assert.ok(notes.length > 0);
  for (const note of notes) {
    // Format is "Role: intended -> chosen"; the UI prints these verbatim, so a
    // change here is a change to what the user reads.
    assert.match(note, /^[A-Z][a-z]+: [a-z-]+ -> [a-z-]+$/, `unexpected note format: ${note}`);
  }
});
