import { createMachine } from "xstate";
import type { AgentStatus } from "@contracts";

export const animationMap: Record<AgentStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  planning: "Thinking",
  moving: "Walking",
  reading: "Reading",
  coding: "Typing",
  testing: "Testing",
  reviewing: "Reviewing",
  "waiting-approval": "Waiting",
  completed: "Celebrate",
  failed: "Error",
  stopped: "Stopped",
};

export const agentLifecycleMachine = createMachine({
  id: "agentLifecycle",
  initial: "idle",
  states: {
    idle: { on: { QUEUE: "queued" } },
    queued: { on: { START: "planning", STOP: "stopped", FAIL: "failed" } },
    planning: { on: { READ: "reading", CODE: "coding", TEST: "testing", STOP: "stopped", FAIL: "failed" } },
    reading: { on: { CODE: "coding", TEST: "testing", REVIEW: "reviewing", STOP: "stopped", FAIL: "failed" } },
    coding: { on: { TEST: "testing", REVIEW: "reviewing", STOP: "stopped", FAIL: "failed" } },
    testing: { on: { REVIEW: "reviewing", COMPLETE: "completed", STOP: "stopped", FAIL: "failed" } },
    reviewing: { on: { COMPLETE: "completed", STOP: "stopped", FAIL: "failed" } },
    "waiting-approval": { on: { APPROVE: "coding", STOP: "stopped", FAIL: "failed" } },
    completed: { type: "final" },
    failed: { type: "final" },
    stopped: { type: "final" },
  },
});

