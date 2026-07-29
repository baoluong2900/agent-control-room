import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../apps/desktop/src/main/database/desktop-database.ts";

test("task records persist and update status in local sqlite", async () => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-task-test-${Date.now()}`));

  const saved = db.saveTask({
    projectPath: "/tmp/project-a",
    title: "Investigate API",
    prompt: "Find the failing API boundary.",
  });

  assert.equal(saved.status, "open");
  assert.equal(db.listTasks("/tmp/project-a").length, 1);
  assert.equal(db.listTasks("/tmp/project-b").length, 0);

  const blocked = db.setTaskStatus(saved.id, "blocked");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.completedAt, null);

  const done = db.setTaskStatus(saved.id, "done");
  assert.equal(done.status, "done");
  assert.ok(done.completedAt);

  db.deleteTask(saved.id);
  assert.equal(db.listTasks("/tmp/project-a").length, 0);
  db.close();
});

test("app identity and provider connections persist locally", async () => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-settings-test-${Date.now()}`));

  const identity = db.getAppIdentity();
  assert.equal(identity.status, "signed-out");

  const signedIn = db.saveAppIdentity({
    displayName: "Bao",
    email: "bao@example.com",
    loginMethod: "github",
    status: "signed-in",
  });
  assert.equal(signedIn.displayName, "Bao");
  assert.equal(signedIn.loginMethod, "github");
  assert.equal(db.getAppIdentity().status, "signed-in");

  const connection = db.saveProviderConnection({
    provider: "claude-code",
    accountLabel: "Claude Max",
    status: "connected",
  });
  assert.equal(connection.provider, "claude-code");
  assert.equal(connection.status, "connected");
  assert.ok(connection.id);

  const profile = db.saveAgentProfile({
    name: "Provider-aware Agent",
    role: "Reviewer",
    cliId: "claude",
    model: "sonnet",
    providerConnectionId: connection.id,
  });
  assert.equal(profile.providerConnectionId, connection.id);
  assert.equal(db.listAgentProfiles()[0]?.providerConnectionId, connection.id);

  db.deleteProviderConnection(connection.id);
  assert.equal(db.listProviderConnections().length, 0);
  db.close();
});
