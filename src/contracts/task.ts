import type { AgentCliId } from "./agent";

/**
 * `blocked` and `failed` both mean "not progressing", but they need different
 * actions: `blocked` is a missing precondition the user must fix (no project
 * folder, no CLI on PATH), `failed` is a run that was attempted and lost. Only
 * `failed` participates in the retry policy.
 *
 * `queued` and `investigating` are distinct for the same reason.
 * `AgentProcessManager` admits three concurrent runs and queues the rest, so a
 * scheduled task can be accepted minutes before a child process exists. Reporting
 * that as `investigating` claimed work that had not started: the card showed an
 * agent thinking, the terminal was empty, and the stall sweeper had to special-case
 * it to avoid reaping a run that was merely waiting its turn.
 */
export type TaskStatus = "open" | "queued" | "investigating" | "blocked" | "failed" | "done";

export type TaskDifficulty = "small" | "medium" | "large" | "epic";

export interface TaskRecord {
  id: string;
  /** Stored as a project path so tasks survive project id regeneration. */
  projectPath?: string | null;
  parentTaskId?: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
  assignedCliId?: AgentCliId | null;
  assignedModel?: string | null;
  dueAt?: string | null;
  difficulty?: TaskDifficulty | null;
  estimatedMinutes?: number | null;
  automationEnabled: boolean;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  runCount: number;
  /** Retry attempts consumed since the last success or manual reset. */
  attemptCount: number;
  /** Attempts allowed before the task is parked in `failed`. */
  maxAttempts: number;
  /** ISO instant before which the scheduler must not pick the task up again. */
  nextRetryAt?: string | null;
  /** Why the last attempt failed, shown on the task card. */
  lastError?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

export interface TaskSaveInput {
  id?: string;
  projectPath?: string | null;
  parentTaskId?: string | null;
  title: string;
  prompt: string;
  status?: TaskStatus;
  assignedCliId?: AgentCliId | null;
  assignedModel?: string | null;
  dueAt?: string | null;
  difficulty?: TaskDifficulty | null;
  estimatedMinutes?: number | null;
  automationEnabled?: boolean;
  /** Overrides the default attempt budget for this task. */
  maxAttempts?: number | null;
}

export interface TaskPlanInput {
  projectPath?: string | null;
  title?: string;
  request: string;
  dueAt?: string | null;
  preferredCliId?: AgentCliId | null;
  model?: string | null;
  automationEnabled?: boolean;
  /**
   * CLIs known to be installed on this machine. When provided, the planner only
   * assigns steps to these; when omitted it keeps its historical preferences, so
   * existing callers and tests are unaffected.
   */
  availableCliIds?: AgentCliId[];
  /**
   * `heuristic` (default) is the instant, deterministic, offline template plan.
   * `ai` spends an agent call to plan against the indexed project, and falls back
   * to the template whenever that fails for any reason.
   */
  mode?: "heuristic" | "ai";
}

export interface TaskPlanSummary {
  difficulty: TaskDifficulty;
  estimatedMinutes: number;
  agentCount: number;
  subtaskCount: number;
  /**
   * How the plan was produced. `template` is the deterministic length/keyword
   * heuristic — named so the UI can stop implying the plan analysed the codebase.
   * `ai` means an agent CLI produced the steps and they passed validation.
   */
  source?: "template" | "ai";
  /**
   * Why an `ai` request ended up returning a template plan. Always set when the
   * caller asked for AI and did not get it, so the failure is visible instead of
   * looking like the model simply wrote a generic plan.
   */
  fallbackReason?: string;
  /**
   * Set when no agent CLI is installed. The plan still exists (every step falls
   * back to `shell`) but the UI has to say so rather than presenting steps that
   * cannot run.
   */
  noAgentsAvailable?: boolean;
  /**
   * Steps whose intended CLI was missing and were reassigned, as
   * `Investigate: kiro -> codex`. Surfaced so a plan that quietly changed shape is
   * explainable.
   */
  reassignedSteps?: string[];
}

export interface TaskPlanResult {
  parent: TaskRecord;
  subtasks: TaskRecord[];
  summary: TaskPlanSummary;
}

export interface TaskScheduleTickResult {
  started: TaskRecord[];
  failed: Array<{
    taskId: string;
    title: string;
    message: string;
  }>;
}

export type TaskEventType = "task:started" | "task:blocked" | "task:failed";

/** Emitted by the scheduler so the Tasks page can show automation progress live. */
export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  title: string;
  /** Agent run spawned for this task, when one was started. */
  runId?: string;
  message: string;
  timestamp: string;
}
