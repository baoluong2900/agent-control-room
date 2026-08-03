import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";

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
    module: "reviewer",
    model: "sonnet",
    providerConnectionId: connection.id,
  });
  assert.equal(profile.providerConnectionId, connection.id);
  assert.equal(profile.module, "reviewer");
  assert.equal(db.listAgentProfiles()[0]?.providerConnectionId, connection.id);
  assert.equal(db.listAgentProfiles()[0]?.module, "reviewer");

  db.deleteProviderConnection(connection.id);
  assert.equal(db.listProviderConnections().length, 0);
  db.close();
});

test("recent projects upsert by path and can be forgotten without losing run history", async () => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-project-test-${Date.now()}`));

  db.createOrUpdateProject({
    id: "project-1",
    name: "alpha",
    path: "/tmp/alpha",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  });
  db.createOrUpdateProject({
    id: "project-2",
    name: "beta",
    path: "/tmp/beta",
    lastOpenedAt: "2026-01-02T00:00:00.000Z",
  });

  // Most recently opened sorts first.
  assert.deepEqual(
    db.listRecentProjects().map((project) => project.path),
    ["/tmp/beta", "/tmp/alpha"],
  );

  // Re-opening the same path updates in place rather than duplicating.
  db.createOrUpdateProject({
    id: "project-3",
    name: "alpha-renamed",
    path: "/tmp/alpha",
    lastOpenedAt: "2026-01-03T00:00:00.000Z",
  });
  const afterReopen = db.listRecentProjects();
  assert.equal(afterReopen.length, 2);
  assert.equal(afterReopen[0]?.path, "/tmp/alpha");
  assert.equal(afterReopen[0]?.name, "alpha-renamed");

  db.createAgentRun({
    id: "run-in-alpha",
    cliId: "shell",
    cwd: "/tmp/alpha",
    prompt: "echo hi",
    model: "none",
    status: "completed",
    startedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const task = db.saveTask({ projectPath: "/tmp/alpha", title: "Keep me", prompt: "survive removal" });

  db.removeProject("/tmp/alpha");

  assert.deepEqual(
    db.listRecentProjects().map((project) => project.path),
    ["/tmp/beta"],
  );
  // Removing a folder from the recent list must not cascade into history or tasks.
  assert.equal(db.listAgentRuns().some((run) => run.id === "run-in-alpha"), true);
  assert.equal(db.getTask(task.id)?.title, "Keep me");

  // Removing an unknown path is a no-op.
  db.removeProject("/tmp/does-not-exist");
  assert.equal(db.listRecentProjects().length, 1);
  db.close();
});
