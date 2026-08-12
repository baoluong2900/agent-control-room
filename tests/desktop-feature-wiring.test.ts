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
  assert.match(panel, /stashDrop\(project!\.path, entry\.ref, entry\.oid\)/, "stash drop must carry the immutable OID as a stack-shift guard");
  assert.match(panel, /stashApply\(project!\.path, entry\.ref, entry\.oid, keep\)/, "apply/pop must carry the same immutable identity");
});

test("outbound Git operations are exposed across the bridge and gated in the UI", async () => {
  const [contract, preload, register, panel, css] = await Promise.all([
    read("src/contracts/ipc.ts"),
    read("src/preload/preload.ts"),
    read("src/main/ipc/register-ipc.ts"),
    read("src/renderer/components/GitDiffPanel.tsx"),
    read("src/renderer/styles.css"),
  ]);

  for (const method of ["tracking", "fetch", "pull", "pushPlan", "push", "blame"]) {
    assert.match(contract, new RegExp(`\\b${method}:`), `${method} is missing from AgenticDesktopApi.git`);
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} is missing from the preload bridge`);
    assert.match(panel, new RegExp(`agentic\\.git\\.${method}\\b`), `${method} is never called by the Git UI`);
  }

  const channels = ["git:tracking", "git:fetch", "git:pull", "git:push-plan", "git:push", "git:blame"];
  for (const channel of channels) {
    assert.match(preload, new RegExp(`invoke\\(["']${channel}["']`), `${channel} is missing from preload`);
    // `\s*` matters: a handler with a long argument list is wrapped by the
    // formatter, putting the channel name on its own line.
    assert.match(register, new RegExp(`handle\\(\\s*["']${channel}["']`), `${channel} has no main-process handler`);
  }

  // Every outbound channel must stay inside the approved-project allowlist: fetch
  // and push contact a network host, so an unscoped path would let the renderer
  // choose whose repository leaves the machine.
  for (const channel of channels) {
    const handler = new RegExp(`handle\\(\\s*["']${channel}["'][\\s\\S]{0,320}?approvedGitCwd`);
    assert.match(register, handler, `${channel} must scope its cwd through approvedGitCwd`);
  }

  assert.match(panel, /label="Remote"/);
  assert.match(panel, /label="Blame"/);
  assert.match(panel, /window\.confirm\(/, "push must ask before sending code off the machine");
  assert.match(panel, /expectedBranch: pushPlan\.branch/, "push must pin the branch the confirmation named");
  assert.match(panel, /allowProtected: allowProtectedPush/, "the protected-branch toggle must reach the backend");
  assert.match(panel, /Force push is never available here\./);
  assert.doesNotMatch(panel, /--force/, "the UI must not offer a force push");

  // Classes referenced by the new markup have to exist, or the view renders unstyled.
  for (const className of [
    "git-blame-list",
    "git-blame-row",
    "git-blame-meta",
    "git-blame-line",
    "git-remote-status",
    "git-remote-counts",
    "git-remote-hint",
    "git-remote-actions",
  ]) {
    assert.match(css, new RegExp(`\\.${className}\\s*[,{:]`), `.${className} is referenced by markup but has no CSS rule`);
  }
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

test("Grok, OpenCode and codex chat output parsing reaches the actual chat panel", async () => {
  const [panel, transcript, parser, catalog] = await Promise.all([
    read("src/renderer/agents/AgentChatPanel.tsx"),
    read("src/renderer/agents/chat-transcript.ts"),
    read("src/renderer/agents/structured-chat-output.ts"),
    read("src/main/agents/catalog.ts"),
  ]);

  // The panel renders through the transcript builder, which is what calls the
  // parser. Both links have to hold, or the parser is dead code that still has
  // green unit tests.
  assert.match(panel, /from ["']\.\/chat-transcript["']/);
  assert.match(panel, /buildChatMessages\(source, supportsStructuredChat\)/);
  assert.match(transcript, /from ["']\.\/structured-chat-output["']/);
  assert.match(transcript, /extractStructuredAssistantText\(clean\)/);
  assert.match(parser, /record\.part/);
  assert.match(parser, /split\("\\n"\)/, "JSONL output must be read line by line");

  const grokBlock = catalog.slice(catalog.indexOf('id: "grok"'), catalog.indexOf('id: "claude"'));
  assert.match(grokBlock, /structuredChat:/);
  assert.match(grokBlock, /conversationIdFields: \["sessionId"\]/);

  const opencodeBlock = catalog.slice(catalog.indexOf('id: "opencode"'), catalog.indexOf('id: "cursor"'));
  assert.match(opencodeBlock, /structuredChat:/);
  assert.match(opencodeBlock, /conversationIdFields: \["sessionID"\]/);
  assert.match(opencodeBlock, /outputFormat: "jsonl"/);

  const codexBlock = catalog.slice(catalog.indexOf('id: "codex"'), catalog.indexOf('id: "gemini"'));
  assert.match(codexBlock, /structuredChat:/);
  assert.match(codexBlock, /resumeArgs: \["exec", "resume", "--json", "\{id\}"\]/);
  assert.match(codexBlock, /conversationIdFields: \["thread_id"\]/);
  // The answer lives in an `agent_message` item; without this branch the parser
  // would surface a `command_execution`'s shell output as the reply.
  assert.match(parser, /agent_message/);
});

test("gateway chat streaming is exposed across all four bridge layers and rendered", async () => {
  const [contract, preload, register, main, panel, integrations] = await Promise.all([
    read("src/contracts/ipc.ts"),
    read("src/preload/preload.ts"),
    read("src/main/ipc/register-ipc.ts"),
    read("src/main/main.ts"),
    read("src/renderer/gateway/GatewayChatPanel.tsx"),
    read("src/renderer/integrations/IntegrationsModule.tsx"),
  ]);

  for (const method of ["listChatTargets", "sendChat", "cancelChat"]) {
    assert.match(contract, new RegExp(`\\b${method}:`), `${method} is missing from AgenticDesktopApi.gateway`);
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} is missing from the preload bridge`);
    assert.match(panel, new RegExp(`bridge\\.${method}\\b`), `${method} is never called by the chat panel`);
  }

  for (const channel of ["gateway:chat-targets", "gateway:chat-send", "gateway:chat-cancel"]) {
    assert.match(preload, new RegExp(`invoke\\(["']${channel}["']`), `${channel} is missing from preload`);
    assert.match(register, new RegExp(`handle\\(["']${channel}["']`), `${channel} has no main-process handler`);
  }

  // Deltas arrive as pushed events, so the listener side of the bridge has to hold
  // too — without it the reply would only appear once the request finished.
  assert.match(contract, /subscribeGatewayChat:/);
  assert.match(preload, /ipcRenderer\.on\("gateway:chat-event"/);
  assert.match(panel, /subscribeGatewayChat/);

  // The service must actually be constructed and handed to the IPC registrar, or
  // every channel above is registered against nothing.
  assert.match(main, /new GatewayChatService\(/);
  assert.match(main, /gatewayChatService,/);
  // In-flight streams emit at a webContents that is about to be destroyed.
  assert.match(main, /gatewayChatService\?\.stopAll\(\)/, "streams must be aborted on the quit path");

  assert.match(integrations, /<GatewayChatPanel/, "the panel must be mounted on a real surface");
  // The id is minted before the request leaves, which is what makes Stop work during
  // the wait before the first token.
  assert.match(panel, /requestIdRef\.current = requestId/);
  assert.match(panel, /cancelChat\(requestId\)/);
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
    const start = register.indexOf(`registry.handle("git:${channel}"`);
    assert.ok(start >= 0, `git:${channel} handler is missing`);
    const next = register.indexOf("registry.handle(", start + 20);
    const body = register.slice(start, next >= 0 ? next : register.length);
    assert.match(body, /approvedGitCwd\(cwd\)/, `git:${channel} does not scope cwd to an approved project`);
  }
});
