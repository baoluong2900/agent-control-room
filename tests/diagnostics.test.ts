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

test("collectDiagnostics reads the catalog once and keeps unsupported smoke tests unknown", async () => {
  let catalogReads = 0;
  const descriptor = getAgentDescriptor("claude");
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
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(catalogReads, 1);
  assert.equal(result.tools[0].displayName, descriptor.displayName);
  assert.equal(result.tools[0].checks?.find((check) => check.key.endsWith(":smoke"))?.status, "unknown");
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
