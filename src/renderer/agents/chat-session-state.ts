/**
 * Whether an agent profile's chat run is still live, and what that implies for
 * the composer.
 *
 * Lives outside `AgentChatPanel` because getting it wrong makes the panel
 * unusable rather than merely ugly, and a pure function can be asserted directly
 * instead of through a rendered Electron window.
 *
 * The trap this module exists to close: `runtimes[profile.id]` is **undefined**
 * for every profile on a fresh app launch — the map is only written by
 * `runProfile`, `restartRun`, and `ingest`, none of which have run yet. A naive
 * "live unless the status is terminal" test reads `undefined` as live, so a
 * never-started agent claims to be answering and the Send button, which is
 * disabled while live, can never be pressed.
 */
import type { AgentStatus } from "@contracts";

/** Statuses that mean the run is over. `idle` is a resting state, not a run. */
const SETTLED_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "idle",
  "completed",
  "failed",
  "stopped",
]);

export interface ChatLiveInput {
  /** Whether the main process still lists a session for this run. */
  hasSession: boolean;
  /**
   * Last status seen for this profile, or undefined when the profile has not run
   * in this window yet. Undefined is **not** live: nothing has been started.
   */
  status?: AgentStatus;
}

/**
 * Live = the main process still has a session, or the last status we saw is a
 * working one.
 *
 * `hasSession` is checked first because it is the authoritative signal; the
 * status is the fallback for the window between a run exiting and
 * `refreshSessions()` landing, which is why the status test exists at all.
 */
export function chatRunIsLive({ hasSession, status }: ChatLiveInput): boolean {
  if (hasSession) return true;
  if (!status) return false;
  return !SETTLED_STATUSES.has(status);
}

export interface ChatComposerInput {
  /** A start/send call is in flight. */
  busy: boolean;
  /** A project folder is selected, so the run has a working directory. */
  hasCwd: boolean;
  live: boolean;
  draft: string;
  /**
   * Whether this CLI has a `structuredChat` capability. Structured chat is
   * one-shot per turn — the previous process has exited, so a turn always needs
   * text and can never be delivered to a running process's stdin.
   */
  structured: boolean;
}

/** Whether the send/start button should be disabled. */
export function chatSendDisabled({ busy, hasCwd, live, draft, structured }: ChatComposerInput): boolean {
  if (busy || !hasCwd) return true;
  if (structured) return live || !draft.trim();
  // A live interactive session needs text to forward; an idle one can be started
  // from the profile's own default prompt with an empty box.
  return live && !draft.trim();
}
