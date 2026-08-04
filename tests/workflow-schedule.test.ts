import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowSaveInput } from "@contracts";
import { WorkflowRepository } from "../src/main/database/workflow-repository.ts";
import { WorkflowService } from "../src/main/workflows/workflow-service.ts";
import { parseSchedule, previousOccurrence } from "../src/main/workflows/workflow-schedule.ts";
import { WorkflowSchedulerService } from "../src/main/workflows/workflow-scheduler.ts";

/** Same in-memory harness the approval tests use: no Electron, no real database file. */
function freshScheduler(): {
  scheduler: WorkflowSchedulerService;
  service: WorkflowService;
  repo: WorkflowRepository;
} {
  const db = new DatabaseSync(":memory:");
  const repo = new WorkflowRepository(db as never);
  repo.migrate();
  // migrate() seeds reference workflows, two of which are schedule-triggered — and
  // one is active. Leaving them in place would make every tick below spawn their
  // real agent CLIs, so start the scheduler against an empty catalogue.
  for (const seeded of repo.list()) repo.remove(seeded.id);
  const service = new WorkflowService(
    { workflows: repo, listAgentProfiles: () => [], listProviderConnections: () => [] } as never,
    () => null,
  );
  const scheduler = new WorkflowSchedulerService(service, () => null);
  return { scheduler, service, repo };
}

function scheduledWorkflow(overrides: Partial<WorkflowSaveInput> = {}): WorkflowSaveInput {
  return {
    name: "Nightly Report",
    description: "Runs on a schedule",
    status: "active",
    favorite: false,
    owner: "Tester",
    projectPath: process.cwd(),
    trigger: { type: "schedule", schedule: "Daily, 9:00 AM" },
    integrations: [],
    steps: [
      {
        name: "Report",
        kind: "execute",
        summary: "Report",
        cliId: "shell",
        model: "none",
        instruction: "echo report",
        shellCommand: "echo report",
        timeoutSeconds: 30,
        requiresApproval: false,
        continueOnError: false,
        enabled: true,
      },
    ],
    ...overrides,
  };
}

test("parseSchedule reads the friendly strings the editor produces", () => {
  assert.deepEqual(parseSchedule("Daily, 9:00 AM"), { kind: "daily", hour: 9, minute: 0 });
  assert.deepEqual(parseSchedule("Daily, 11:30 PM"), { kind: "daily", hour: 23, minute: 30 });
  assert.deepEqual(parseSchedule("Weekly, Mon 10:00 AM"), {
    kind: "weekly",
    weekday: 1,
    hour: 10,
    minute: 0,
  });
  assert.deepEqual(parseSchedule("Weekly, Friday 6:15 PM"), {
    kind: "weekly",
    weekday: 5,
    hour: 18,
    minute: 15,
  });
  assert.deepEqual(parseSchedule("Monthly, 15th 9:00 AM"), {
    kind: "monthly",
    day: 15,
    hour: 9,
    minute: 0,
  });
  assert.deepEqual(parseSchedule("Hourly"), { kind: "interval", minutes: 60 });
  assert.deepEqual(parseSchedule("Every 30 minutes"), { kind: "interval", minutes: 30 });
  assert.deepEqual(parseSchedule("every 2 hours"), { kind: "interval", minutes: 120 });
});

test("parseSchedule treats midnight and noon meridiems correctly", () => {
  assert.deepEqual(parseSchedule("Daily, 12:00 AM"), { kind: "daily", hour: 0, minute: 0 });
  assert.deepEqual(parseSchedule("Daily, 12:00 PM"), { kind: "daily", hour: 12, minute: 0 });
});

test("parseSchedule refuses anything it cannot fire safely", () => {
  // The field is free text, so an unrecognised value must never guess a time.
  for (const raw of [null, undefined, "", "   ", "when the build is green", "on push", "asap"]) {
    assert.equal(parseSchedule(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
  assert.equal(parseSchedule("Daily, 99:99"), null);
  assert.equal(parseSchedule("Weekly"), null, "a weekly schedule with no weekday is ambiguous");
});

test("previousOccurrence finds the most recent slot for a daily schedule", () => {
  const schedule = { kind: "daily" as const, hour: 9, minute: 0 };

  const afternoon = previousOccurrence(schedule, new Date(2026, 6, 30, 14, 0));
  assert.equal(afternoon?.getTime(), new Date(2026, 6, 30, 9, 0).getTime());

  // Before today's slot, the last one owed is yesterday's.
  const earlyMorning = previousOccurrence(schedule, new Date(2026, 6, 30, 7, 30));
  assert.equal(earlyMorning?.getTime(), new Date(2026, 6, 29, 9, 0).getTime());
});

test("previousOccurrence walks back to the right weekday", () => {
  const schedule = { kind: "weekly" as const, weekday: 1, hour: 10, minute: 0 };

  // 2026-07-30 is a Thursday, so the owed slot is Monday the 27th.
  const thursday = previousOccurrence(schedule, new Date(2026, 6, 30, 12, 0));
  assert.equal(thursday?.getTime(), new Date(2026, 6, 27, 10, 0).getTime());

  // On the weekday itself but before the time, it belongs to the previous week.
  const mondayEarly = previousOccurrence(schedule, new Date(2026, 6, 27, 9, 0));
  assert.equal(mondayEarly?.getTime(), new Date(2026, 6, 20, 10, 0).getTime());
});

test("previousOccurrence skips months that are too short for the day", () => {
  const schedule = { kind: "monthly" as const, day: 31, hour: 9, minute: 0 };

  // February has no 31st, so the owed slot is January's.
  const february = previousOccurrence(schedule, new Date(2026, 1, 15, 12, 0));
  assert.equal(february?.getTime(), new Date(2026, 0, 31, 9, 0).getTime());

  const sameDay = previousOccurrence({ kind: "monthly", day: 15, hour: 9, minute: 0 }, new Date(2026, 6, 15, 10, 0));
  assert.equal(sameDay?.getTime(), new Date(2026, 6, 15, 9, 0).getTime());
});

test("previousOccurrence floors interval schedules onto the period grid", () => {
  const slot = previousOccurrence({ kind: "interval", minutes: 30 }, new Date(2026, 6, 30, 14, 47));
  assert.equal(slot?.getTime() ?? 0, Math.floor(new Date(2026, 6, 30, 14, 47).getTime() / 1_800_000) * 1_800_000);
});

test("runDueWorkflows fires a schedule that came due after the scheduler booted", async () => {
  const { scheduler, service, repo } = freshScheduler();
  const workflow = repo.save(scheduledWorkflow());

  // The scheduler baselines unrun workflows against its own boot time, so look a
  // day ahead to place today's 9:00 AM slot firmly after that baseline.
  const tomorrowAfternoon = new Date();
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(14, 0, 0, 0);

  const fired = await scheduler.runDueWorkflows(tomorrowAfternoon);
  assert.deepEqual(fired, [workflow.id]);

  const runs = service.runs(workflow.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggeredBy, "schedule");
});

test("runDueWorkflows does not fire the same slot twice", async () => {
  const { scheduler, repo, service } = freshScheduler();
  const workflow = repo.save(scheduledWorkflow());

  const tomorrowAfternoon = new Date();
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(14, 0, 0, 0);

  assert.deepEqual(await scheduler.runDueWorkflows(tomorrowAfternoon), [workflow.id]);
  // A later tick inside the same slot owes nothing.
  const secondTick = new Date(tomorrowAfternoon.getTime() + 60_000);
  assert.deepEqual(await scheduler.runDueWorkflows(secondTick), []);
  assert.equal(service.runs(workflow.id).length, 1);
});

test("runDueWorkflows skips workflows that are not eligible", async () => {
  const { scheduler, repo } = freshScheduler();

  repo.save(scheduledWorkflow({ name: "Paused", status: "paused" }));
  repo.save(scheduledWorkflow({ name: "Manual", trigger: { type: "manual" } }));
  repo.save(scheduledWorkflow({ name: "Unparseable", trigger: { type: "schedule", schedule: "when ready" } }));
  repo.save(scheduledWorkflow({ name: "No schedule text", trigger: { type: "schedule" } }));
  const noSteps = scheduledWorkflow({ name: "All steps off" });
  repo.save({ ...noSteps, steps: noSteps.steps.map((step) => ({ ...step, enabled: false })) });

  const tomorrowAfternoon = new Date();
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(14, 0, 0, 0);

  assert.deepEqual(await scheduler.runDueWorkflows(tomorrowAfternoon), []);
});

test("runDueWorkflows leaves a schedule alone until its next slot after the last run", async () => {
  const { scheduler, repo } = freshScheduler();
  repo.save(scheduledWorkflow());

  // Boot time is "now", and today's 9:00 AM slot is at or before it, so nothing is owed yet.
  assert.deepEqual(await scheduler.runDueWorkflows(new Date()), []);
});

test("stop is safe to call without start and start only arms one timer", () => {
  const { scheduler } = freshScheduler();
  scheduler.stop();
  scheduler.start({ intervalMs: 15_000 });
  scheduler.start({ intervalMs: 15_000 });
  scheduler.stop();
  scheduler.stop();
});
