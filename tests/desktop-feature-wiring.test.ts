import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * Source-wiring tests for desktop features whose runtime path crosses four files:
 * contract -> preload -> IPC handler -> renderer. A backend-only implementation
 * compiles but appears as `window.agentic.<method> is undefined` in the packaged
 * app, so each public method is pinned end to end here.
 */

test("branch and stash operations are exposed across the Electron bridge", async () => {
  const [contract, preload, register, panel] = await Promise.all([
    read("src/contracts/ipc.ts"),
    read("src/preload/preload.ts"),
    read("src/main/ipc/register-ipc.ts"),
    read("src/renderer/components/GitDiffPanel.tsx"),
  ]);

  const methods = ["branches", "checkout", "stashes", "stashDetail", "stashPush", "stashApply", "stashDrop"];
  for (const method of methods) {
    assert.match(contract, new RegExp(`\\b${method}:`), `${method} is missing from AgenticDesktopApi.git`);
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} is missing from the preload bridge`);
    assert.match(panel, new RegExp(`agentic\\.git\\.${method}\\b`), `${method} is never called by the Git UI`);
  }

  for (const channel of [
    "git:branches",
    "git:checkout",
    "git:stashes",
    "git:stash-detail",
    "git:stash-push",
    "git:stash-apply",
    "git:stash-drop",
  ]) {
    assert.match(preload, new RegExp(`invoke\\(["']${channel}["']`), `${channel} is missing from preload`);
    assert.match(register, new RegExp(`handle\\(["']${channel}["']`), `${channel} has no main-process handler`);
  }

  assert.match(panel, /label="Branches"/);
  assert.match(panel, /label="Stashes"/);
  assert.match(panel, /Include untracked files/);
  assert.match(panel, /window\.confirm\(/, "irreversible stash drop must ask for confirmation");
  assert.match(panel, /This cannot be undone/, "the confirmation states the consequence plainly");
  assert.match(panel, /expectedMessage|entry\.message/, "stash drop must carry the rendered message as a stack-shift guard");
});

test("storage report and cleanup are exposed and rendered in Diagnostics", async () => {
  const [contract, preload, register, integrations, panel] = await Promise.all([
    read("src/contracts/ipc.ts"),
    read("src/preload/preload.ts"),
    read("src/main/ipc/register-ipc.ts"),
    read("src/renderer/integrations/IntegrationsModule.tsx"),
    read("src/renderer/settings/StoragePanel.tsx"),
  ]);

  for (const method of ["storage", "cleanupStorage"]) {
    assert.match(contract, new RegExp(`\\b${method}:`), `${method} is missing from AgenticDesktopApi.system`);
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} is missing from the preload bridge`);
    assert.match(panel, new RegExp(`agentic\\.system\\.${method}\\b`), `${method} is never called by StoragePanel`);
  }

  assert.match(preload, /invoke\("system:storage"/);
  assert.match(preload, /invoke\("system:cleanup-storage"/);
  assert.doesNotMatch(preload, /cleanupStorage:\s*\([^)]*olderThanDays/, "renderer cannot override the retention policy");
  assert.match(register, /handle\("system:storage"/);
  assert.match(register, /handle\("system:cleanup-storage"/);
  assert.doesNotMatch(register, /cleanup-storage[\s\S]{0,120}olderThanDays/, "IPC does not accept a custom cleanup age");
  assert.match(integrations, /<StoragePanel\s*\/>/, "the panel must be mounted on the Integrations/Diagnostics surface");
  assert.match(panel, /Active runs are never touched|describeCleanupScope/, "the cleanup scope must be explained before action");
  assert.match(panel, /Clean up now/);
});

test("Grok and OpenCode chat output parsing is imported by the actual chat panel", async () => {
  const [panel, parser, catalog] = await Promise.all([
    read("src/renderer/agents/AgentChatPanel.tsx"),
    read("src/renderer/agents/structured-chat-output.ts"),
    read("src/main/agents/catalog.ts"),
  ]);

  assert.match(panel, /from ["']\.\/structured-chat-output["']/);
  assert.match(panel, /extractStructuredAssistantText\(clean\)/);
  assert.match(parser, /record\.part/);
  assert.match(parser, /split\("\\n"\)/, "JSONL output must be read line by line");

  const grokBlock = catalog.slice(catalog.indexOf('id: "grok"'), catalog.indexOf('id: "claude"'));
  assert.match(grokBlock, /structuredChat:/);
  assert.match(grokBlock, /conversationIdFields: \["sessionId"\]/);

  const opencodeBlock = catalog.slice(catalog.indexOf('id: "opencode"'), catalog.indexOf('id: "cursor"'));
  assert.match(opencodeBlock, /structuredChat:/);
  assert.match(opencodeBlock, /conversationIdFields: \["sessionID"\]/);
  assert.match(opencodeBlock, /outputFormat: "jsonl"/);
});

test("the privileged window denies navigation and every Git handler checks the approved project path", async () => {
  const [windowSource, register] = await Promise.all([
    read("src/main/windows/main-window.ts"),
    read("src/main/ipc/register-ipc.ts"),
  ]);

  assert.match(windowSource, /webContents\.on\("will-navigate"/);
  assert.match(windowSource, /event\.preventDefault\(\)/);
  assert.match(windowSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(register, /const approvedGitCwd/);

  for (const channel of ["diff", "file-diff", "log", "stage", "unstage", "commit", "branches", "checkout", "stashes", "stash-detail", "stash-push", "stash-apply", "stash-drop"]) {
    const start = register.indexOf(`ipcMain.handle("git:${channel}"`);
    assert.ok(start >= 0, `git:${channel} handler is missing`);
    const next = register.indexOf("ipcMain.handle(", start + 20);
    const body = register.slice(start, next >= 0 ? next : register.length);
    assert.match(body, /approvedGitCwd\(cwd\)/, `git:${channel} does not scope cwd to an approved project`);
  }
});
