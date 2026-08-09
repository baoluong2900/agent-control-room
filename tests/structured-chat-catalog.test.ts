import assert from "node:assert/strict";
import test from "node:test";
import { getAgentDescriptor, listAgentCatalog } from "../src/main/agents/catalog.ts";
import { buildInvocation, structuredChatFor, usesStructuredChat } from "../src/main/agents/commands.ts";
import { extractConversationId } from "../src/main/processes/agent-process-manager.ts";
import {
  extractStructuredAssistantText,
  firstStructuredText,
} from "../src/renderer/agents/structured-chat-output.ts";

/**
 * Structured chat beyond claude and agy.
 *
 * The payloads below are **real captured stdout** from the CLIs installed on this
 * machine, trimmed only for length. That matters: a hand-written fixture proves
 * the parser matches my guess about the wire format, not the format itself.
 */

/** `grok --output-format json --single "…"` — one object for the whole run. */
const GROK_JSON = JSON.stringify({
  text: "PLUMBUS",
  stopReason: "EndTurn",
  sessionId: "019fe6d8-cc09-71d1-846b-aee37901dae9",
  requestId: "afeda980-cdb9-433d-b628-e1ab0e08e640",
  thought: "The user asked for the codeword.",
  usage: { input_tokens: 3728, output_tokens: 29 },
  num_turns: 1,
});

/** `opencode run --format json "…"` — JSONL, answer nested in the text event. */
const OPENCODE_JSONL = [
  JSON.stringify({
    type: "step_start",
    timestamp: 1786284312646,
    sessionID: "ses_01928b66affechxSAuD1HaJzNp",
    part: { id: "prt_1", messageID: "msg_1", type: "step-start" },
  }),
  JSON.stringify({
    type: "text",
    timestamp: 1786284312736,
    sessionID: "ses_01928b66affechxSAuD1HaJzNp",
    part: { id: "prt_2", messageID: "msg_1", type: "text", text: "PLUMBUS" },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: 1786284312806,
    sessionID: "ses_01928b66affechxSAuD1HaJzNp",
    part: { id: "prt_3", reason: "stop", type: "step-finish", tokens: { total: 9791 } },
  }),
].join("\n");

test("grok and opencode now declare a chat capability", () => {
  for (const cliId of ["claude", "agy", "grok", "opencode"] as const) {
    assert.ok(structuredChatFor(cliId), `${cliId} should declare structuredChat`);
    assert.equal(usesStructuredChat({ cliId, uiMode: "chat" }), true, `${cliId} chat should be enabled`);
  }
});

test("codex stays out until its resume subcommand is supported", () => {
  // `codex exec resume <id> <prompt>` is a subcommand, not a `<flag> <id>` pair,
  // so the current capability shape cannot express it. Declaring it anyway would
  // build argv that silently starts a fresh session every turn.
  assert.equal(structuredChatFor("codex"), undefined);
  assert.equal(usesStructuredChat({ cliId: "codex", uiMode: "chat" }), false);
});

test("shell can never be a chat target", () => {
  assert.equal(structuredChatFor("shell"), undefined);
  assert.equal(usesStructuredChat({ cliId: "shell", uiMode: "chat" }), false);
});

test("every declared chat capability is internally consistent", () => {
  for (const descriptor of listAgentCatalog()) {
    const chat = descriptor.structuredChat;
    if (!chat) continue;

    assert.ok(chat.args.length > 0, `${descriptor.id}: chat args must not be empty`);
    assert.ok(chat.resumeFlag.startsWith("-"), `${descriptor.id}: resumeFlag must be a flag`);
    if (chat.promptFlag) {
      assert.ok(
        chat.args.includes(chat.promptFlag),
        `${descriptor.id}: promptFlag ${chat.promptFlag} must appear in args so the builder can re-emit it last`,
      );
    }
    for (const field of chat.conversationIdFields ?? []) {
      assert.ok(field.trim(), `${descriptor.id}: conversation id fields must be non-empty`);
    }
  }
});

test("grok chat argv puts the prompt in --single, after the resume id", async () => {
  const invocation = await buildInvocation({
    cliId: "grok",
    cwd: process.cwd(),
    prompt: "What was the codeword?",
    uiMode: "chat",
    resumeConversationId: "019fe6d8-cc09-71d1-846b-aee37901dae9",
  });

  const args = invocation.args.join(" ");
  assert.match(args, /--output-format json/);
  assert.match(args, /--resume 019fe6d8-cc09-71d1-846b-aee37901dae9/);
  // `--single` consumes the next token, so the prompt must be its immediate
  // value and it must come after the resume pair — otherwise the resume flag
  // itself is read as the prompt.
  assert.match(args, /--single What was the codeword\?$/);
  assert.equal(invocation.stdinPrompt, undefined, "print-mode CLIs take the prompt in argv, never on stdin");
});

test("opencode chat argv keeps its run subcommand and resumes by session", async () => {
  const fresh = await buildInvocation({
    cliId: "opencode",
    cwd: process.cwd(),
    prompt: "hello",
    uiMode: "chat",
  });
  // `args` replaces `baseArgs`, so `run` has to survive or the TUI opens instead.
  assert.equal(fresh.args[0], "run", `expected run first, got ${JSON.stringify(fresh.args)}`);
  assert.match(fresh.args.join(" "), /--format json/);

  const resumed = await buildInvocation({
    cliId: "opencode",
    cwd: process.cwd(),
    prompt: "and now?",
    uiMode: "chat",
    resumeConversationId: "ses_01928b66affechxSAuD1HaJzNp",
  });
  assert.match(resumed.args.join(" "), /--session ses_01928b66affechxSAuD1HaJzNp/);
  assert.equal(resumed.args.at(-1), "and now?", "the prompt is a bare positional for opencode");
});

test("the conversation id is read from each CLI's own field", () => {
  const grokFields = getAgentDescriptor("grok").structuredChat?.conversationIdFields;
  assert.equal(
    extractConversationId(GROK_JSON, grokFields),
    "019fe6d8-cc09-71d1-846b-aee37901dae9",
    "grok names it sessionId",
  );

  const opencodeFields = getAgentDescriptor("opencode").structuredChat?.conversationIdFields;
  assert.equal(
    extractConversationId(OPENCODE_JSONL, opencodeFields),
    "ses_01928b66affechxSAuD1HaJzNp",
    "opencode names it sessionID and repeats it on every JSONL line",
  );

  // The generic default still covers claude/agy, which use snake_case.
  assert.equal(extractConversationId(JSON.stringify({ session_id: "abc" })), "abc");
  assert.equal(extractConversationId(JSON.stringify({ conversation_id: "def" })), "def");
  // A field this CLI does not use must not be picked up by accident.
  assert.equal(extractConversationId(GROK_JSON, ["conversation_id"]), undefined);
});

test("the answer is extracted from every real payload shape", () => {
  assert.equal(extractStructuredAssistantText(GROK_JSON), "PLUMBUS", "grok answers in `text`");
  assert.equal(
    extractStructuredAssistantText(OPENCODE_JSONL),
    "PLUMBUS",
    "opencode answers in the text event's part.text, among bookkeeping events",
  );
  assert.equal(extractStructuredAssistantText(JSON.stringify({ result: "claude answer" })), "claude answer");
  assert.equal(extractStructuredAssistantText(JSON.stringify({ response: "agy answer" })), "agy answer");
});

test("grok's `thought` never displaces its `text` answer", () => {
  // Both keys hold prose. Returning the reasoning trace instead of the reply
  // would look plausible in the panel and be wrong every time.
  const answer = extractStructuredAssistantText(GROK_JSON);
  assert.equal(answer, "PLUMBUS");
  assert.ok(!answer?.includes("codeword"), "the thought field must not leak into the message");
});

test("bookkeeping-only output yields null so the raw text is shown instead", () => {
  const noAnswer = [
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish" } }),
  ].join("\n");

  assert.equal(extractStructuredAssistantText(noAnswer), null);
  // Plain text and error dumps must fall through rather than render empty.
  assert.equal(extractStructuredAssistantText("Error: not logged in"), null);
  assert.equal(extractStructuredAssistantText(""), null);
  assert.equal(extractStructuredAssistantText("   "), null);
});

test("a reply streamed across several events is joined in order", () => {
  const streamed = [
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "first" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "second" } }),
    // A repeated identical event must not double up in the transcript.
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "second" } }),
    "{ truncated partial line",
  ].join("\n");

  assert.equal(extractStructuredAssistantText(streamed), "first\n\nsecond");
});

test("accumulated JSONL snapshots replace their shorter prefix", () => {
  const snapshots = [
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hel" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello world" } }),
    // A shorter replay is ignored; it cannot replace the completed snapshot.
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello" } }),
  ].join("\n");

  assert.equal(extractStructuredAssistantText(snapshots), "Hello world");
});

test("firstStructuredText prefers the answer over envelope metadata", () => {
  // A wrapper carrying both its own `message` and the real `result` must not
  // report the wrapper's field.
  assert.equal(firstStructuredText({ message: "wrapper note", result: "real answer" }), "real answer");
  assert.equal(firstStructuredText({ role: "assistant", content: "assistant text" }), "assistant text");
  assert.equal(firstStructuredText(["a", "b"]), "a\n\nb");
  assert.equal(firstStructuredText(null), null);
  assert.equal(firstStructuredText(42), null);
  assert.equal(firstStructuredText({ text: "   " }), null, "whitespace is not an answer");
});
