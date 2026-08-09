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

export type AgentModuleId =
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "research"
  | "ops"
  | "builder"
  | "security"
  | "local"
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
  | "run:stdin"
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

/** Control the renderer draws for a declared CLI option. */
export type AgentOptionKind =
  /** One value out of `choices`, emitted as `--flag value`. */
  | "select"
  /** On/off. Emits `--flag` alone when `valueless`, otherwise `--flag true`. */
  | "toggle"
  /** Free text, emitted as `--flag value` when non-empty. */
  | "text"
  /** Newline/comma separated entries, emitted once per entry when `repeatable`. */
  | "list";

export interface AgentOptionChoice {
  value: string;
  label: string;
  note?: string;
}

/**
 * One configurable flag of a CLI, declared by the catalog and rendered as a real
 * control in the agent builder instead of forcing the user to hand-type it into
 * "Extra CLI args".
 */
export interface AgentCliOption {
  /** Stable key the profile and run input store the value under. */
  id: string;
  label: string;
  kind: AgentOptionKind;
  /** Flag emitted before the value, e.g. `--effort`. */
  flag: string;
  hint?: string;
  /** `select`: the allowed values, in display order. */
  choices?: AgentOptionChoice[];
  placeholder?: string;
  /** Applied when the profile has not chosen a value. */
  defaultValue?: AgentOptionValue;
  /** `toggle`: emit the flag on its own, with no value argument. */
  valueless?: boolean;
  /** `list`: repeat the flag per entry (`--add-dir a --add-dir b`). */
  repeatable?: boolean;
  /** Emit `--flag=value` rather than `--flag value`. */
  joinWithEquals?: boolean;
  /** Only emitted for one kind of run; defaults to both. */
  appliesTo?: "both" | "interactive" | "oneshot";
  /** Kept behind the advanced disclosure in the builder. */
  advanced?: boolean;
}

export type AgentOptionValue = string | boolean | string[];

/** Values chosen for a descriptor's `options`, keyed by `AgentCliOption.id`. */
export type AgentOptionValues = Record<string, AgentOptionValue>;

export type AgentModelSource = "catalog" | "cli" | "custom";

export interface AgentModelProbe {
  cliId: AgentCliId;
  models: AgentModelOption[];
  source: AgentModelSource;
  detail: string;
  checkedAt: string;
}

/**
 * How a CLI is driven in structured chat mode, when it supports one.
 *
 * Deliberately plain data with no functions: the whole catalog crosses the
 * contextBridge via `agent:catalog`, and a function on a descriptor would either
 * vanish or throw on the way to the renderer.
 */
export interface AgentStructuredChat {
  /** Args that replace `baseArgs` for a chat run, e.g. `-p --output-format json`. */
  args: string[];
  /**
   * Flag that resumes an existing conversation; the id is appended after it.
   * Mutually exclusive with `resumeArgs` — a capability declares exactly one.
   */
  resumeFlag?: string;
  /**
   * Argv that replaces `args` entirely on a resumed turn, for CLIs where resume
   * is a **subcommand** rather than a flag: `codex exec resume <ID> <PROMPT>`
   * cannot be expressed as `<flag> <id>` appended to the fresh-turn args.
   *
   * The literal token `{id}` is substituted with the conversation id. Declaring
   * `resumeFlag` for such a CLI would build argv that silently starts a brand
   * new session on every turn, which looks like an agent with amnesia.
   */
  resumeArgs?: string[];
  /**
   * Flags the resume path does not accept, stripped from option/extra argv when
   * resuming. `codex exec` takes `--sandbox`/`--add-dir`/`--profile`/`--oss`;
   * `codex exec resume` rejects them outright with `unexpected argument`, so a
   * profile carrying one would work on turn 1 and fail on turn 2.
   */
  resumeDropsFlags?: string[];
  /**
   * Flag whose value is the prompt, for CLIs whose print flag requires its
   * argument (agy's `--print` errors with "flag needs an argument" otherwise).
   * When set the prompt is emitted as `<flag> <prompt>` at the end of argv;
   * when absent the prompt is appended as a bare positional.
   */
  promptFlag?: string;
  /** JSON keys carrying the conversation id, tried in order. */
  conversationIdFields?: string[];
  /** `json` = one object for the whole run, `jsonl` = one object per line. */
  outputFormat?: "json" | "jsonl";
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
  /**
   * Flag that skips tool-permission prompts, emitted when the profile has
   * `autoApprove`. CLIs without one leave this undefined and the toggle is
   * hidden rather than silently ignored.
   */
  autoApproveArgs?: string[];
  /** Flag that carries a system prompt, e.g. `--append-system-prompt`. */
  systemPromptFlag?: string;
  /** Declarative flag surface rendered as real controls in the builder. */
  options?: AgentCliOption[];
  /** Optional args that make the CLI print its own model list. */
  modelListArgs?: string[];
  /**
   * Present only on CLIs that can hold a structured conversation. Its absence is
   * what makes `uiMode: "chat"` unavailable, so adding a third chat-capable CLI
   * is a catalog entry rather than a change to the argv builder.
   */
  structuredChat?: AgentStructuredChat;
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
  module?: AgentModuleId;
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
  /** Values for the CLI descriptor's declared `options`. */
  options?: AgentOptionValues;
  enabled?: boolean;
  tags?: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  cliId: AgentCliId;
  module?: AgentModuleId;
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
  /** Values for the CLI descriptor's declared `options`. */
  options: AgentOptionValues;
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
  /** Selects whether the run is meant for terminal passthrough or chat bubbles. */
  uiMode?: "terminal" | "chat";
  /** Provider-native chat id used to resume a previous structured chat. */
  resumeConversationId?: string;
  /** Provider connection whose local auth/secret should be exposed to the CLI. */
  providerConnectionId?: string;
  /** Extra CLI args, parsed with shell-like quoting. */
  extraArgs?: string;
  /** Replace the resolved binary with an explicit command. */
  commandOverride?: string;
  promptMode?: AgentPromptMode;
  /** Wrap the process in a pseudo terminal when the platform supports it. */
  forceTty?: boolean;
  /** Skip the CLI's tool-permission prompts via its `autoApproveArgs`. */
  autoApprove?: boolean;
  /** Extra instructions passed through the CLI's `systemPromptFlag`. */
  systemPrompt?: string;
  /** Values for the CLI descriptor's declared `options`. */
  options?: AgentOptionValues;
}

export interface AgentRunRecord {
  id: string;
  cliId: AgentCliId;
  cwd: string;
  prompt: string;
  model?: string;
  profileId?: string;
  taskId?: string;
  /** Provider-native chat id captured from structured Claude/Agy output. */
  conversationId?: string;
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
  uiMode?: "terminal" | "chat";
  conversationId?: string;
}

export interface AgentDefinition {
  id: AgentCliId;
  displayName: string;
  description: string;
  status: AgentStatus;
  model: string;
}
