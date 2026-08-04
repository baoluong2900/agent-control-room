import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowSaveInput } from "@contracts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { ProviderSecretVault, type SecretStorage } from "../src/main/settings/provider-secret-vault.ts";
import { SettingsService } from "../src/main/settings/settings-service.ts";
import { WorkflowService } from "../src/main/workflows/workflow-service.ts";
import { applyStepContext } from "../src/main/workflows/step-context.ts";

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

function shellStep(
  name: string,
  command: string,
  overrides: Partial<WorkflowSaveInput["steps"][number]> = {},
): WorkflowSaveInput["steps"][number] {
  return {
    name,
    kind: "execute",
    summary: name,
    cliId: "shell",
    model: "none",
    instruction: command,
    shellCommand: command,
    timeoutSeconds: 30,
    requiresApproval: false,
    continueOnError: false,
    enabled: true,
    ...overrides,
  };
}

function workflowWith(steps: WorkflowSaveInput["steps"], name = "Chained flow"): WorkflowSaveInput {
  return {
    name,
    description: "",
    status: "active",
    favorite: false,
    owner: "Tester",
    projectPath: process.cwd(),
    trigger: { type: "manual" },
    integrations: [],
    steps,
  };
}

test("a workflow step receives the provider credentials of the profile it runs as", async () => {
  const dir = tempDir("workflow-provider");
  const db = await DesktopDatabase.open(dir);
  const vault = new ProviderSecretVault(dir, createStorage());
  const settings = new SettingsService(db, vault, { openExternal: async () => {} });

  const connection = settings.saveProviderConnection({
    provider: "custom-api",
    accountLabel: "workflow runtime",
    tokenSecret: "sk-workflow",
  });
  const profile = db.saveAgentProfile({
    name: "Reviewer",
    role: "reviewer",
    cliId: "shell",
    model: "none",
    providerConnectionId: connection.id,
  });

  const service = new WorkflowService(db, () => null, vault);
  const workflow = service.save(
    workflowWith([
      shellStep("Echo secret", 'printf "%s|%s" "$OPENAI_API_KEY" "$AGENTIC_PROVIDER"', {
        profileId: profile.id,
      }),
    ]),
  );

  const run = await service.run({ workflowId: workflow.id });

  assert.equal(run.status, "success");
  // Before the fix this was empty: the workflow path spawned with a bare
  // process.env and never resolved the profile's connection.
  assert.equal(run.steps[0].output?.trim(), "sk-workflow|custom-api");

  db.close();
});

test("a step without a profile still runs, and one naming a deleted profile falls back to its own CLI", async () => {
  const dir = tempDir("workflow-profile-fallback");
  const db = await DesktopDatabase.open(dir);
  const service = new WorkflowService(db, () => null, undefined);

  const workflow = service.save(
    workflowWith([
      shellStep("Bare step", 'printf "ran"'),
      shellStep("Ghost profile", 'printf "still-ran"', { profileId: "profile-that-never-existed" }),
    ]),
  );

  const run = await service.run({ workflowId: workflow.id });

  assert.equal(run.status, "success");
  assert.equal(run.steps[0].output?.trim(), "ran");
  assert.equal(run.steps[1].output?.trim(), "still-ran");

  db.close();
});

test("a later step receives the previous step's output", async () => {
  const dir = tempDir("workflow-context");
  const db = await DesktopDatabase.open(dir);
  const service = new WorkflowService(db, () => null, undefined);

  const workflow = service.save(
    workflowWith([
      shellStep("Find", 'printf "ROOT_CAUSE=missing-null-check"'),
      // `cat` proves the context arrived on stdin-independent argv, not that the
      // shell happened to inherit something.
      shellStep("Report", "printf '%s' \"{{previous.output}}\""),
    ]),
  );

  const run = await service.run({ workflowId: workflow.id });

  assert.equal(run.status, "success");
  assert.match(run.steps[1].output ?? "", /ROOT_CAUSE=missing-null-check/);

  db.close();
});

test("a step can reference an earlier step by name across an approval gate", async () => {
  const dir = tempDir("workflow-context-gate");
  const db = await DesktopDatabase.open(dir);
  const service = new WorkflowService(db, () => null, undefined);

  const workflow = service.save(
    workflowWith([
      shellStep("Investigate", 'printf "FINDING=race-condition"'),
      shellStep("Gate", "printf 'gate'", { kind: "approval", requiresApproval: true }),
      shellStep("Execute", "printf '%s' \"{{steps.investigate.output}}\""),
    ]),
  );

  const parked = await service.run({ workflowId: workflow.id });
  assert.equal(parked.status, "waiting-approval");

  const resumed = await service.approve(parked.id);

  assert.equal(resumed.status, "success");
  const executeStep = resumed.steps.find((step) => step.name === "Execute");
  // Context has to survive the pause, which is why outcomes are parked with the
  // pending approval rather than kept in the executeSteps call frame.
  assert.match(executeStep?.output ?? "", /FINDING=race-condition/);

  db.close();
});

test("context interpolation handles missing steps, no placeholders, and oversized output", () => {
  const outcomes = [
    { stepId: "s1", name: "Investigate", kind: "investigate" as const, status: "success" as const, output: "found it" },
  ];

  // An explicit placeholder that matches nothing must not leak literal braces
  // into the prompt, where an agent would try to interpret them.
  assert.equal(applyStepContext("{{steps.nope.output}}", outcomes), "(no output from that step)");
  assert.equal(applyStepContext("{{previous.output}}", []), "(no output from that step)");

  // No placeholder: the previous output is appended so old workflows chain too.
  const appended = applyStepContext("Do the thing", outcomes);
  assert.match(appended, /^Do the thing/);
  assert.match(appended, /found it/);

  // Nothing to append means the instruction is left exactly as authored.
  assert.equal(applyStepContext("Do the thing", []), "Do the thing");

  // A shell command must never gain appended prose: the shell would run it.
  assert.equal(
    applyStepContext('printf "hi"', outcomes, { appendWhenNoPlaceholder: false }),
    'printf "hi"',
  );

  const long = [{ ...outcomes[0], output: "x".repeat(9000) }];
  const clamped = applyStepContext("{{previous.output}}", long, { maxChars: 100 });
  assert.ok(clamped.length < 400, "expected the injected context to be clamped");
  assert.match(clamped, /truncated/);
});

test("a shell step does not get prose context appended to the command it executes", async () => {
  const dir = tempDir("workflow-shell-safety");
  const db = await DesktopDatabase.open(dir);
  const service = new WorkflowService(db, () => null, undefined);

  // The second step has no placeholder. If the previous output were appended, the
  // shell would try to execute those lines and the step would exit non-zero.
  const workflow = service.save(
    workflowWith([
      shellStep("First", 'printf "some findings here"'),
      shellStep("Second", 'printf "second-ok"'),
    ]),
  );

  const run = await service.run({ workflowId: workflow.id });

  assert.equal(run.status, "success");
  assert.equal(run.steps[1].output?.trim(), "second-ok");

  db.close();
});

test("a base URL reaches the CLI so runs can be pointed at a local proxy", async () => {
  const dir = tempDir("workflow-base-url");
  const db = await DesktopDatabase.open(dir);
  const vault = new ProviderSecretVault(dir, createStorage());
  const settings = new SettingsService(db, vault, { openExternal: async () => {} });

  const connection = settings.saveProviderConnection({
    provider: "custom-api",
    accountLabel: "router",
    tokenSecret: "sk-router",
    baseUrl: "http://127.0.0.1:20128/v1",
  });
  const profile = db.saveAgentProfile({
    name: "Routed",
    role: "coder",
    cliId: "shell",
    model: "none",
    providerConnectionId: connection.id,
  });

  const service = new WorkflowService(db, () => null, vault);
  const workflow = service.save(
    workflowWith([
      shellStep("Echo base url", 'printf "%s|%s" "$OPENAI_BASE_URL" "$AGENTIC_PROVIDER_BASE_URL"', {
        profileId: profile.id,
      }),
    ]),
  );

  const run = await service.run({ workflowId: workflow.id });

  assert.equal(run.status, "success");
  assert.equal(run.steps[0].output?.trim(), "http://127.0.0.1:20128/v1|http://127.0.0.1:20128/v1");

  db.close();
});

test("saving an empty base URL clears a previously stored proxy endpoint", async () => {
  const dir = tempDir("base-url-clear");
  const db = await DesktopDatabase.open(dir);
  const vault = new ProviderSecretVault(dir, createStorage());
  const settings = new SettingsService(db, vault, { openExternal: async () => {} });

  const saved = settings.saveProviderConnection({
    provider: "custom-api",
    accountLabel: "router",
    tokenSecret: "sk-router",
    baseUrl: "http://127.0.0.1:20128/v1",
  });
  assert.equal(saved.baseUrl, "http://127.0.0.1:20128/v1");

  // Undefined leaves the endpoint alone...
  const untouched = settings.saveProviderConnection({
    id: saved.id,
    provider: "custom-api",
    accountLabel: "router",
  });
  assert.equal(untouched.baseUrl, "http://127.0.0.1:20128/v1");

  // ...while an empty string is a deliberate "stop using the proxy".
  const cleared = settings.saveProviderConnection({
    id: saved.id,
    provider: "custom-api",
    accountLabel: "router",
    baseUrl: "",
  });
  assert.equal(cleared.baseUrl, undefined);

  db.close();
});
