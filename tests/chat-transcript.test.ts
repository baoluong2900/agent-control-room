import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatMessages,
  type TranscriptChunk,
} from "../src/renderer/agents/chat-transcript.ts";

/**
 * How a chat run's raw chunks become bubbles.
 *
 * The stderr payloads below are **real captured output** from `codex exec --json`
 * on this machine (2026-08-09). codex answers correctly on stdout while writing
 * a startup notice and one auth-refresh log line per HTTP call to stderr — a
 * dozen or more per turn. Rendering each as its own message pushed the actual
 * reply off the visible transcript, which is what this behaviour exists to stop.
 */

const CODEX_STDERR_NOISE = [
  "Reading additional input from stdin...",
  "2026-08-09T15:48:28.657152Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.",
  "2026-08-09T15:48:28.660100Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.",
];

const CODEX_ANSWER = [
  JSON.stringify({ type: "thread.started", thread_id: "019fe736-1397-79b1-adfa-13852986a87f" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "BANANA42" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12792, output_tokens: 20 } }),
].join("\n");

function chunk(stream: TranscriptChunk["stream"], message: string, seconds: number): TranscriptChunk {
  return {
    id: `${stream}-${seconds}`,
    stream,
    message,
    timestamp: new Date(Date.UTC(2026, 7, 9, 15, 48, seconds)).toISOString(),
  };
}

test("a structured chat answer is not buried under the CLI's stderr logs", () => {
  const chunks: TranscriptChunk[] = [
    chunk("stdin", "Remember the codeword BANANA42.", 1),
    ...CODEX_STDERR_NOISE.map((line, index) => chunk("stderr", `${line}\n`, 2 + index)),
    chunk("stdout", CODEX_ANSWER, 6),
  ];

  const messages = buildChatMessages(chunks, true);
  assert.deepEqual(
    messages.map((message) => [message.stream, message.text]),
    [
      ["stdin", "Remember the codeword BANANA42."],
      ["stdout", "BANANA42"],
    ],
    "the transcript should be the prompt and the answer, nothing else",
  );
});

test("the same chunks keep their stderr when the CLI has no chat capability", () => {
  // A terminal-mode CLI has no structured answer to protect, so suppressing its
  // stderr would only hide output the user came to read.
  const chunks: TranscriptChunk[] = [
    chunk("stderr", "warning: something happened\n", 1),
    chunk("stdout", "plain text answer\n", 2),
  ];

  const messages = buildChatMessages(chunks, false);
  assert.deepEqual(
    messages.map((message) => message.stream),
    ["stderr", "stdout"],
  );
});

test("stderr is surfaced when the run produced no answer at all", () => {
  // The failure case: suppressing the only output would leave a silent empty
  // panel with no clue why the agent said nothing.
  const messages = buildChatMessages(
    [chunk("stderr", "Error: not logged in\n", 1), chunk("event", "Process exited with code 1", 2)],
    true,
  );

  assert.deepEqual(
    messages.map((message) => [message.stream, message.text]),
    [
      ["event", "Process exited with code 1"],
      ["stderr", "Error: not logged in"],
    ],
    "held diagnostics are released after the events, since nothing answered",
  );
});

test("whitespace-only stdout does not count as an answer", () => {
  // `answered` must track *rendered* text, not merely the presence of a stdout
  // chunk: a CLI that emits a stray newline before dying would otherwise
  // suppress the diagnostics that explain the death.
  const messages = buildChatMessages(
    [chunk("stdout", "   \n", 1), chunk("stderr", "Error: auth expired\n", 2)],
    true,
  );

  assert.deepEqual(
    messages.map((message) => [message.stream, message.text]),
    [["stderr", "Error: auth expired"]],
  );
});

test("consecutive stdout chunks are coalesced before parsing", () => {
  // The JSON arrives split across pipe reads; parsing each fragment alone would
  // fail and fall back to showing raw JSON to the user.
  const half = Math.floor(CODEX_ANSWER.length / 2);
  const messages = buildChatMessages(
    [chunk("stdout", CODEX_ANSWER.slice(0, half), 1), chunk("stdout", CODEX_ANSWER.slice(half), 2)],
    true,
  );

  assert.deepEqual(
    messages.map((message) => message.text),
    ["BANANA42"],
  );
});

test("ansi escapes are stripped and paragraphs split into separate bubbles", () => {
  const messages = buildChatMessages(
    [chunk("stdout", "\u001B[32mfirst paragraph\u001B[0m\n\nsecond paragraph\n", 1)],
    true,
  );

  assert.deepEqual(
    messages.map((message) => message.text),
    ["first paragraph", "second paragraph"],
  );
});
