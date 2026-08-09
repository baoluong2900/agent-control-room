import process from "node:process";
import type { AgentCliDescriptor, AgentCliId, AgentModelOption } from "@contracts";

/**
 * Catalog of agent CLIs the desktop app can drive.
 *
 * Flags are best-effort defaults for each vendor CLI. Every field here can be
 * overridden per agent profile from the UI (command override, extra args,
 * prompt mode), so an unexpected CLI signature never blocks a run.
 */
const catalog: AgentCliDescriptor[] = [
  {
    id: "kiro",
    displayName: "Kiro CLI",
    vendor: "AWS",
    description: "Agentic coding in the terminal with tool use and local context.",
    accent: "#a78bfa",
    docsUrl: "https://kiro.dev",
    // `kiro-cli` is the terminal agent; plain `kiro` only launches the IDE.
    commandCandidates: platformCandidates("kiro-cli").concat(platformCandidates("kiro-cli-chat")),
    versionArgs: ["--version"],
    baseArgs: ["chat", "--no-interactive"],
    interactiveArgs: ["chat"],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    autoApproveArgs: ["--trust-all-tools"],
    // Verified against `kiro-cli chat --help`.
    options: [
      {
        id: "effort",
        label: "Effort level",
        kind: "select",
        flag: "--effort",
        hint: "How long Kiro thinks before answering.",
        choices: [
          { value: "", label: "CLI default" },
          { value: "low", label: "Low", note: "Fastest" },
          { value: "medium", label: "Medium", note: "Balanced" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max", note: "Deepest" },
        ],
      },
      {
        id: "agent",
        label: "Context profile",
        kind: "text",
        flag: "--agent",
        placeholder: "profile name",
        hint: "Named Kiro context profile to load.",
      },
      {
        id: "trustTools",
        label: "Trusted tools",
        kind: "text",
        flag: "--trust-tools",
        joinWithEquals: true,
        placeholder: "fs_read,fs_write",
        hint: "Comma separated. Trusts only these instead of all tools.",
        advanced: true,
      },
    ],
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", note: "Balanced coding default", recommended: true },
      { id: "claude-opus-4-5", label: "Claude Opus 4.5", note: "Deep reasoning" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fast + cheap" },
      { id: "auto", label: "Auto", note: "Let Kiro pick" },
    ],
  },
  {
    id: "agy",
    displayName: "Agy",
    vendor: "Local",
    description: "Terminal agent with print mode, effort levels, and permission control.",
    accent: "#7dd3fc",
    commandCandidates: platformCandidates("agy"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    autoApproveArgs: ["--dangerously-skip-permissions"],
    structuredChat: {
      // Order matters: agy's `--print` consumes the next token as its prompt, so
      // `--output-format` must come first or it is swallowed as the prompt text.
      // `--print` also refuses to read stdin ("flag needs an argument"), hence
      // promptFlag — the prompt is passed as its value, never piped.
      args: ["--output-format", "json", "--print"],
      promptFlag: "--print",
      resumeFlag: "--conversation",
      conversationIdFields: ["conversation_id"],
    },
    // Verified against `agy --help`. `--output-format` is deliberately absent
    // from `options`: the `structuredChat` block above owns that flag.
    options: [
      {
        id: "effort",
        label: "Reasoning effort",
        kind: "select",
        flag: "--effort",
        hint: "How long agy thinks before answering.",
        choices: [
          { value: "", label: "CLI default" },
          { value: "low", label: "Low", note: "Fastest" },
          { value: "medium", label: "Medium", note: "Balanced" },
          { value: "high", label: "High", note: "Deepest" },
        ],
      },
      {
        id: "mode",
        label: "Execution mode",
        kind: "select",
        flag: "--mode",
        hint: "Plan first, or let agy accept its own edits.",
        choices: [
          { value: "", label: "Ask each time" },
          { value: "accept-edits", label: "Accept edits", note: "Apply file changes without asking" },
          { value: "plan", label: "Plan only", note: "Propose without editing" },
        ],
      },
      {
        id: "sandbox",
        label: "Sandbox terminal",
        kind: "toggle",
        flag: "--sandbox",
        valueless: true,
        hint: "Restrict terminal access for this session.",
      },
      {
        id: "agent",
        label: "Sub-agent",
        kind: "text",
        flag: "--agent",
        placeholder: "name from `agy agents`",
        hint: "Named agent definition to run as.",
      },
      {
        id: "addDir",
        label: "Extra workspace folders",
        kind: "list",
        flag: "--add-dir",
        repeatable: true,
        placeholder: "/path/to/another/repo",
        hint: "One folder per line, added alongside the project folder.",
      },
      {
        id: "project",
        label: "Project id",
        kind: "text",
        flag: "--project",
        placeholder: "existing agy project id",
        advanced: true,
      },
      {
        id: "newProject",
        label: "Create a new project per run",
        kind: "toggle",
        flag: "--new-project",
        valueless: true,
        advanced: true,
      },
      {
        id: "disableSlashCommands",
        label: "Disable slash commands",
        kind: "toggle",
        flag: "--disable-slash-commands",
        valueless: true,
        appliesTo: "oneshot",
        advanced: true,
      },
      {
        id: "printTimeout",
        label: "Print timeout",
        kind: "text",
        flag: "--print-timeout",
        placeholder: "5m0s",
        appliesTo: "oneshot",
        advanced: true,
      },
      {
        id: "logFile",
        label: "Log file",
        kind: "text",
        flag: "--log-file",
        placeholder: "/tmp/agy.log",
        advanced: true,
      },
    ],
    // `agy models` prints the live list, which changes far faster than this file.
    modelListArgs: ["models"],
    models: [
      { id: "default", label: "CLI default", note: "Whatever agy is configured with", recommended: true },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", note: "Balanced coding" },
      { id: "claude-opus-4-6-thinking", label: "claude-opus-4-6-thinking", note: "Deep reasoning" },
      { id: "gemini-3.6-flash-high", label: "gemini-3.6-flash-high", note: "Fast tier, high effort" },
      { id: "gemini-3.6-flash-medium", label: "gemini-3.6-flash-medium", note: "Fast tier" },
      { id: "gemini-3.6-flash-low", label: "gemini-3.6-flash-low", note: "Fast tier, cheapest" },
      { id: "gemini-3.5-flash-high", label: "gemini-3.5-flash-high", note: "Previous fast tier" },
      { id: "gemini-3.5-flash-medium", label: "gemini-3.5-flash-medium", note: "Previous fast tier" },
      { id: "gemini-3.5-flash-low", label: "gemini-3.5-flash-low", note: "Previous fast tier" },
      { id: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high", note: "Long context" },
      { id: "gemini-3.1-pro-low", label: "gemini-3.1-pro-low", note: "Long context, cheaper" },
      { id: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium", note: "Open weights" },
    ],
  },
  {
    id: "grok",
    displayName: "Grok Build",
    vendor: "xAI",
    description: "Grok terminal TUI agent with session resume and plugins.",
    accent: "#fdba9b",
    commandCandidates: platformCandidates("grok").concat(platformCandidates("agent")),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    autoApproveArgs: ["--always-approve"],
    systemPromptFlag: "--rules",
    structuredChat: {
      // Verified live: `grok --output-format json --single "…"` prints one JSON
      // object with `text` and `sessionId`, and `--resume <id>` recalled a
      // codeword set on the previous turn (same sessionId, so it is one thread).
      // `--single` takes the prompt as its value, hence promptFlag — a bare
      // positional would start an interactive TUI that never exits.
      args: ["--output-format", "json", "--single"],
      promptFlag: "--single",
      resumeFlag: "--resume",
      conversationIdFields: ["sessionId"],
      outputFormat: "json",
    },
    // Verified against `grok --help`.
    options: [
      {
        id: "permissionMode",
        label: "Permission mode",
        kind: "select",
        flag: "--permission-mode",
        hint: "How Grok asks before running tools.",
        choices: [
          { value: "", label: "CLI default" },
          { value: "acceptEdits", label: "Accept edits", note: "Apply file changes without asking" },
          { value: "plan", label: "Plan only" },
          { value: "auto", label: "Auto" },
          { value: "dontAsk", label: "Don't ask" },
          { value: "bypassPermissions", label: "Bypass permissions", note: "No prompts at all" },
        ],
      },
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        kind: "select",
        flag: "--reasoning-effort",
        choices: [
          { value: "", label: "CLI default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      {
        id: "sandbox",
        label: "Sandbox profile",
        kind: "text",
        flag: "--sandbox",
        placeholder: "profile name",
        hint: "Filesystem and network sandbox profile.",
      },
      {
        id: "maxTurns",
        label: "Max agent turns",
        kind: "text",
        flag: "--max-turns",
        placeholder: "20",
        advanced: true,
      },
      {
        id: "disableWebSearch",
        label: "Disable web search",
        kind: "toggle",
        flag: "--disable-web-search",
        valueless: true,
        advanced: true,
      },
      {
        id: "noSubagents",
        label: "Disable subagents",
        kind: "toggle",
        flag: "--no-subagents",
        valueless: true,
        advanced: true,
      },
    ],
    modelListArgs: ["models"],
    models: [{ id: "grok-4.5", label: "grok-4.5", note: "Default", recommended: true }],
  },
  {
    id: "claude",
    displayName: "Claude Code",
    vendor: "Anthropic",
    description: "Anthropic's terminal agent for repo-wide edits and reviews.",
    accent: "#fbbf24",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    commandCandidates: platformCandidates("claude"),
    versionArgs: ["--version"],
    baseArgs: ["-p"],
    interactiveArgs: [],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    autoApproveArgs: ["--dangerously-skip-permissions"],
    systemPromptFlag: "--append-system-prompt",
    structuredChat: {
      args: ["-p", "--output-format", "json"],
      resumeFlag: "--resume",
    },
    // Verified against `claude --help`.
    options: [
      {
        id: "permissionMode",
        label: "Permission mode",
        kind: "select",
        flag: "--permission-mode",
        hint: "How Claude Code asks before touching files or running tools.",
        choices: [
          { value: "", label: "CLI default" },
          { value: "acceptEdits", label: "Accept edits", note: "Apply file changes without asking" },
          { value: "plan", label: "Plan only", note: "Propose without editing" },
          { value: "auto", label: "Auto" },
          { value: "manual", label: "Manual", note: "Ask for everything" },
          { value: "dontAsk", label: "Don't ask" },
          { value: "bypassPermissions", label: "Bypass permissions", note: "No prompts at all" },
        ],
      },
      {
        id: "allowedTools",
        label: "Allowed tools",
        kind: "list",
        flag: "--allowed-tools",
        repeatable: true,
        placeholder: "Edit",
        hint: "One tool per line. Leave empty to allow the default set.",
      },
      {
        id: "disallowedTools",
        label: "Blocked tools",
        kind: "list",
        flag: "--disallowed-tools",
        repeatable: true,
        placeholder: "Bash",
        advanced: true,
      },
      {
        id: "addDir",
        label: "Extra workspace folders",
        kind: "list",
        flag: "--add-dir",
        repeatable: true,
        placeholder: "/path/to/another/repo",
        hint: "One folder per line, added alongside the project folder.",
      },
    ],
    models: [
      { id: "sonnet", label: "Sonnet (latest)", note: "Best for day-to-day coding", recommended: true },
      { id: "opus", label: "Opus (latest)", note: "Hardest problems" },
      { id: "haiku", label: "Haiku (latest)", note: "Fast edits" },
      { id: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929", note: "Pinned snapshot" },
    ],
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    vendor: "OpenAI",
    description: "OpenAI coding agent with sandboxed local execution.",
    accent: "#67e8f9",
    docsUrl: "https://github.com/openai/codex",
    commandCandidates: platformCandidates("codex"),
    versionArgs: ["--version"],
    baseArgs: ["exec"],
    interactiveArgs: [],
    modelFlag: "-m",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    autoApproveArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    structuredChat: {
      // Verified live on 2026-08-09, both turns through the real CLI.
      //
      // Fresh turn: `codex exec --json "<prompt>"` emits JSONL —
      // `{"type":"thread.started","thread_id":…}` then `turn.started`, then
      // `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`.
      // The answer is the agent_message item's `text`; `command_execution` items
      // carry shell output and must not be read as the reply.
      //
      // Resume is a **subcommand**, not a flag: `codex exec resume <ID> <PROMPT>`.
      // Hence `resumeArgs` rather than `resumeFlag` — appending `--resume <id>`
      // to `codex exec` is not a valid argv and would start a new thread each
      // turn. Verified: turn 2 recalled the codeword stored in turn 1 under the
      // same `thread_id`.
      args: ["exec", "--json"],
      resumeArgs: ["exec", "resume", "--json", "{id}"],
      // `codex exec resume --help` accepts only --last/--all/-c/--enable/-i/
      // --model/--json/--output-schema/-o/--ephemeral/--ignore-*/--strict-config/
      // --skip-git-repo-check/--dangerously-*. Passing `--sandbox` to it fails
      // outright with `error: unexpected argument '--sandbox' found`, so the
      // options below are stripped from resumed turns.
      resumeDropsFlags: ["--sandbox", "--add-dir", "--profile", "--oss"],
      conversationIdFields: ["thread_id"],
      outputFormat: "jsonl",
    },
    // Verified against `codex exec --help`.
    options: [
      {
        id: "sandbox",
        label: "Sandbox mode",
        kind: "select",
        flag: "--sandbox",
        hint: "How much of the machine codex may touch.",
        choices: [
          { value: "", label: "CLI default" },
          { value: "read-only", label: "Read only", note: "No writes, no network" },
          { value: "workspace-write", label: "Workspace write", note: "Edit inside the project" },
          { value: "danger-full-access", label: "Full access", note: "No restrictions" },
        ],
      },
      {
        id: "addDir",
        label: "Extra workspace folders",
        kind: "list",
        flag: "--add-dir",
        repeatable: true,
        placeholder: "/path/to/another/repo",
        hint: "One folder per line, added alongside the project folder.",
      },
      {
        id: "profile",
        label: "Config profile",
        kind: "text",
        flag: "--profile",
        placeholder: "profile name from config.toml",
        advanced: true,
      },
      {
        id: "oss",
        label: "Use local open-weights model",
        kind: "toggle",
        flag: "--oss",
        valueless: true,
        advanced: true,
      },
    ],
    // `default` sends no `-m`, so codex uses the `model` from its own
    // `~/.codex/config.toml`. That is the recommended entry because a pinned id
    // here is a claim about the account's routing: on this machine every id the
    // catalog used to recommend (`gpt-5-codex`, `gpt-5`, `o4-mini`) now fails the
    // request with `unknown provider for model` / `model_not_found`, while the
    // CLI default answers. A stale hard-coded id turns a working CLI into a
    // broken agent card.
    models: [
      { id: "default", label: "CLI default", note: "Whatever ~/.codex/config.toml selects", recommended: true },
      { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max", note: "Codex-tuned, if your account has it" },
      { id: "gpt-5.1-codex", label: "gpt-5.1-codex", note: "Codex-tuned" },
      { id: "gpt-5.1", label: "gpt-5.1", note: "General purpose" },
    ],
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    vendor: "Google",
    description: "Long-context agent CLI with Google Search grounding.",
    accent: "#60a5fa",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    commandCandidates: platformCandidates("gemini"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "-m",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro", note: "1M context", recommended: true },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash", note: "Fast tier" },
      { id: "gemini-2.0-flash", label: "gemini-2.0-flash", note: "Legacy fast" },
    ],
  },
  {
    id: "amazonq",
    displayName: "Amazon Q Developer",
    vendor: "AWS",
    description: "Amazon Q chat agent (`q`) for AWS-aware development.",
    accent: "#c4b5fd",
    docsUrl: "https://docs.aws.amazon.com/amazonq/",
    commandCandidates: platformCandidates("q"),
    versionArgs: ["--version"],
    baseArgs: ["chat", "--no-interactive"],
    interactiveArgs: ["chat"],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "claude-sonnet-4", label: "claude-sonnet-4", recommended: true },
      { id: "claude-3-7-sonnet", label: "claude-3-7-sonnet" },
    ],
  },
  {
    id: "aider",
    displayName: "Aider",
    vendor: "Open source",
    description: "Git-native pair programmer that commits as it edits.",
    accent: "#86efac",
    docsUrl: "https://aider.chat",
    commandCandidates: platformCandidates("aider"),
    versionArgs: ["--version"],
    baseArgs: ["--yes-always", "--no-stream"],
    interactiveArgs: [],
    modelFlag: "--model",
    promptFlag: "--message",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    modelListArgs: ["--list-models", "/"],
    models: [
      { id: "sonnet", label: "sonnet", note: "Anthropic default", recommended: true },
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "deepseek/deepseek-chat", label: "deepseek-chat", note: "Low cost" },
      { id: "ollama/qwen2.5-coder", label: "ollama/qwen2.5-coder", note: "Local" },
    ],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    vendor: "Open source",
    description: "Provider-agnostic terminal agent with a TUI.",
    accent: "#f472b6",
    docsUrl: "https://opencode.ai",
    commandCandidates: platformCandidates("opencode"),
    versionArgs: ["--version"],
    baseArgs: ["run"],
    interactiveArgs: [],
    modelFlag: "-m",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    structuredChat: {
      // Verified live: `opencode run --format json "…"` emits JSONL — one object
      // per event — where the answer is the `text` event's `part.text` and every
      // line carries `sessionID`. `--session <id>` recalled a codeword from the
      // previous turn under that same id.
      //
      // `run` must be repeated here: `args` replaces `baseArgs` for a chat run,
      // so omitting it would invoke bare `opencode` and open the TUI.
      args: ["run", "--format", "json"],
      resumeFlag: "--session",
      conversationIdFields: ["sessionID"],
      outputFormat: "jsonl",
    },
    models: [
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", recommended: true },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    ],
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    vendor: "Cursor",
    description: "Cursor's headless agent CLI (`cursor-agent`).",
    accent: "#93c5fd",
    docsUrl: "https://cursor.com/cli",
    commandCandidates: platformCandidates("cursor-agent"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "auto", label: "auto", note: "Cursor routing", recommended: true },
      { id: "sonnet-4.5", label: "sonnet-4.5" },
      { id: "gpt-5", label: "gpt-5" },
    ],
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    vendor: "GitHub",
    description: "Copilot coding agent in the terminal.",
    accent: "#f0abfc",
    docsUrl: "https://docs.github.com/copilot",
    commandCandidates: platformCandidates("copilot"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5", recommended: true },
      { id: "gpt-5", label: "gpt-5" },
    ],
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    vendor: "Alibaba",
    description: "Qwen coder CLI, Gemini-CLI compatible flags.",
    accent: "#fcd34d",
    docsUrl: "https://github.com/QwenLM/qwen-code",
    commandCandidates: platformCandidates("qwen"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "-m",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus", recommended: true },
      { id: "qwen3-coder-flash", label: "qwen3-coder-flash" },
    ],
  },
  {
    id: "ollama",
    displayName: "Ollama",
    vendor: "Local",
    description: "Run a fully local model as an agent brain.",
    accent: "#a5f3fc",
    docsUrl: "https://ollama.com",
    commandCandidates: platformCandidates("ollama"),
    versionArgs: ["--version"],
    baseArgs: ["run"],
    interactiveArgs: ["run"],
    promptMode: "stdin",
    supportsInteractive: true,
    supportsStdin: true,
    modelListArgs: ["list"],
    models: [
      { id: "qwen2.5-coder", label: "qwen2.5-coder", recommended: true },
      { id: "llama3.1", label: "llama3.1" },
      { id: "deepseek-coder-v2", label: "deepseek-coder-v2" },
    ],
  },
  {
    id: "shell",
    displayName: "Shell",
    vendor: "Local",
    description: "Raw shell runner for builds, tests, and scripts.",
    accent: "#afa8c7",
    commandCandidates: shellCandidates(),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    models: [{ id: "none", label: "No model", note: "Runs the command as-is", recommended: true }],
  },
  {
    id: "custom",
    displayName: "Custom CLI",
    vendor: "Bring your own",
    description: "Point at any local binary and pass your own args.",
    accent: "#d8b4fe",
    commandCandidates: [],
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    models: [{ id: "custom", label: "Custom model", note: "Free-form model id", recommended: true }],
  },
];

const byId = new Map<AgentCliId, AgentCliDescriptor>(catalog.map((entry) => [entry.id, entry]));

export function listAgentCatalog(): AgentCliDescriptor[] {
  return catalog.map((entry) => ({
    ...entry,
    structuredChat: entry.structuredChat
      ? {
          ...entry.structuredChat,
          args: [...entry.structuredChat.args],
          conversationIdFields: entry.structuredChat.conversationIdFields
            ? [...entry.structuredChat.conversationIdFields]
            : undefined,
        }
      : undefined,
    models: entry.models.map((model) => ({ ...model })),
    options: entry.options?.map((option) => ({
      ...option,
      choices: option.choices?.map((choice) => ({ ...choice })),
    })),
  }));
}

export function getAgentDescriptor(id: AgentCliId): AgentCliDescriptor {
  const descriptor = byId.get(id);
  if (!descriptor) {
    throw new Error(`Unknown agent CLI: ${id}`);
  }
  return descriptor;
}

export function isKnownAgentCliId(value: string): value is AgentCliId {
  return byId.has(value as AgentCliId);
}

export function defaultModelFor(id: AgentCliId): string {
  const descriptor = byId.get(id);
  const models: AgentModelOption[] = descriptor?.models ?? [];
  return (models.find((model) => model.recommended) ?? models[0])?.id ?? "";
}

function platformCandidates(binary: string): string[] {
  if (process.platform === "win32") {
    return [`${binary}.cmd`, `${binary}.exe`, `${binary}.bat`, binary];
  }
  return [binary];
}

function shellCandidates(): string[] {
  if (process.platform === "win32") return ["cmd.exe"];
  const preferred = process.env.SHELL;
  return [preferred, "zsh", "bash", "sh"].filter((value): value is string => Boolean(value));
}
