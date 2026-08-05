import assert from "node:assert/strict";
import test from "node:test";
import type { SidecarHealth, SidecarStatus } from "../src/main/gateway/sidecar-manager.ts";
import { collectSidecarChecks } from "../src/main/ipc/diagnostics.ts";

function status(overrides: Partial<SidecarStatus> = {}): SidecarStatus {
  return {
    state: "running",
    pid: 4242,
    port: 20128,
    baseUrl: "http://127.0.0.1:20128",
    error: null,
    configured: true,
    startedAt: "2026-08-06T00:00:00.000Z",
    restarts: 1,
    ...overrides,
  };
}

const healthReturning = (result: SidecarHealth) => async () => result;

function detailOf(check: { detail?: string }): string {
  assert.ok(check.detail, "sidecar checks always carry a detail line");
  return check.detail;
}

test("an unconfigured sidecar produces no checks at all", async () => {
  let probed = false;
  const checks = await collectSidecarChecks(status({ configured: false, state: "stopped" }), async () => {
    probed = true;
    return { reachable: true, statusCode: 200 };
  });

  // The app ships without a bundled router by design, so this is the normal state.
  // A warning here would train users to ignore Diagnostics.
  assert.deepEqual(checks, []);
  assert.equal(probed, false, "and nothing is probed");
});

test("a healthy sidecar reports ok with no call to action", async () => {
  const checks = await collectSidecarChecks(status(), healthReturning({ reachable: true, statusCode: 200 }));

  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "ok");
  assert.match(detailOf(checks[0]), /Healthy on http:\/\/127\.0\.0\.1:20128/);
  assert.match(detailOf(checks[0]), /pid 4242/);
  assert.equal(checks[0].action, undefined);
});

test("a crashed sidecar fails with the recorded reason", async () => {
  let probed = false;
  const checks = await collectSidecarChecks(
    status({ state: "failed", error: "exited immediately (exit code 3) — check the command and arguments" }),
    async () => {
      probed = true;
      return { reachable: false };
    },
  );

  assert.equal(checks[0].status, "fail");
  assert.match(detailOf(checks[0]), /exit code 3/);
  assert.equal(probed, false, "a dead process is not probed over HTTP");
});

test("configured but stopped is a warning, not a failure", async () => {
  const checks = await collectSidecarChecks(
    status({ state: "stopped", pid: null, port: null, baseUrl: null }),
    healthReturning({ reachable: true, statusCode: 200 }),
  );

  assert.equal(checks[0].status, "warn");
  assert.match(detailOf(checks[0]), /Configured but not running/);
});

test("running but not answering is distinguished from not running", async () => {
  const checks = await collectSidecarChecks(
    status(),
    healthReturning({ reachable: false, detail: "ECONNREFUSED" }),
  );

  // The important distinction: the process is alive, so "start it" is the wrong
  // advice — the fix is its flags or its own config.
  assert.equal(checks[0].status, "warn");
  assert.match(detailOf(checks[0]), /Process is running \(pid 4242\)/);
  assert.match(detailOf(checks[0]), /did not answer/);
  assert.match(detailOf(checks[0]), /ECONNREFUSED/);
});

test("a 4xx from /health warns about the sidecar's own configuration", async () => {
  const checks = await collectSidecarChecks(status(), healthReturning({ reachable: true, statusCode: 401 }));

  // It is serving, and it rejected us — a different problem from a dead process.
  assert.equal(checks[0].status, "warn");
  assert.match(detailOf(checks[0]), /answered 401/);
});

test("the check never claims health from lifecycle state alone", async () => {
  // `running` only means the process survived startup; phase 1 has no readiness
  // handshake, so a green check must come from /health answering.
  const checks = await collectSidecarChecks(status(), healthReturning({ reachable: false }));

  assert.notEqual(checks[0].status, "ok", "a live process is not evidence it is serving");
});
