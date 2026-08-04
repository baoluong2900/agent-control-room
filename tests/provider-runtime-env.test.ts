import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent } from "../src/contracts/agent.ts";
import { buildProviderRuntimeEnv, selectProviderConnection } from "../src/main/agents/provider-runtime-env.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { ProviderSecretVault, type SecretStorage } from "../src/main/settings/provider-secret-vault.ts";
import { SettingsService } from "../src/main/settings/settings-service.ts";

function createStorage(): SecretStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decryptString: (cipherText) => cipherText.toString("utf8").replace(/^enc:/, ""),
  };
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`));
}

test("provider runtime picks explicit and native connected providers", () => {
  const now = new Date().toISOString();
  const custom = {
    id: "custom-1",
    userId: "user-1",
    provider: "custom-api" as const,
    authMode: "api-key" as const,
    storageMode: "local" as const,
    status: "connected" as const,
    createdAt: now,
    updatedAt: now,
  };
  const claude = { ...custom, id: "claude-1", provider: "claude-code" as const, authMode: "oauth" as const };
  const expired = { ...custom, id: "expired-1", status: "expired" as const };

  assert.equal(selectProviderConnection("claude", [custom, claude], undefined)?.id, "claude-1");
  assert.equal(selectProviderConnection("aider", [custom, claude], undefined)?.id, "custom-1");
  assert.equal(selectProviderConnection("codex", [expired], "expired-1"), null);
  assert.equal(selectProviderConnection("shell", [custom], "custom-1")?.id, "custom-1");
});

test("an unverified connection is usable but an expired or disconnected one is not", () => {
  const now = new Date().toISOString();
  const base = {
    id: "custom-1",
    userId: "user-1",
    provider: "custom-api" as const,
    authMode: "api-key" as const,
    storageMode: "local" as const,
    createdAt: now,
    updatedAt: now,
  };

  // Every connection starts "unverified", so treating it as unusable would mean a
  // freshly saved key could not run until the user clicked Verify.
  const unverified = { ...base, status: "unverified" as const };
  assert.equal(selectProviderConnection("aider", [unverified], undefined)?.id, "custom-1");
  assert.equal(selectProviderConnection("aider", [unverified], "custom-1")?.id, "custom-1");

  // These two states mean a check actually concluded something was wrong.
  assert.equal(selectProviderConnection("aider", [{ ...base, status: "disconnected" as const }], undefined), null);
  assert.equal(selectProviderConnection("aider", [{ ...base, status: "expired" as const }], "custom-1"), null);
});

test("provider runtime env maps API-key connections to CLI environment variables", () => {
  const now = new Date().toISOString();
  const env = buildProviderRuntimeEnv({
    connection: {
      id: "connection-1",
      userId: "user-1",
      provider: "custom-api",
      authMode: "api-key",
      storageMode: "local",
      status: "connected",
      accountLabel: "internal",
      createdAt: now,
      updatedAt: now,
    },
    secret: "sk-runtime",
  });

  assert.equal(env.AGENTIC_PROVIDER_CONNECTION_ID, "connection-1");
  assert.equal(env.AGENTIC_PROVIDER, "custom-api");
  assert.equal(env.AGENTIC_PROVIDER_API_KEY, "sk-runtime");
  assert.equal(env.OPENAI_API_KEY, "sk-runtime");
  assert.equal(env.CUSTOM_API_KEY, "sk-runtime");
});

test("agent process injects selected provider secret into spawned process env", async () => {
  const dir = tempDir("provider-runtime");
  const db = await DesktopDatabase.open(dir);
  const vault = new ProviderSecretVault(dir, createStorage());
  const settings = new SettingsService(db, vault, { openExternal: async () => {} });
  const connection = settings.saveProviderConnection({
    provider: "custom-api",
    accountLabel: "runtime",
    tokenSecret: "sk-from-vault",
  });
  const events: AgentEvent[] = [];
  const manager = new AgentProcessManager(db, () => ({ send: (_channel: string, event: AgentEvent) => events.push(event) }) as never, vault);

  const run = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "print env",
    providerConnectionId: connection.id,
    shellCommand: "printf '%s|%s|%s' \"$OPENAI_API_KEY\" \"$CUSTOM_API_KEY\" \"$AGENTIC_PROVIDER\"",
  });

  const exit = await waitFor(events, (event) => event.runId === run.runId && event.type === "run:exit");
  assert.ok(exit);
  const output = events
    .filter((event) => event.runId === run.runId && event.type === "run:stdout")
    .map((event) => event.message)
    .join("");
  assert.equal(output, "sk-from-vault|sk-from-vault|custom-api");

  manager.stopAll();
  db.close();
});

async function waitFor(events: AgentEvent[], predicate: (event: AgentEvent) => boolean, timeoutMs = 3000): Promise<AgentEvent | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}
