/**
 * Retry policy for scheduled tasks.
 *
 * Before this existed, a task whose run failed *before* the database recorded a
 * run — a CLI missing from PATH, for instance — stayed `open` with a `due_at` in
 * the past, so every 30-second tick spawned it again, forever. The policy here
 * gives each failure an attempt number, a backoff, and a terminal state.
 */

/** Attempts a task gets before it is parked in `failed`. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** First backoff step; each further attempt doubles it. */
export const BASE_BACKOFF_MS = 60_000;

/** Ceiling for the doubling, so a long-lived task never waits hours. */
export const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * A stalled run is only killed when the agent has produced nothing for this
 * long. Elapsed time alone is the wrong signal: a large refactor legitimately
 * runs for hours while still writing output.
 */
export const STALL_SILENCE_MS = 15 * 60_000;

/** Hard ceiling on a single run regardless of output, as a last-resort guard. */
export const MAX_RUN_MS = 6 * 60 * 60_000;

export type FailureKind = "permanent" | "transient";

/**
 * Splits "certainly hopeless" from "possibly temporary". Perfect classification
 * is not the goal — retrying a missing binary 3 times only wastes ticks, and
 * treating a transient spawn error as permanent loses work.
 */
export function classifyFailure(message: string): FailureKind {
  const text = message.toLowerCase();
  const permanentSignals = [
    "enoent",
    "not found",
    "no such file",
    "is not installed",
    "is not recognized",
    "command not found",
    "permission denied",
    "eacces",
    "unsupported",
    "missing a project folder",
  ];
  return permanentSignals.some((signal) => text.includes(signal)) ? "permanent" : "transient";
}

/**
 * Exponential backoff with a small deterministic-per-attempt jitter, so a batch
 * of tasks that failed in the same tick does not come back in the same tick.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(1, attempt);
  const raw = BASE_BACKOFF_MS * 2 ** (step - 1);
  const capped = Math.min(MAX_BACKOFF_MS, raw);
  const jitter = Math.round(capped * 0.1 * random());
  return capped + jitter;
}

export type RetryDecision = {
  attemptCount: number;
  status: "open" | "failed";
  nextRetryAt: string | null;
  lastError: string;
};

/**
 * Decides what a failed attempt does to the task row.
 *
 * A permanent failure burns the whole attempt budget at once: the hundredth try
 * will find the binary just as missing as the first, and leaving attempts on the
 * clock only delays the user seeing a real error.
 */
export function planRetry(input: {
  attemptCount: number;
  maxAttempts: number;
  message: string;
  now?: Date;
  random?: () => number;
}): RetryDecision {
  const now = input.now ?? new Date();
  const maxAttempts = Math.max(1, input.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const kind = classifyFailure(input.message);
  const attemptCount =
    kind === "permanent" ? maxAttempts : Math.min(maxAttempts, Math.max(0, input.attemptCount) + 1);

  if (attemptCount >= maxAttempts) {
    return { attemptCount, status: "failed", nextRetryAt: null, lastError: input.message };
  }

  const delay = backoffMs(attemptCount, input.random);
  return {
    attemptCount,
    status: "open",
    nextRetryAt: new Date(now.getTime() + delay).toISOString(),
    lastError: input.message,
  };
}

/**
 * Whether a run that is still `investigating` should be treated as hung.
 * `lastOutputAt` falls back to the start instant when the agent never wrote a
 * line, which is exactly the case a silence window is meant to catch.
 */
export function isStalled(input: {
  startedAt: string | null | undefined;
  lastOutputAt: string | null | undefined;
  now?: Date;
  silenceMs?: number;
  maxRunMs?: number;
}): boolean {
  const now = (input.now ?? new Date()).getTime();
  const startedAt = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return false;

  if (now - startedAt >= (input.maxRunMs ?? MAX_RUN_MS)) return true;

  const lastOutput = input.lastOutputAt ? Date.parse(input.lastOutputAt) : Number.NaN;
  const reference = Number.isFinite(lastOutput) ? lastOutput : startedAt;
  return now - reference >= (input.silenceMs ?? STALL_SILENCE_MS);
}
