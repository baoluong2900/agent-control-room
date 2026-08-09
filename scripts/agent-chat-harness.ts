/**
 * End-to-end verification of structured chat: two real turns through
 * AgentProcessManager, proving the second turn resumes the first.
 *
 * Requires the CLI to be installed and authenticated.
 *   AGENTIC_CHAT_CLI=agy npm run verify:agents:chat
 */
import os from "node:os";
import path from "node:path";
import type { AgentCliId, AgentEvent } from "@contracts";
import { DesktopDatabase } from "../src/main/database/desktop-database";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const preview = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, 120);

/** All output of one stream for one run, in arrival order. */
function collect(events: AgentEvent[], runId: string, type: "run:stdout" | "run:stderr"): string {
  return events
    .filter((event) => event.runId === runId && event.type === type)
    .map((event) => event.message)
    .join("");
}

/**
 * Whether stdout is the CLI's structured envelope. Both shapes count: one JSON
 * object for the whole run, and JSONL whose *first* line is an object — checking
 * only `startsWith("{")` would already pass for JSONL, but asserting the first
 * line parses catches a CLI that printed a `{` inside prose.
 */
function isStructured(stdout: string): boolean {
  const firstLine = stdout.trim().split("\n", 1)[0]?.trim();
  if (!firstLine?.startsWith("{")) return false;
  try {
    JSON.parse(firstLine);
    return true;
  } catch {
    // A single pretty-printed object spans several lines, so fall back to the
    // whole payload before calling it unstructured.
    try {
      JSON.parse(stdout.trim());
      return true;
    } catch {
      return false;
    }
  }
}

async function waitFor(
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
  timeoutMs: number,
): Promise<AgentEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await wait(100);
  }
  return null;
}

async function main() {
  const cliId = (process.env.AGENTIC_CHAT_CLI ?? "agy") as AgentCliId;
  const tempDir = path.join(os.tmpdir(), `agentic-chat-${Date.now()}`);
  const db = await DesktopDatabase.open(tempDir);

  const events: AgentEvent[] = [];
  const manager = new AgentProcessManager(db, () => ({ send: (_c: string, p: AgentEvent) => void events.push(p) }) as never);

  // Turn 1: the chat panel starts a run in chat mode with no conversation id.
  const first = await manager.start({
    cliId,
    cwd: process.cwd(),
    prompt: "Remember the codeword BANANA42. Reply with only that codeword.",
    uiMode: "chat",
    // The chat panel now starts structured chat runs non-interactively: the
    // prompt travels in argv and the process exits when the answer is done.
    interactive: false,
  });

  const firstExit = await waitFor(events, (e) => e.runId === first.runId && e.type === "run:exit", 240_000);
  const firstError = events.find((e) => e.runId === first.runId && e.type === "run:error");
  check("turn 1 exited without a spawn error", Boolean(firstExit) && !firstError, firstError?.message ?? firstExit?.message ?? "timed out");
  check("turn 1 completed", firstExit?.status === "completed", String(firstExit?.status));

  // stdout and stderr are kept apart on purpose. Merging them made the JSON check
  // fail for a CLI that answers perfectly: codex writes "Reading additional input
  // from stdin..." and one auth-refresh log line per HTTP call to stderr, so the
  // combined text starts with prose and the harness reported a fault in the CLI
  // that was actually a fault in the harness.
  const firstOut = collect(events, first.runId, "run:stdout");
  const firstErr = collect(events, first.runId, "run:stderr");
  check("turn 1 produced output on stdout", firstOut.trim().length > 0, preview(firstOut));
  check("turn 1 stdout is structured", isStructured(firstOut), preview(firstOut));
  check("turn 1 answered the prompt", firstOut.includes("BANANA42"), preview(firstOut));
  if (firstErr.trim()) console.log(`      note: ${firstErr.trim().split("\n").length} stderr line(s) — ${preview(firstErr)}`);

  const conversationId = firstExit?.conversationId ?? db.getAgentRun(first.runId)?.conversationId;
  check("conversation id captured for resume", Boolean(conversationId), conversationId ?? "none");
  if (!conversationId) {
    db.close();
    console.log(`\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }

  // Turn 2: the same profile sends a follow-up, resumed by conversation id.
  const second = await manager.start({
    cliId,
    cwd: process.cwd(),
    prompt: "What was the codeword? Reply with only the codeword.",
    uiMode: "chat",
    interactive: false,
    resumeConversationId: conversationId,
  });

  const secondExit = await waitFor(events, (e) => e.runId === second.runId && e.type === "run:exit", 240_000);
  check("turn 2 completed", secondExit?.status === "completed", String(secondExit?.status));

  const secondOut = collect(events, second.runId, "run:stdout");
  check(
    "turn 2 remembered turn 1 (chat history really resumes)",
    secondOut.includes("BANANA42"),
    preview(secondOut),
  );
  // The codeword has to come back on *stdout*, from the answer itself. Accepting
  // stderr here would let an error message that happens to echo the prompt pass
  // as proof that the conversation resumed.
  const secondErr = collect(events, second.runId, "run:stderr");
  if (secondErr.trim()) console.log(`      note: ${secondErr.trim().split("\n").length} stderr line(s) on turn 2`);

  db.close();
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
