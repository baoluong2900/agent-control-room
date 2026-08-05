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

  const firstOut = events
    .filter((e) => e.runId === first.runId && (e.type === "run:stdout" || e.type === "run:stderr"))
    .map((e) => e.message)
    .join("");
  check("turn 1 produced output", firstOut.trim().length > 0, firstOut.trim().slice(0, 120));
  check("turn 1 output is JSON", firstOut.trim().startsWith("{"), firstOut.trim().slice(0, 60));
  check("turn 1 answered the prompt", firstOut.includes("BANANA42"), firstOut.trim().slice(0, 120));

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

  const secondOut = events
    .filter((e) => e.runId === second.runId && (e.type === "run:stdout" || e.type === "run:stderr"))
    .map((e) => e.message)
    .join("");
  check("turn 2 remembered turn 1 (chat history really resumes)", secondOut.includes("BANANA42"), secondOut.trim().slice(0, 160));

  db.close();
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
