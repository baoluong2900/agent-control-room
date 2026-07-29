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
    accent: "#8b5cf6",
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
    accent: "#38bdf8",
    commandCandidates: platformCandidates("agy"),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptFlag: "-p",
    promptMode: "flag",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "default", label: "CLI default", note: "Whatever agy is configured with", recommended: true },
      { id: "sonnet", label: "sonnet" },
      { id: "opus", label: "opus" },
    ],
  },
  {
    id: "grok",
    displayName: "Grok Build",
    vendor: "xAI",
    description: "Grok terminal TUI agent with session resume and plugins.",
    accent: "#f97316",
    commandCandidates: platformCandidates("grok").concat(platformCandidates("agent")),
    versionArgs: ["--version"],
    baseArgs: [],
    interactiveArgs: [],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    modelListArgs: ["models"],
    models: [{ id: "grok-4.5", label: "grok-4.5", note: "Default", recommended: true }],
  },
  {
    id: "claude",
    displayName: "Claude Code",
    vendor: "Anthropic",
    description: "Anthropic's terminal agent for repo-wide edits and reviews.",
    accent: "#f59e0b",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    commandCandidates: platformCandidates("claude"),
    versionArgs: ["--version"],
    baseArgs: ["-p"],
    interactiveArgs: [],
    modelFlag: "--model",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
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
    accent: "#22d3ee",
    docsUrl: "https://github.com/openai/codex",
    commandCandidates: platformCandidates("codex"),
    versionArgs: ["--version"],
    baseArgs: ["exec"],
    interactiveArgs: [],
    modelFlag: "-m",
    promptMode: "arg",
    supportsInteractive: true,
    supportsStdin: true,
    models: [
      { id: "gpt-5-codex", label: "gpt-5-codex", note: "Codex-tuned", recommended: true },
      { id: "gpt-5", label: "gpt-5", note: "General purpose" },
      { id: "o4-mini", label: "o4-mini", note: "Cheap reasoning" },
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
    accent: "#a78bfa",
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
    accent: "#34d399",
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
    accent: "#e879f9",
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
    accent: "#fbbf24",
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
    accent: "#67e8f9",
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
    accent: "#94a3b8",
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
    accent: "#c4b5fd",
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
  return catalog.map((entry) => ({ ...entry, models: entry.models.map((model) => ({ ...model })) }));
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
