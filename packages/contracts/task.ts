import type { AgentCliId } from "./agent";

export type TaskStatus = "open" | "investigating" | "blocked" | "done";

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
