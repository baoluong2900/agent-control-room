import assert from "node:assert/strict";
import test from "node:test";
import {
  cliLabels,
  cliOptions,
  formatDate,
  formatDuration,
  formatRelative,
  runStatusMeta,
  statusMeta,
  stepKindMeta,
  stepKinds,
  triggerMeta,
} from "../apps/desktop/src/renderer/workflows/workflow-ui.ts";

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

  assert.equal(triggerMeta["git-push"].label, "On Push");
  assert.equal(statusMeta.active.accent, "green");
  assert.equal(statusMeta.paused.accent, "amber");

  assert.equal(runStatusMeta.success.label, "Success");
  assert.equal(runStatusMeta.failed.accent, "red");
});
