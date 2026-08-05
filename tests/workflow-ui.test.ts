import assert from "node:assert/strict";
import test from "node:test";
import {
  cliLabels,
  cliOptions,
  formatDate,
  formatDuration,
  formatRelative,
  isLocallyRunnableTrigger,
  locallyRunnableTriggerTypes,
  runStatusMeta,
  statusMeta,
  stepKindMeta,
  stepKinds,
  triggerMeta,
  triggerTypes,
  unsupportedTriggerCopy,
} from "../src/renderer/workflows/workflow-ui.ts";
import { workflowSeeds } from "../src/main/workflows/workflow-seeds.ts";

test("formatDuration renders human-friendly durations", () => {
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(45000), "45s");
  assert.equal(formatDuration(60000), "1m 00s");
  assert.equal(formatDuration(272000), "4m 32s"); // matches workflow.png "4m 32s"
});

test("formatRelative passes through friendly strings and computes deltas", () => {
  assert.equal(formatRelative(undefined), "—");
  assert.equal(formatRelative("2 min ago"), "2 min ago"); // unparseable -> passthrough
  assert.equal(formatRelative(new Date().toISOString()), "just now");
  assert.equal(formatRelative(new Date(Date.now() - 3 * 60_000).toISOString()), "3 min ago");
  assert.equal(formatRelative(new Date(Date.now() - 2 * 3_600_000).toISOString()), "2 hr ago");
});

test("formatDate formats ISO dates and passes through non-dates", () => {
  assert.equal(formatDate(undefined), "—");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.match(formatDate("2025-04-12T09:00:00.000Z"), /2025/);
});

test("stepKindMeta exposes the investigate (dieu tra) kind", () => {
  assert.ok(stepKinds.includes("investigate"));
  assert.equal(stepKindMeta.investigate.label, "Investigate");
  // Every declared step kind has label/icon/accent metadata.
  for (const kind of stepKinds) {
    assert.ok(stepKindMeta[kind].label.length > 0, `missing label for ${kind}`);
    assert.ok(stepKindMeta[kind].icon, `missing icon for ${kind}`);
    assert.ok(stepKindMeta[kind].accent, `missing accent for ${kind}`);
  }
});

test("cli, trigger, status and run-status metadata are complete", () => {
  assert.ok(cliOptions.includes("kiro"));
  assert.equal(cliLabels.kiro, "Kiro");
  assert.equal(cliLabels.claude, "Claude");
  assert.equal(cliLabels.shell, "Shell");

  // Deliberately not "On Push": the runner polls local refs, so it fires on any ref
  // change (commit/merge/rebase/pull). Calling it "On Push" would promise remote
  // push detection the app cannot do without a webhook.
  assert.equal(triggerMeta["git-push"].label, "On Ref Change");
  assert.equal(statusMeta.active.accent, "green");
  assert.equal(statusMeta.paused.accent, "amber");

  assert.equal(runStatusMeta.success.label, "Success");
  assert.equal(runStatusMeta.failed.accent, "red");
});

test("every unsupported trigger has copy explaining why it cannot run", () => {
  for (const type of Object.keys(triggerMeta) as Array<keyof typeof triggerMeta>) {
    if (isLocallyRunnableTrigger(type)) {
      assert.equal(unsupportedTriggerCopy[type], undefined, `${type} runs locally but carries unsupported copy`);
      continue;
    }
    assert.ok(unsupportedTriggerCopy[type], `${type} has no runner and no explanation copy`);
  }
});

test("seeded workflows only advertise triggers that actually run", () => {
  // A freshly installed workspace must not look like it has automation it does
  // not have. Two seeds used to ship `git-push` / `issue-created`, which the
  // editor gates but the seeder did not, so the starter workflows read as live
  // automation while nothing was ever going to fire them.
  for (const seed of workflowSeeds) {
    assert.ok(
      isLocallyRunnableTrigger(seed.trigger.type),
      `seed ${seed.id} uses trigger "${seed.trigger.type}", which has no local runner`,
    );
  }
});

test("scheduled seeds carry a schedule the parser can use", () => {
  for (const seed of workflowSeeds) {
    if (seed.trigger.type !== "schedule") continue;
    assert.ok(seed.trigger.schedule?.trim(), `seed ${seed.id} is scheduled but has no schedule string`);
  }
  // Every declared trigger now has a local runner: schedules and file watching,
  // ref polling, a loopback webhook listener, and issue polling through the user's
  // own `gh`. Nothing in the editor is gated any more.
  assert.deepEqual(locallyRunnableTriggerTypes, [
    "manual",
    "schedule",
    "file-change",
    "git-push",
    "webhook",
    "issue-created",
  ]);
  assert.deepEqual(triggerTypes.filter((type) => !isLocallyRunnableTrigger(type)), [], "no trigger is gated");
});
