export type AgentCliId =
  | "claude"
  | "kiro"
  | "codex"
  | "gemini"
  | "agy"
  | "grok"
  | "amazonq"
  | "aider"
  | "opencode"
  | "cursor"
  | "copilot"
  | "qwen"
  | "ollama"
  | "shell"
  | "custom";

export type AgentStatus =
  | "idle"
  | "queued"
  | "planning"
  | "moving"
  | "reading"
  | "coding"
  | "testing"
  | "reviewing"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "stopped";

export type AgentEventType =
  | "run:created"
  | "run:started"
  | "run:stdout"
  | "run:stderr"
  | "run:status"
  | "run:exit"
  | "run:error";

/** How the task prompt is handed to the CLI process. */
export type AgentPromptMode =
  /** Prompt appended as the last positional argument. */
  | "arg"
  /** Prompt passed through a flag, e.g. `-p "prompt"`. */
  | "flag"
  /** Prompt written to the process stdin after spawn. */
  | "stdin";

export interface AgentModelOption {
  id: string;
  label: string;
  note?: string;
  /** Marked by the catalog as the sensible default for the CLI. */
  recommended?: boolean;
}

export type AgentModelSource = "catalog" | "cli" | "custom";

export interface AgentModelProbe {
  cliId: AgentCliId;
  models: AgentModelOption[];
  source: AgentModelSource;
  detail: string;
  checkedAt: string;
}

/** Static description of a locally installable agent CLI. */
export interface AgentCliDescriptor {
  id: AgentCliId;
  displayName: string;
  vendor: string;
  description: string;
  /** UI accent colour token used by the renderer. */
  accent: string;
  docsUrl?: string;
  /** Binaries tried in order when resolving the CLI on PATH. */
  commandCandidates: string[];
  versionArgs: string[];
  /** Args placed before model/prompt args for one-shot runs. */
  baseArgs: string[];
  /** Args used when the session should stay interactive. */
  interactiveArgs: string[];
  modelFlag?: string;
  promptFlag?: string;
  promptMode: AgentPromptMode;
  supportsInteractive: boolean;
  supportsStdin: boolean;
  /** Optional args that make the CLI print its own model list. */
  modelListArgs?: string[];
  models: AgentModelOption[];
}

export interface AgentPingResult {
  cliId: AgentCliId;
  ok: boolean;
  installed: boolean;
  command?: string;
  version?: string;
  latencyMs: number;
  checkedAt: string;
  detail: string;
}

export interface AgentProfileStats {
  runs: number;
  completed: number;
  failed: number;
  running: number;
  successRate: number;
  totalMs: number;
  lastRunAt?: string;
  lastStatus?: AgentStatus;
}

export interface AgentProfileInput {
  id?: string;
  name: string;
  role: string;
  cliId: AgentCliId;
  model: string;
  providerConnectionId?: string;
  accent?: string;
  cwd?: string;
  systemPrompt?: string;
  extraArgs?: string;
  commandOverride?: string;
  promptMode?: AgentPromptMode;
  interactive?: boolean;
  forceTty?: boolean;
  autoApprove?: boolean;
  enabled?: boolean;
  tags?: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  cliId: AgentCliId;
  model: string;
  providerConnectionId?: string;
  accent: string;
  cwd?: string;
  systemPrompt?: string;
  extraArgs?: string;
  commandOverride?: string;
  promptMode?: AgentPromptMode;
  interactive: boolean;
  forceTty: boolean;
  autoApprove: boolean;
  enabled: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  stats: AgentProfileStats;
}

export interface AgentRunInput {
  cliId: AgentCliId;
  cwd: string;
  prompt: string;
  model?: string;
  shellCommand?: string;
  profileId?: string;
  taskId?: string;
  /** Keep the process alive so the terminal can keep sending input. */
  interactive?: boolean;
  /** Extra CLI args, parsed with shell-like quoting. */
  extraArgs?: string;
  /** Replace the resolved binary with an explicit command. */
  commandOverride?: string;
  promptMode?: AgentPromptMode;
  /** Wrap the process in a pseudo terminal when the platform supports it. */
  forceTty?: boolean;
}

export interface AgentRunRecord {
  id: string;
  cliId: AgentCliId;
  cwd: string;
  prompt: string;
  model?: string;
  profileId?: string;
  taskId?: string;
  status: AgentStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
}

export interface AgentProcess {
  runId: string;
  status: AgentStatus;
  pid?: number;
  command: string;
  args: string[];
  interactive: boolean;
}

export interface AgentSessionSummary {
  runId: string;
  cliId: AgentCliId;
  profileId?: string;
  model?: string;
  cwd: string;
  status: AgentStatus;
  pid?: number;
  interactive: boolean;
  startedAt: string;
  command: string;
}

export interface AgentEvent {
  runId: string;
  type: AgentEventType;
  status?: AgentStatus;
  message?: string;
  timestamp: string;
  profileId?: string;
  taskId?: string;
}

export interface AgentDefinition {
  id: AgentCliId;
  displayName: string;
  description: string;
  status: AgentStatus;
  model: string;
}
