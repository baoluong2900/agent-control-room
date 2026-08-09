import assert from "node:assert/strict";
import test from "node:test";
import { useAgentsStore, type TerminalChunk } from "../src/renderer/stores/agents-store.ts";

/**
 * Clearing a chat transcript.
 *
 * The chat panel renders `chatThreads[profileId]`, but its Clear button used to
 * call `clearTerminal(runId)` — which empties the run-keyed `terminals` map. So
 * Clear wiped the terminal view the user was not looking at and left every chat
 * bubble on screen. The two maps exist for different reasons and are keyed
 * differently, which is what made the mix-up invisible in review: both calls
 * typecheck and both clear *something*.
 */

function chunk(message: string): TerminalChunk {
  return { id: `c-${message}`, stream: "stdout", message, timestamp: "2026-08-09T18:00:00.000Z" };
}

function seed(): void {
  useAgentsStore.setState({
    runtimes: {
      "profile-a": { runId: "run-a", status: "completed", startedAt: "2026-08-09T18:00:00.000Z" },
      "profile-b": { runId: "run-b", status: "completed", startedAt: "2026-08-09T18:00:00.000Z" },
    },
    chatThreads: { "profile-a": [chunk("turn one"), chunk("turn two")], "profile-b": [chunk("other agent")] },
    terminals: { "run-a": [chunk("turn one")], "run-b": [chunk("other agent")] },
  });
}

test("clearing a chat thread empties the bubbles the panel actually renders", () => {
  seed();
  useAgentsStore.getState().clearChatThread("profile-a");
  assert.deepEqual(useAgentsStore.getState().chatThreads["profile-a"], []);
});

test("clearing also empties the run's terminal, which the same panel can open", () => {
  seed();
  useAgentsStore.getState().clearChatThread("profile-a");
  assert.deepEqual(useAgentsStore.getState().terminals["run-a"], []);
});

test("clearing one agent's chat leaves other agents untouched", () => {
  seed();
  useAgentsStore.getState().clearChatThread("profile-a");
  const state = useAgentsStore.getState();
  assert.equal(state.chatThreads["profile-b"]?.length, 1, "a second open chat panel must keep its transcript");
  assert.equal(state.terminals["run-b"]?.length, 1);
});

test("clearing a profile that never ran does not throw or invent a terminal", () => {
  // No `runtimes` entry means no runId to key the terminals map with — the
  // spread must be skipped rather than writing `terminals[undefined]`.
  seed();
  useAgentsStore.getState().clearChatThread("profile-never-run");
  const state = useAgentsStore.getState();
  assert.deepEqual(state.chatThreads["profile-never-run"], []);
  assert.deepEqual(Object.keys(state.terminals).sort(), ["run-a", "run-b"]);
});
