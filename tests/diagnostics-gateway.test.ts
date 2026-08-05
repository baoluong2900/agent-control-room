import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConnection } from "../src/contracts/settings.ts";
import { collectGatewayChecks } from "../src/main/ipc/diagnostics.ts";
import type { EndpointProbeResult } from "../src/main/settings/provider-verification.ts";

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "hermes-agent",
    authMode: "oauth",
    storageMode: "local",
    accountLabel: "Hermes proxy",
    status: "connected",
    baseUrl: "http://127.0.0.1:8645/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ProviderConnection;
}

const probeReturning = (result: EndpointProbeResult) => async () => result;

/**
 * `DiagnosticCheck.detail` is optional on the type, but every gateway check sets it.
 * Asserting that here keeps the `assert.match` calls below honest instead of
 * silently passing `undefined` through a cast.
 */
function detailOf(check: { detail?: string }): string {
  assert.ok(check.detail, "gateway checks always carry a detail line");
  return check.detail;
}

test("a reachable gateway reports ok", async () => {
  const checks = await collectGatewayChecks([connection()], probeReturning({ reachable: true, statusCode: 200 }));

  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "ok");
  assert.match(detailOf(checks[0]), /is answering/);
  assert.equal(checks[0].action, undefined, "a healthy check needs no call to action");
});

test("an unreachable gateway fails and says how to start it", async () => {
  const checks = await collectGatewayChecks(
    [connection()],
    probeReturning({ reachable: false, detail: "fetch failed" }),
  );

  assert.equal(checks[0].status, "fail");
  // The actionable half: the user cannot fix this in Settings, they have to start
  // the process, so the detail names the command.
  assert.match(detailOf(checks[0]), /hermes proxy start/);
  assert.match(detailOf(checks[0]), /fetch failed/);
});

test("a gateway that answers but rejects the request warns rather than fails", async () => {
  const checks = await collectGatewayChecks([connection()], probeReturning({ reachable: true, statusCode: 401 }));

  // Distinct from unreachable on purpose: the process is up, so "start the proxy"
  // would be the wrong advice — the upstream credential is what needs attention.
  assert.equal(checks[0].status, "warn");
  assert.match(detailOf(checks[0]), /rejected the request \(401\)/);
  assert.match(detailOf(checks[0]), /log the upstream provider back in/i);
});

test("non-gateway providers and gateways without a baseUrl are skipped", async () => {
  let probed = 0;
  const probe = async () => {
    probed += 1;
    return { reachable: true, statusCode: 200 };
  };

  const checks = await collectGatewayChecks(
    [
      connection({ id: "cli", provider: "claude-code" }),
      connection({ id: "no-url", baseUrl: undefined }),
      connection({ id: "blank-url", baseUrl: "   " }),
    ],
    probe,
  );

  assert.deepEqual(checks, [], "nothing to probe means no checks");
  assert.equal(probed, 0, "and no network call is made");
});

test("the gateway check never reads stored status", async () => {
  // A row can say `connected` from an hour ago while the proxy is long gone; the
  // whole point of this check is that it asks the endpoint instead of the database.
  const stale = connection({ status: "connected", lastVerifiedAt: "2026-01-01T00:00:00.000Z" });
  const checks = await collectGatewayChecks([stale], probeReturning({ reachable: false, detail: "ECONNREFUSED" }));

  assert.equal(checks[0].status, "fail", "a stored 'connected' must not mask a dead endpoint");
});

test("each gateway gets its own keyed check", async () => {
  const checks = await collectGatewayChecks(
    [connection({ id: "a" }), connection({ id: "b", accountLabel: "Second proxy" })],
    probeReturning({ reachable: true, statusCode: 200 }),
  );

  assert.deepEqual(
    checks.map((check) => check.key),
    ["gateway:a", "gateway:b"],
  );
  assert.match(String(checks[1].label), /Second proxy/);
});
