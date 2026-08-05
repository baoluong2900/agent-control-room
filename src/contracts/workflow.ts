import type { AgentCliId } from "./agent";

/**
 * What an AI agent is asked to do inside a workflow step.
 * `investigate` covers research/triage work ("điều tra"), `analyze` covers
 * summarisation and reasoning passes, `execute` covers write/deploy actions.
 */
export type WorkflowStepKind =
  | "trigger"
  | "investigate"
  | "analyze"
  | "plan"
  | "review"
  | "execute"
  | "test"
  | "deploy"
  | "notify"
  | "approval";

export type WorkflowTriggerType =
  | "manual"
  | "schedule"
  | "git-push"
  | "file-change"
  | "issue-created"
  | "webhook";

export type WorkflowStatus = "active" | "paused" | "draft" | "error";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting-approval"
  | "success"
  | "failed"
  | "cancelled";

export interface WorkflowStepDefinition {
  id: string;
  order: number;
  /** Display name of the step, e.g. "Investigate", "Review", "Notify". */
  name: string;
  kind: WorkflowStepKind;
  /** Short human summary shown in the step breakdown list. */
  summary: string;
  /** Which local CLI agent runs this step. */
  cliId: AgentCliId;
  /**
   * Agent profile this step runs as. When set, the profile supplies the provider
   * connection, system prompt, options and CLI overrides, so a step behaves like
   * the same agent the user configured in the builder. `cliId`/`model` stay as
   * the fallback for steps that predate profiles or deliberately run bare.
   */
  profileId?: string;
  /** Provider connection override for this step, taking precedence over the profile's. */
  providerConnectionId?: string;
  /** Model label handed to the CLI (free text so any local model works). */
  model: string;
  /** The prompt template describing exactly what the agent must do. */
  instruction: string;
  /** Optional shell command used when cliId is "shell". */
  shellCommand?: string;
  timeoutSeconds: number;
  requiresApproval: boolean;
  continueOnError: boolean;
  enabled: boolean;
}

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  /** Cron-like or friendly schedule, e.g. "Daily, 9:00 AM". */
  schedule?: string;
  /** Extra context such as branch name, repo, or Jira project. */
  detail?: string;
}

/**
 * State of the local inbound webhook listener.
 *
 * The listener binds loopback only and requires `token` on every request, so this
 * is safe to show in the UI — but the token is a credential and should be treated
 * like one when copied.
 */
export interface WebhookEndpointStatus {
  running: boolean;
  port: number | null;
  /** POST target, minus the `/<hook-name>` segment. Null when not listening. */
  baseUrl: string | null;
  /** Present so the user can configure a sender; rotatable. */
  token: string | null;
  /** Why it is not running when a webhook workflow expects it to be. */
  error: string | null;
}

export interface WorkflowStats {
  runs: number;
  /** 0-100 */
  successRate: number;
  avgDurationMs: number;
  lastRunAt?: string | null;
  lastRunStatus?: WorkflowRunStatus | null;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  favorite: boolean;
  owner: string;
  /** Optional project binding: workflow steps run inside this folder. */
  projectPath?: string | null;
  trigger: WorkflowTrigger;
  steps: WorkflowStepDefinition[];
  /** Linked agents/integrations shown in the detail panel. */
  integrations: string[];
  createdAt: string;
  updatedAt: string;
  stats: WorkflowStats;
}

export interface WorkflowSaveInput {
  id?: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  favorite: boolean;
  owner: string;
  projectPath?: string | null;
  trigger: WorkflowTrigger;
  steps: Array<Omit<WorkflowStepDefinition, "id" | "order"> & { id?: string; order?: number }>;
  integrations: string[];
}

export interface WorkflowStepRunRecord {
  id: string;
  workflowRunId: string;
  stepId: string;
  order: number;
  name: string;
  kind: WorkflowStepKind;
  cliId: AgentCliId;
  status: WorkflowRunStatus;
  agentRunId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
  output?: string | null;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  triggeredBy: WorkflowTriggerType;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  steps: WorkflowStepRunRecord[];
}

export interface WorkflowMetrics {
  totalWorkflows: number;
  activeWorkflows: number;
  automatedRuns: number;
  /** 0-100 */
  successRate: number;
  totalDeltaPercent?: number;
  activeDeltaPercent?: number;
  runsDeltaPercent?: number;
  successDeltaPercent?: number;
}

export type WorkflowActivityKind = "completed" | "triggered" | "paused" | "processed" | "failed";

export interface WorkflowActivityEntry {
  id: string;
  workflowId: string;
  workflowName: string;
  kind: WorkflowActivityKind;
  headline: string;
  detail: string;
  at: string;
}

export type WorkflowEventType =
  | "workflow:run-queued"
  | "workflow:run-started"
  | "workflow:step-started"
  | "workflow:step-finished"
  | "workflow:log"
  | "workflow:run-finished";

export interface WorkflowEvent {
  type: WorkflowEventType;
  workflowId: string;
  workflowRunId: string;
  stepId?: string;
  stepName?: string;
  agentRunId?: string;
  status?: WorkflowRunStatus;
  message?: string;
  timestamp: string;
}

export interface WorkflowRunOptions {
  workflowId: string;
  /** Overrides the workflow project folder for this run. */
  cwd?: string;
  triggeredBy?: WorkflowTriggerType;
  /** Run a single step only (used by the step "Test step" action). */
  stepId?: string;
  /** Skip CLI spawning only when the caller explicitly asks for a dry run. */
  dryRun?: boolean;
}

export interface WorkflowExportResult {
  filePath: string;
  workflowId: string;
}

/** One finished step's output, used to build the next step's context. */
export interface WorkflowStepOutcome {
  stepId: string;
  name: string;
  kind: WorkflowStepKind;
  status: WorkflowRunStatus;
  output: string;
}

