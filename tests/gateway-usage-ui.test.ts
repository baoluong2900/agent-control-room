import assert from "node:assert/strict";
import test from "node:test";
import {
  LOW_BALANCE_PERCENT,
  describeUsageError,
  formatCount,
  formatLatency,
  formatTokens,
  formatUsd,
  gradeBalance,
  isBrandNewAccount,
  statusTone,
} from "../src/renderer/gateway/gateway-usage-ui.ts";

/**
 * Presentation logic is tested here rather than through the component: these are
 * the parts with real branching, and pinning them keeps the panel free of the
 * "$0.00 for a working meter" and "raw error object on screen" failure modes.
 */

test("sub-cent spend keeps enough precision to look alive", () => {
  // Rounding per-request cost to $0.00 makes a working meter look broken.
  assert.equal(formatUsd(0.0004), "$0.0004");
  assert.equal(formatUsd(0.42), "$0.42");
});

test("usd formatting handles zero and non-finite input", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(Number.NaN), "$0.00");
});

test("token counts compact at thousand and million boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(940), "940");
  assert.equal(formatTokens(12_500), "12.5K");
  assert.equal(formatTokens(2_400_000), "2.40M");
});

test("counts and latency degrade gracefully on empty data", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatLatency(0), "—", "a latency of zero means 'not measured', not 'instant'");
  assert.equal(formatLatency(820), "820 ms");
  assert.equal(formatLatency(1_500), "1.50 s");
});

test("an exhausted balance is critical regardless of the percentage", () => {
  // The gateway starts refusing requests on its own flag; showing "healthy" while
  // calls 402 would be worse than showing nothing.
  assert.equal(gradeBalance({ exhausted: true, percentRemaining: 80 }), "critical");
});

test("balance grading uses the low-balance threshold", () => {
  assert.equal(gradeBalance({ exhausted: false, percentRemaining: LOW_BALANCE_PERCENT }), "low");
  assert.equal(gradeBalance({ exhausted: false, percentRemaining: LOW_BALANCE_PERCENT + 1 }), "healthy");
  assert.equal(gradeBalance({ exhausted: false, percentRemaining: 0 }), "critical");
});

test("request statuses map onto the three styled tones", () => {
  assert.equal(statusTone("success"), "ok");
  assert.equal(statusTone("SUCCEEDED"), "ok");
  assert.equal(statusTone("error"), "fail");
  assert.equal(statusTone("failed"), "fail");
  // Anything unrecognised is a warning rather than a crash or a blank pill.
  assert.equal(statusTone("throttled"), "warn");
  assert.equal(statusTone(""), "warn");
});

test("a missing key invites configuration rather than reporting a fault", () => {
  const copy = describeUsageError({ kind: "not-configured", message: "no key" });

  assert.equal(copy.action, "settings");
  assert.match(copy.title, /Not connected/);
});

test("a 401 points at settings and keeps the gateway's own wording", () => {
  const copy = describeUsageError({ kind: "unauthorized", message: "Invalid API key provided.", statusCode: 401 });

  assert.equal(copy.action, "settings");
  assert.match(copy.detail, /Invalid API key/);
});

test("an unreachable gateway offers retry and hides the transport noise", () => {
  const copy = describeUsageError({
    kind: "unreachable",
    message: "connect ECONNREFUSED 127.0.0.1:5100",
  });

  assert.equal(copy.action, "retry");
  // "fetch failed ECONNREFUSED" is noise to someone who just needs to start it.
  assert.ok(!copy.detail.includes("ECONNREFUSED"));
});

test("a server error surfaces the message and offers retry", () => {
  const copy = describeUsageError({ kind: "server-error", message: "The gateway answered 503.", statusCode: 503 });

  assert.equal(copy.action, "retry");
  assert.match(copy.detail, /503/);
});

test("every error kind produces copy with a title and detail", () => {
  // Guards the panel's promise that it never renders a raw error object.
  for (const kind of ["not-configured", "unauthorized", "unreachable", "server-error"] as const) {
    const copy = describeUsageError({ kind, message: "" });
    assert.ok(copy.title.length > 0, `${kind} has a title`);
    assert.ok(copy.detail.length > 0, `${kind} has a detail`);
  }
});

test("a fresh account is detected so the panel can say so", () => {
  assert.equal(isBrandNewAccount({ lifetimeRequests: 0, todayRequests: 0 }), true);
  assert.equal(isBrandNewAccount({ lifetimeRequests: 5, todayRequests: 0 }), false);
  assert.equal(isBrandNewAccount({ lifetimeRequests: 0, todayRequests: 2 }), false);
});
