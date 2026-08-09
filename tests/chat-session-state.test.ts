import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStatus } from "../src/contracts/agent.ts";
import { chatRunIsLive, chatSendDisabled } from "../src/renderer/agents/chat-session-state.ts";

/**
 * The chat panel's live/composer derivation.
 *
 * Both bugs pinned here shipped together and had the same cause: `runtimes` is
 * empty until the profile is run at least once in this window, so `undefined`
 * was being read as "a run is in progress".
 */

test("a profile that has never run is not live", () => {
  // The state on every fresh app launch: no session, no runtime entry.
  assert.equal(chatRunIsLive({ hasSession: false, status: undefined }), false);
});

test("the Send button is reachable on a fresh launch", () => {
  // Regression: `live` was true for an unrun profile and structured chat
  // disables Send while live, so the composer was permanently dead — the user
  // could type but never send, with a "live" pill claiming the agent was busy.
  const disabled = chatSendDisabled({
    busy: false,
    hasCwd: true,
    live: chatRunIsLive({ hasSession: false, status: undefined }),
    draft: "review the auth module",
    structured: true,
  });
  assert.equal(disabled, false);
});

test("idle is a resting state, not a live run", () => {
  // `idle` is the store's default status and is reported by `sessions()` for
  // nothing that is actually executing.
  assert.equal(chatRunIsLive({ hasSession: false, status: "idle" }), false);
});

test("every settled status ends the run", () => {
  for (const status of ["completed", "failed", "stopped"] as AgentStatus[]) {
    assert.equal(chatRunIsLive({ hasSession: false, status }), false, status);
  }
});

test("working statuses are live even before sessions() lands", () => {
  // The window between `run:created` arriving over IPC and `refreshSessions()`
  // resolving is exactly why the status fallback exists.
  for (const status of ["queued", "planning", "coding", "testing", "waiting-approval"] as AgentStatus[]) {
    assert.equal(chatRunIsLive({ hasSession: false, status }), true, status);
  }
});

test("a listed session wins over a stale settled status", () => {
  // The main process still holds the child; a stale `completed` in the store
  // must not let the user fire a second turn into a running agent.
  assert.equal(chatRunIsLive({ hasSession: true, status: "completed" }), true);
});

test("structured chat requires text; an interactive CLI can start empty", () => {
  const base = { busy: false, hasCwd: true, live: false };
  assert.equal(
    chatSendDisabled({ ...base, draft: "   ", structured: true }),
    true,
    "a structured turn is one-shot argv, so an empty prompt has nothing to send",
  );
  assert.equal(
    chatSendDisabled({ ...base, draft: "   ", structured: false }),
    false,
    "an idle interactive session starts from the profile's own default prompt",
  );
  assert.equal(
    chatSendDisabled({ ...base, live: true, draft: "  ", structured: false }),
    true,
    "a live interactive session has nothing to forward without text",
  );
});

test("no working directory and an in-flight call both block sending", () => {
  assert.equal(
    chatSendDisabled({ busy: false, hasCwd: false, live: false, draft: "hi", structured: true }),
    true,
    "a run with no cwd has nowhere to execute",
  );
  assert.equal(
    chatSendDisabled({ busy: true, hasCwd: true, live: false, draft: "hi", structured: true }),
    true,
    "double-submitting while start() is in flight would spawn two runs",
  );
});
