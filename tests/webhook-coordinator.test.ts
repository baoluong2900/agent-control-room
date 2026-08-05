import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { ProviderSecretVault } from "../src/main/settings/provider-secret-vault.ts";
import { WebhookCoordinator } from "../src/main/workflows/webhook-coordinator.ts";
import { WorkflowSchedulerService } from "../src/main/workflows/workflow-scheduler.ts";
import type { WorkflowService } from "../src/main/workflows/workflow-service.ts";

/** In-memory stand-in for Electron's safeStorage. */
function createStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  };
}

function webhookWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wf-hook",
    name: "Deploy hook",
    description: "",
    status: "active",
    favorite: false,
    owner: "You",
    projectPath: "/tmp/repo",
    trigger: { type: "webhook", detail: "deploy" },
    integrations: [],
    steps: [
      {
        id: "s1",
        name: "Run",
        kind: "execute",
        summary: "",
        cliId: "shell",
        model: "",
        shellCommand: "true",
        timeoutSeconds: 30,
        requiresApproval: false,
        continueOnError: false,
        enabled: true,
        order: 0,
      },
    ],
    stats: { runs: 0, successRate: 0, avgDurationMs: 0, lastRunAt: null },
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkflowDefinition;
}

function fakeWorkflows(definitions: WorkflowDefinition[]) {
  const runs: Array<{ workflowId: string; triggeredBy?: string }> = [];
  const service = {
    list: () => definitions,
    run: async (input: { workflowId: string; triggeredBy?: string }) => {
      runs.push(input);
      return { id: "run-1" };
    },
  } as unknown as WorkflowService;
  return { service, runs };
}

async function harness(t: { after: (fn: () => unknown) => void }, definitions: WorkflowDefinition[], available = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-webhook-"));
  const db = await DesktopDatabase.open(dir);
  t.after(() => db.close());

  const { service, runs } = fakeWorkflows(definitions);
  const scheduler = new WorkflowSchedulerService(service, () => null);
  const vault = new ProviderSecretVault(dir, createStorage(available));
  const coordinator = new WebhookCoordinator(db, vault, scheduler, () => null);
  t.after(() => coordinator.stop());

  return { db, dir, vault, scheduler, coordinator, runs, definitions };
}

test("no port is opened when no webhook workflow is active", async (t) => {
  const { coordinator } = await harness(t, [
    webhookWorkflow({ id: "paused", status: "paused" }),
    webhookWorkflow({ id: "no-detail", trigger: { type: "webhook" } }),
    webhookWorkflow({ id: "no-steps", steps: [] }),
    webhookWorkflow({ id: "other-trigger", trigger: { type: "schedule", schedule: "Daily, 9:00 AM" } }),
  ]);

  const status = await coordinator.sync();

  // The whole point of the design: a user who never configures a webhook never has
  // a listening socket.
  assert.equal(status.running, false);
  assert.equal(status.port, null);
});

test("a port opens once a webhook workflow is active, and closes when it is not", async (t) => {
  const definitions = [webhookWorkflow()];
  const { coordinator } = await harness(t, definitions);

  const started = await coordinator.sync();
  assert.equal(started.running, true);
  assert.match(started.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/hooks$/);

  // Pausing the workflow must release the port without an app restart.
  definitions[0] = webhookWorkflow({ status: "paused" });
  const stopped = await coordinator.sync();
  assert.equal(stopped.running, false);
  assert.equal(coordinator.status().running, false);
});

test("sync is idempotent and keeps the same port", async (t) => {
  const { coordinator } = await harness(t, [webhookWorkflow()]);

  const first = await coordinator.sync();
  const second = await coordinator.sync();

  // The scheduler calls this every tick; rebinding each time would drop deliveries
  // and churn the port number the user configured upstream.
  assert.equal(second.port, first.port);
  assert.equal(second.running, true);
});

test("a delivery to a matching hook runs the workflow end to end", async (t) => {
  const { coordinator, runs } = await harness(t, [webhookWorkflow()]);
  const status = await coordinator.sync();
  const token = coordinator.ensureToken();

  const response = await fetch(`${status.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "opened" }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, fired: ["wf-hook"] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggeredBy, "webhook");
});

test("a delivery to a hook nobody is listening for runs nothing", async (t) => {
  const { coordinator, runs } = await harness(t, [webhookWorkflow()]);
  const status = await coordinator.sync();
  const token = coordinator.ensureToken();

  const response = await fetch(`${status.baseUrl}/some-other-hook`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });

  // Accepted at the HTTP layer, but matched nothing — reported honestly as an
  // empty `fired` list rather than a 404, since the hook path itself is valid.
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, fired: [] });
  assert.deepEqual(runs, []);
});

test("the token survives a restart", async (t) => {
  const { coordinator, db, dir, vault, definitions } = await harness(t, [webhookWorkflow()]);
  const first = coordinator.ensureToken();

  // A new coordinator over the same database and vault is what the next app launch
  // looks like; a token that changed would silently break the user's configured
  // sender.
  const { service } = fakeWorkflows(definitions);
  const scheduler = new WorkflowSchedulerService(service, () => null);
  const second = new WebhookCoordinator(db, vault, scheduler, () => null);
  t.after(() => second.stop());

  assert.equal(second.ensureToken(), first);
  assert.ok(dir);
});

test("rotating the token invalidates the old one", async (t) => {
  const { coordinator } = await harness(t, [webhookWorkflow()]);
  const status = await coordinator.sync();
  const original = coordinator.ensureToken();

  const rotated = coordinator.rotateToken();
  assert.notEqual(rotated, original);

  // The running listener still holds the token it started with, so the caller has
  // to re-sync for a rotation to take effect. Restart it the way the app would.
  await coordinator.stop();
  const restarted = await coordinator.sync();

  const oldTokenResponse = await fetch(`${restarted.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${original}` },
    body: "{}",
  });
  assert.equal(oldTokenResponse.status, 401, "the old token stops working");

  const newTokenResponse = await fetch(`${restarted.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${rotated}` },
    body: "{}",
  });
  assert.equal(newTokenResponse.status, 202);
  assert.ok(status.running);
});

test("an unavailable vault still yields a working token for this session", async (t) => {
  // safeStorage is unavailable in some OS sessions. Refusing to run the feature
  // would be worse than a token that is not remembered across restarts.
  const { coordinator } = await harness(t, [webhookWorkflow()], false);

  const token = coordinator.ensureToken();
  assert.equal(token.length, 64);

  const status = await coordinator.sync();
  const response = await fetch(`${status.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });
  assert.equal(response.status, 202);
});

test("the same delivery arriving twice is debounced", async (t) => {
  const { coordinator, runs } = await harness(t, [webhookWorkflow()]);
  const status = await coordinator.sync();
  const token = coordinator.ensureToken();

  const send = () =>
    fetch(`${status.baseUrl}/deploy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });

  await send();
  await send();

  // Providers retry deliveries they think failed, and "redeliver" is one click in
  // most dashboards.
  assert.equal(runs.length, 1, "a retried delivery does not stack runs");
});

test("hook matching ignores case but not identity", async (t) => {
  const { coordinator, runs } = await harness(t, [webhookWorkflow({ trigger: { type: "webhook", detail: "Deploy" } })]);
  const status = await coordinator.sync();
  const token = coordinator.ensureToken();

  const matching = await fetch(`${status.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });
  assert.deepEqual(await matching.json(), { accepted: true, fired: ["wf-hook"] });

  const prefix = await fetch(`${status.baseUrl}/deploy-staging`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });
  // A prefix must not match, or `deploy` would capture `deploy-staging` too.
  assert.deepEqual(await prefix.json(), { accepted: true, fired: [] });
  assert.equal(runs.length, 1);
});
