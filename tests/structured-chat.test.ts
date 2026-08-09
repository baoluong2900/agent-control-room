import assert from "node:assert/strict";
import test from "node:test";
import { getAgentDescriptor, listAgentCatalog } from "../src/main/agents/catalog.ts";
import {
  buildInvocation,
  structuredChatFor,
  usesStructuredChat,
  withoutStructuredChatConflicts,
} from "../src/main/agents/commands.ts";
import { extractConversationId } from "../src/main/processes/agent-process-manager.ts";

test("chat-capable CLIs declare their capability in the catalog, not in the argv builder", () => {
  assert.deepEqual(getAgentDescriptor("claude").structuredChat, {
    args: ["-p", "--output-format", "json"],
    resumeFlag: "--resume",
  });
  assert.deepEqual(getAgentDescriptor("agy").structuredChat, {
    args: ["--output-format", "json", "--print"],
    promptFlag: "--print",
    resumeFlag: "--conversation",
    conversationIdFields: ["conversation_id"],
  });
  assert.deepEqual(getAgentDescriptor("grok").structuredChat, {
    args: ["--output-format", "json", "--single"],
    promptFlag: "--single",
    resumeFlag: "--resume",
    conversationIdFields: ["sessionId"],
    outputFormat: "json",
  });
  assert.deepEqual(getAgentDescriptor("opencode").structuredChat, {
    args: ["run", "--format", "json"],
    resumeFlag: "--session",
    conversationIdFields: ["sessionID"],
    outputFormat: "jsonl",
  });
  assert.deepEqual(getAgentDescriptor("codex").structuredChat, {
    args: ["exec", "--json"],
    resumeArgs: ["exec", "resume", "--json", "{id}"],
    resumeDropsFlags: ["--sandbox", "--add-dir", "--profile", "--oss"],
    conversationIdFields: ["thread_id"],
    outputFormat: "jsonl",
  });
});

test("a capability declares either a resume flag or a resume subcommand, never both", () => {
  for (const descriptor of listAgentCatalog()) {
    const chat = descriptor.structuredChat;
    if (!chat) continue;
    const hasFlag = Boolean(chat.resumeFlag);
    const hasArgs = Boolean(chat.resumeArgs?.length);
    assert.ok(hasFlag !== hasArgs, `${descriptor.id}: exactly one resume mechanism must be declared`);
    if (hasArgs) {
      assert.ok(
        chat.resumeArgs?.includes("{id}"),
        `${descriptor.id}: resumeArgs must place the conversation id with the {id} token`,
      );
    }
  }
});

test("usesStructuredChat follows the capability and the ui mode together", () => {
  assert.equal(usesStructuredChat({ cliId: "claude", uiMode: "chat" }), true);
  assert.equal(usesStructuredChat({ cliId: "agy", uiMode: "chat" }), true);
  assert.equal(usesStructuredChat({ cliId: "grok", uiMode: "chat" }), true);
  assert.equal(usesStructuredChat({ cliId: "opencode", uiMode: "chat" }), true);

  assert.equal(usesStructuredChat({ cliId: "codex", uiMode: "chat" }), true);

  // Right CLI, wrong mode.
  assert.equal(usesStructuredChat({ cliId: "claude", uiMode: "terminal" }), false);
  assert.equal(usesStructuredChat({ cliId: "codex", uiMode: "terminal" }), false);
  // Right mode, CLI without the capability.
  assert.equal(usesStructuredChat({ cliId: "gemini", uiMode: "chat" }), false);
  // `shell` has no descriptor at all and must not throw.
  assert.equal(usesStructuredChat({ cliId: "shell", uiMode: "chat" }), false);
});

test("structuredChatFor tolerates a CLI with no descriptor", () => {
  assert.equal(structuredChatFor("shell"), undefined);
  assert.equal(structuredChatFor("gemini"), undefined);
  assert.ok(structuredChatFor("claude"));
});

test("only verified chat-capable CLIs carry the capability", () => {
  const capable = listAgentCatalog()
    .filter((entry) => entry.structuredChat)
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(capable, ["agy", "claude", "codex", "grok", "opencode"]);

  for (const unverified of ["gemini", "kiro", "amazonq"] as const) {
    assert.equal(
      getAgentDescriptor(unverified).structuredChat,
      undefined,
      `${unverified} must stay terminal-only until its output and resume semantics are verified`,
    );
  }
});

test("the catalog stays serialisable across the contextBridge", () => {
  // A function anywhere in a descriptor would be dropped or throw on the way to
  // the renderer, which is why the capability is plain data rather than the
  // `resumeArgs(id)` callback the design sketch first proposed.
  const findFunction = (value: unknown, path: string): string | null => {
    if (typeof value === "function") return path;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const hit = findFunction(value[index], `${path}[${index}]`);
        if (hit) return hit;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        const hit = findFunction(entry, `${path}.${key}`);
        if (hit) return hit;
      }
    }
    return null;
  };

  for (const entry of listAgentCatalog()) {
    assert.equal(findFunction(entry, entry.id), null, "a descriptor must not carry a function");
    // structuredClone is what contextBridge actually applies.
    assert.doesNotThrow(() => structuredClone(entry), `${entry.id} must survive structured cloning`);
  }
});

test("a capability added to the catalog needs no change in the argv builder", () => {
  // The point of the refactor: a third chat CLI is one catalog entry. Simulated
  // here by handing the builder's lookup a descriptor it has never special-cased.
  const descriptor = getAgentDescriptor("gemini");
  assert.equal(descriptor.structuredChat, undefined);
  assert.equal(usesStructuredChat({ cliId: "gemini", uiMode: "chat" }), false);

  const patched = { ...descriptor, structuredChat: { args: ["--json"], resumeFlag: "--session" } };
  // The builder reads `descriptor.structuredChat`; nothing keys off the id.
  assert.deepEqual(patched.structuredChat.args, ["--json"]);
  assert.equal(patched.structuredChat.resumeFlag, "--session");
});

test("extractConversationId reads one complete JSON object", () => {
  assert.equal(extractConversationId('{"session_id":"session-1","result":"ok"}'), "session-1");
  assert.equal(extractConversationId('{"conversation_id":"conversation-1"}'), "conversation-1");
});

test("extractConversationId reads the last usable id from JSONL", () => {
  const output = [
    '{"type":"start","session_id":"session-1"}',
    '{"type":"message","text":"hello"}',
    '{"type":"resume","conversation_id":"session-2"}',
  ].join("\n");
  assert.equal(extractConversationId(output), "session-2");
});

test("extractConversationId tolerates partial JSON and supports descriptor fields", () => {
  assert.equal(extractConversationId('{"session_id":"unfinished'), undefined);
  assert.equal(extractConversationId('{"thread":"thread-7"}', ["thread"]), "thread-7");
  assert.equal(extractConversationId('{"session_id":"wrong","thread":"right"}', ["thread"]), "right");
});

test("structured chat owns flags that would conflict with profile extra args", () => {
  assert.deepEqual(
    withoutStructuredChatConflicts(
      ["--verbose", "--output-format", "stream-json", "--permission-mode=plan"],
      ["-p", "--output-format", "json"],
    ),
    ["--verbose", "--permission-mode=plan"],
  );
  assert.deepEqual(
    withoutStructuredChatConflicts(["--output-format=stream-json", "--verbose"], ["--output-format", "json"]),
    ["--verbose"],
  );
});

test("buildInvocation preserves claude and agy chat/resume argv", async () => {
  const claude = await buildInvocation({
    cliId: "claude",
    cwd: process.cwd(),
    prompt: "hello",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    resumeConversationId: "claude-session",
    extraArgs: "--output-format stream-json --verbose",
  });
  assert.deepEqual(claude.args, ["-p", "--output-format", "json", "--verbose", "--resume", "claude-session", "hello"]);

  const agy = await buildInvocation({
    cliId: "agy",
    cwd: process.cwd(),
    prompt: "hello",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    resumeConversationId: "agy-session",
  });
  // `--print hello` last: agy's print flag needs its argument, and putting
  // `--output-format json` after it would be eaten as the prompt.
  assert.deepEqual(agy.args, [
    "--output-format",
    "json",
    "--conversation",
    "agy-session",
    "--print",
    "hello",
  ]);
  assert.equal(agy.stdinPrompt, undefined, "chat prompts go in argv, never on stdin");
});

test("structured chat keeps the prompt in argv even for an interactive chat run", async () => {
  // Regression: the chat panel starts runs with `interactive: true`, which used
  // to route the prompt to stdin — agy then died on "flag needs an argument"
  // and claude sat waiting on a pipe that never carried the task.
  const agy = await buildInvocation({
    cliId: "agy",
    cwd: process.cwd(),
    prompt: "hello",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    interactive: true,
  });
  assert.deepEqual(agy.args, ["--output-format", "json", "--print", "hello"]);
  assert.equal(agy.stdinPrompt, undefined);

  const claude = await buildInvocation({
    cliId: "claude",
    cwd: process.cwd(),
    prompt: "hello",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    interactive: true,
  });
  assert.deepEqual(claude.args, ["-p", "--output-format", "json", "hello"]);
  assert.equal(claude.stdinPrompt, undefined);
});

test("buildInvocation leaks no structured-chat args to an unsupported CLI", async () => {
  const invocation = await buildInvocation({
    cliId: "gemini",
    cwd: process.cwd(),
    prompt: "hello",
    commandOverride: "/bin/echo",
    uiMode: "chat",
  });
  assert.equal(invocation.args.includes("--output-format"), false);
  assert.equal(invocation.args.includes("--resume"), false);
});

test("codex resumes through its subcommand, not a resume flag", async () => {
  const fresh = await buildInvocation({
    cliId: "codex",
    cwd: process.cwd(),
    prompt: "remember BANANA42",
    commandOverride: "/bin/echo",
    uiMode: "chat",
  });
  assert.deepEqual(fresh.args, ["exec", "--json", "remember BANANA42"]);

  const resumed = await buildInvocation({
    cliId: "codex",
    cwd: process.cwd(),
    prompt: "what was it?",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    resumeConversationId: "019fe728-390f-76d3-a55d-0374721b8777",
  });
  // `codex exec resume <ID> <PROMPT>`: the id is a positional inside the
  // subcommand. A `--resume <id>` pair appended to `exec` is not valid argv, and
  // an extra copy of the id would be parsed as the prompt.
  assert.deepEqual(resumed.args, [
    "exec",
    "resume",
    "--json",
    "019fe728-390f-76d3-a55d-0374721b8777",
    "what was it?",
  ]);
  assert.equal(resumed.args.includes("--resume"), false);
  assert.equal(resumed.stdinPrompt, undefined);
});

test("codex drops resume-incompatible option flags on a resumed turn", async () => {
  const options = { sandbox: "workspace-write", profile: "work" };

  const fresh = await buildInvocation({
    cliId: "codex",
    cwd: process.cwd(),
    prompt: "first",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    options,
  });
  // Turn 1 goes through `codex exec`, which accepts both.
  assert.deepEqual(fresh.args, [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--profile",
    "work",
    "first",
  ]);

  const resumed = await buildInvocation({
    cliId: "codex",
    cwd: process.cwd(),
    prompt: "second",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    options,
    resumeConversationId: "thread-1",
  });
  // `codex exec resume` rejects them: `error: unexpected argument '--sandbox'`.
  // The flag *and* its value token must go — an orphaned `workspace-write`
  // becomes a positional and is read as the prompt.
  assert.deepEqual(resumed.args, ["exec", "resume", "--json", "thread-1", "second"]);

  // Extra args and auto-approve flags travel the same path.
  const withExtras = await buildInvocation({
    cliId: "codex",
    cwd: process.cwd(),
    prompt: "third",
    commandOverride: "/bin/echo",
    uiMode: "chat",
    extraArgs: "--sandbox danger-full-access --oss --strict-config",
    resumeConversationId: "thread-1",
  });
  assert.deepEqual(withExtras.args, ["exec", "resume", "--json", "thread-1", "--strict-config", "third"]);
});
