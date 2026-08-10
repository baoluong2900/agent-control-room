import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentDescriptor } from "../src/main/agents/catalog.ts";
import {
  collectDatabaseChecks,
  collectDiagnostics,
  collectProjectChecks,
  collectProviderChecks,
  runSmokeCheck,
} from "../src/main/ipc/diagnostics.ts";

function fakeTool(id: "git" | "docker", installed = true) {
  return {
    id,
    displayName: id === "git" ? "Git" : "Docker",
    installed,
    detail: installed ? "ready" : "not found",
    checks: [],
  };
}

test("collectDiagnostics reads the catalog once and runs the declared smoke test", async () => {
  let catalogReads = 0;
  const descriptor = getAgentDescriptor("claude");
  const smokeCalls: Array<{ command: string; args: string[] }> = [];
  const database = {
    databaseHealth: () => ({ schemaVersion: 7, sizeBytes: 4096, terminalLogRows: 0 }),
  };
  const settings = { listProviderConnections: () => [] };

  const result = await collectDiagnostics(database as never, settings as never, null, {
    listCatalog: () => {
      catalogReads += 1;
      return [descriptor];
    },
    pingCli: async (cliId) => ({
      cliId,
      ok: true,
      installed: true,
      command: "/usr/local/bin/claude",
      version: "1.0.0",
      detail: "Claude Code 1.0.0",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    checkExternalTool: async (id) => fakeTool(id),
    checkProject: async () => [],
    // Stubbed so the suite neither spawns a CLI nor depends on which are installed.
    runSmoke: async (command, args) => {
      smokeCalls.push({ command, args });
      return { ok: true, output: "No MCP servers configured.", timedOut: false };
    },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(catalogReads, 1);
  assert.equal(result.tools[0].displayName, descriptor.displayName);

  const smoke = result.tools[0].checks?.find((check) => check.key.endsWith(":smoke"));
  assert.equal(smoke?.status, "ok", "a passing quota-safe probe must report ok, not unknown");
  assert.equal(smoke?.detail, descriptor.smokeTest?.proves, "the check states what the probe actually proved");
  assert.deepEqual(
    smokeCalls.map((call) => call.args),
    [descriptor.smokeTest?.args],
    "the descriptor's own args are what get run",
  );
});

test("the smoke check discriminates between passing, failing, empty and unclaimed", async () => {
  const claude = getAgentDescriptor("claude");
  const expect = claude.smokeTest?.expect ?? "";
  const pass = async () => ({ ok: true, output: `header\n${expect}\ntail`, timedOut: false });

  // A guard is only worth having if it separates cases. Drive the real code with
  // inputs that must be rejected plus one that must be accepted, and show the split.
  const outcomes = {
    passing: await runSmokeCheck("claude", claude, true, pass),
    nonZeroExit: await runSmokeCheck("claude", claude, true, async () => ({
      ok: false,
      output: "command not recognised",
      timedOut: false,
    })),
    // The case a plain exit-code check cannot see: `grok models` exits 0 while
    // printing "You are not authenticated", which proves nothing about usability.
    cleanExitWrongOutput: await runSmokeCheck("claude", claude, true, async () => ({
      ok: true,
      output: "You are not authenticated.",
      timedOut: false,
    })),
    timedOut: await runSmokeCheck("claude", claude, true, async () => ({ ok: false, output: "", timedOut: true })),
    notInstalled: await runSmokeCheck("claude", claude, false, pass),
    // A CLI that declares no probe: `unknown`, and the wording must say there is no
    // quota-safe command rather than implying the app forgot to declare one.
    noProbe: await runSmokeCheck(
      "gemini",
      { ...claude, id: "gemini", smokeTest: undefined },
      true,
      pass,
    ),
  };

  assert.deepEqual(
    Object.fromEntries(Object.entries(outcomes).map(([name, check]) => [name, check.status])),
    {
      passing: "ok",
      nonZeroExit: "warn",
      cleanExitWrongOutput: "warn",
      timedOut: "warn",
      notInstalled: "unknown",
      noProbe: "unknown",
    },
    "were the check a no-op, every one of these would report the same status",
  );

  // Never `fail`: a CLI whose local helper command misbehaves may still run a real
  // prompt perfectly, so Diagnostics degrades rather than condemning it.
  assert.equal(
    Object.values(outcomes).some((check) => check.status === "fail"),
    false,
    "a smoke probe must never report fail",
  );

  assert.equal(outcomes.passing.detail, claude.smokeTest?.proves);
  assert.match(outcomes.cleanExitWrongOutput.detail ?? "", /did not look like a real answer/);
  assert.match(outcomes.notInstalled.detail ?? "", /not on PATH/);
  assert.match(outcomes.noProbe.detail ?? "", /no command that can be exercised without spending provider quota/);
  assert.doesNotMatch(outcomes.noProbe.detail ?? "", /does not declare/, "the copy must not read as an unfinished feature");

  // Every declared probe must actually be quota-safe. A prompt-shaped smoke test
  // would bill the user for opening a health panel, which is the whole point of
  // keeping this tier local.
  for (const descriptor of [claude, getAgentDescriptor("kiro"), getAgentDescriptor("codex"), getAgentDescriptor("opencode")]) {
    const args = descriptor.smokeTest?.args ?? [];
    assert.ok(args.length > 0, `${descriptor.id} declares a smoke test with no args`);
    for (const flag of [descriptor.promptFlag, descriptor.modelFlag]) {
      if (flag) assert.equal(args.includes(flag), false, `${descriptor.id}'s smoke test must not carry ${flag}`);
    }
    assert.ok(descriptor.smokeTest?.proves, `${descriptor.id} must say what its probe proves`);
  }
});

test("provider diagnostics are read-only and distinguish connected, stale, unverified and expired", () => {
  const now = new Date("2026-03-01T00:00:00.000Z");
  const connections = [
    {
      id: "fresh",
      userId: "u",
      provider: "claude-code",
      authMode: "oauth",
      storageMode: "local",
      accountLabel: "Fresh Claude",
      status: "connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastVerifiedAt: "2026-02-28T00:00:00.000Z",
    },
    {
      id: "stale",
      userId: "u",
      provider: "openai-codex",
      authMode: "oauth",
      storageMode: "local",
      status: "connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "new",
      userId: "u",
      provider: "kiro",
      authMode: "oauth",
      storageMode: "local",
      status: "unverified",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "expired",
      userId: "u",
      provider: "github-copilot",
      authMode: "device",
      storageMode: "local",
      status: "expired",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ] as const;
  const before = JSON.stringify(connections);

  const checks = collectProviderChecks(connections as never, now);

  assert.equal(JSON.stringify(connections), before, "reading Diagnostics must not mutate provider rows");
  assert.deepEqual(
    checks.map((check) => check.status),
    ["ok", "warn", "warn", "fail"],
  );
  assert.equal(checks[1].action?.target, "settings");
  assert.match(checks[1].detail ?? "", /Last verified/);
});

test("project diagnostics prove write access with a create/delete probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-diagnostics-"));
  const checks = await collectProjectChecks(root, false);

  assert.equal(checks[0].key, "project:writable");
  assert.equal(checks[0].status, "ok");
  assert.equal(checks[1].key, "project:git");
  assert.equal(checks[1].status, "unknown");
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.startsWith(".agentic-healthcheck-")),
    false,
    "the write probe must clean up after itself",
  );

  const missing = await collectProjectChecks(path.join(root, "missing"), true);
  assert.equal(missing[0].status, "fail");
  assert.equal(missing[0].action?.target, "project");
});

test("database diagnostics report schema, file size and retained terminal rows", () => {
  const checks = collectDatabaseChecks({
    databaseHealth: () => ({ schemaVersion: 7, sizeBytes: 12 * 1024 * 1024, terminalLogRows: 1234 }),
  } as never);

  assert.deepEqual(
    checks.map((check) => check.status),
    ["ok", "ok", "ok"],
  );
  assert.match(checks[0].detail ?? "", /version 7/);
  assert.match(checks[1].detail ?? "", /12\.0 MB/);
  assert.match(checks[2].detail ?? "", /1,234/);
});

test("database diagnostics degrade to one failure instead of throwing", () => {
  const checks = collectDatabaseChecks({
    databaseHealth: () => {
      throw new Error("database is locked");
    },
  } as never);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "fail");
  assert.match(checks[0].detail ?? "", /locked/);
});
