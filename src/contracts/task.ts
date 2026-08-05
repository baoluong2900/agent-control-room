import type { AgentCliId } from "./agent";

/**
 * `blocked` and `failed` both mean "not progressing", but they need different
 * actions: `blocked` is a missing precondition the user must fix (no project
 * folder, no CLI on PATH), `failed` is a run that was attempted and lost. Only
 * `failed` participates in the retry policy.
 */
export type TaskStatus = "open" | "investigating" | "blocked" | "failed" | "done";

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
}

export interface TaskPlanSummary {
  difficulty: TaskDifficulty;
  estimatedMinutes: number;
  agentCount: number;
  subtaskCount: number;
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
