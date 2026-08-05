import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentCliId } from "../src/contracts/agent.ts";
import { buildPlannerPrompt, extractJsonObject, parseAiPlan } from "../src/main/tasks/ai-planner.ts";
import { buildTaskPlan } from "../src/main/tasks/task-planner.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service.ts";

const INSTALLED: AgentCliId[] = ["codex", "claude", "shell"];

const VALID_PLAN = JSON.stringify({
  difficulty: "large",
  steps: [
    { title: "Read", directive: "Read the scheduler and note the retry path.", cliId: "claude" },
    { title: "Change", directive: "Add exponential backoff to the retry policy.", cliId: "codex" },
    { title: "Test", directive: "Run the workflow test suite.", cliId: "shell" },
  ],
});

test("a clean JSON plan parses into steps", () => {
  const outcome = parseAiPlan(VALID_PLAN, INSTALLED);

  assert.equal(outcome.steps.length, 3);
  assert.equal(outcome.difficulty, "large");
  assert.deepEqual(
    outcome.steps.map((step) => step.cliId),
    ["claude", "codex", "shell"],
  );
});

test("JSON wrapped in prose or a fence is still found", () => {
  // Models do all three of these routinely, so none of them may be a hard failure.
  const fenced = "Here is the plan:\n```json\n" + VALID_PLAN + "\n```\nHope that helps!";
  assert.equal(parseAiPlan(fenced, INSTALLED).steps.length, 3);

  const prefixed = `Sure! ${VALID_PLAN}`;
  assert.equal(parseAiPlan(prefixed, INSTALLED).steps.length, 3);

  const trailing = `${VALID_PLAN}\n\nLet me know if you want changes.`;
  assert.equal(parseAiPlan(trailing, INSTALLED).steps.length, 3);
});

test("braces inside strings do not truncate the parse", () => {
  const tricky = JSON.stringify({
    steps: [{ title: "Fix", directive: 'Replace the `}` in the template literal ${x}.', cliId: "codex" }],
  });

  // A naive "find the last }" or regex approach cuts this short and loses the plan.
  const outcome = parseAiPlan(tricky, INSTALLED);
  assert.equal(outcome.steps.length, 1);
  assert.match(outcome.steps[0].directive, /template literal/);
});

test("a step naming an uninstalled CLI keeps the step but drops the CLI", () => {
  const raw = JSON.stringify({
    steps: [{ title: "Investigate", directive: "Look at the code.", cliId: "gemini" }],
  });

  // Dropping the step would lose real planning; keeping the CLI would reintroduce
  // exactly the dead-step bug phase 1 fixed. Dropping only the suggestion lets the
  // role resolver assign something that exists.
  const outcome = parseAiPlan(raw, INSTALLED);
  assert.equal(outcome.steps.length, 1);
  assert.equal(outcome.steps[0].cliId, undefined);
});

test("unusable output is rejected rather than salvaged", () => {
  for (const raw of [
    "I cannot help with that.",
    "",
    "{}",
    JSON.stringify({ steps: [] }),
    JSON.stringify({ steps: "not an array" }),
    JSON.stringify({ steps: [{ title: "", directive: "" }] }),
    JSON.stringify({ steps: [{ title: "Only a title" }] }),
    "{ steps: [broken",
  ]) {
    assert.throws(() => parseAiPlan(raw, INSTALLED), /Planner output/, `should reject: ${raw.slice(0, 40)}`);
  }
});

test("an invalid difficulty is ignored instead of poisoning the plan", () => {
  const raw = JSON.stringify({
    difficulty: "gigantic",
    steps: [{ title: "Do", directive: "Something concrete.", cliId: "codex" }],
  });

  assert.equal(parseAiPlan(raw, INSTALLED).difficulty, undefined, "the heuristic estimate takes over");
});

test("plan size is capped so a rambling model cannot flood the board", () => {
  const raw = JSON.stringify({
    steps: Array.from({ length: 40 }, (_unused, index) => ({
      title: `Step ${index}`,
      directive: `Do thing ${index}.`,
      cliId: "codex",
    })),
  });

  assert.equal(parseAiPlan(raw, INSTALLED).steps.length, 8);
});

test("extractJsonObject prefers a fenced block but falls back to raw text", () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('noise {"a":2} noise'), { a: 2 });
  assert.equal(extractJsonObject("no json here"), null);
});

test("the prompt names only installed agents and says when context is missing", () => {
  const withoutContext = buildPlannerPrompt({ request: "Add retries", availableCliIds: INSTALLED });

  assert.match(withoutContext, /codex/);
  assert.match(withoutContext, /claude/);
  assert.equal(/gemini/.test(withoutContext), false, "an uninstalled agent must not be offered");
  // Said explicitly so the model does not invent file paths it was never shown.
  assert.match(withoutContext, /No project index is available/);
  assert.match(withoutContext, /ONLY a JSON object/);
});

test("AI steps go through the same availability resolution as template steps", () => {
  const plan = buildTaskPlan(
    { request: "Add retries to the scheduler", availableCliIds: ["codex", "shell"] },
    {
      steps: [
        { title: "Investigate", directive: "Read it.", cliId: undefined },
        { title: "Verify", directive: "Run tests.", cliId: "shell" },
      ],
      difficulty: "medium",
    },
  );

  assert.equal(plan.summary.source, "ai");
  assert.equal(plan.summary.difficulty, "medium", "the model's difficulty is honoured");
  for (const subtask of plan.subtasks) {
    assert.ok(["codex", "shell"].includes(subtask.assignedCliId as string), `${subtask.assignedCliId} is not installed`);
  }
});

test("planTask falls back to the template plan and states why", async (t) => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-aiplan-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);

  // No project path: AI planning cannot run, but the user must still get a plan.
  const result = await automation.planTask({
    request: "Refactor the scheduler and add migrations plus ipc wiring and tests.",
    mode: "ai",
    availableCliIds: ["codex", "shell"],
  });

  assert.equal(result.summary.source, "template", "the plan still exists");
  assert.ok(result.subtasks.length > 0);
  assert.match(result.summary.fallbackReason ?? "", /project folder/i, "and the reason is reported, not hidden");
});

test("planTask reports when no agent CLI can be asked", async (t) => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-aiplan2-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);

  const result = await automation.planTask({
    request: "Add retries",
    projectPath: process.cwd(),
    mode: "ai",
    // shell alone cannot answer a planning prompt.
    availableCliIds: ["shell"],
  });

  assert.equal(result.summary.source, "template");
  assert.match(result.summary.fallbackReason ?? "", /No agent CLI/i);
});

test("heuristic mode never attempts an agent call", async (t) => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-aiplan3-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());
  const manager = new AgentProcessManager(db, () => null);
  const automation = new TaskAutomationService(db, manager, () => null);

  const result = await automation.planTask({
    request: "Add retries",
    projectPath: process.cwd(),
    availableCliIds: ["codex", "shell"],
  });

  assert.equal(result.summary.source, "template");
  assert.equal(result.summary.fallbackReason, undefined, "nothing fell back because nothing was attempted");
});
