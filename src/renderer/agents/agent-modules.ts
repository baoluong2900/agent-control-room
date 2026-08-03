import type { AgentCliId, AgentModuleId } from "@contracts";

export interface AgentModuleDefinition {
  id: AgentModuleId;
  label: string;
  name: string;
  mode: string;
  role: string;
  summary: string;
  defaultCliId: AgentCliId;
  defaultPrompt: string;
  accent: string;
}

export type AgentModuleSeed = {
  moduleId: AgentModuleId;
  label: string;
  name: string;
  mode: string;
  role: string;
  summary: string;
  defaultCliId: AgentCliId;
  defaultPrompt: string;
};

type AgentPersona = {
  name: string;
  mode: string;
  summary: string;
};

export const agentModules: AgentModuleDefinition[] = [
  {
    id: "planner",
    label: "Planner",
    name: "Planner Agent",
    mode: "Planning",
    role: "Project Planner",
    summary: "Breaks work into missions, subtasks, and checkpoints.",
    defaultCliId: "claude",
    defaultPrompt: "Break this request into a safe implementation plan with subtasks, risks, and verification steps.",
    accent: "#a78bfa",
  },
  {
    id: "coder",
    label: "Coder",
    name: "Codex Forge",
    mode: "Coding",
    role: "Implementation Engineer",
    summary: "Writes the smallest safe diff and keeps momentum.",
    defaultCliId: "codex",
    defaultPrompt: "Implement the requested change with the smallest safe diff and include tests if needed.",
    accent: "#67e8f9",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    name: "Claude Scribe",
    mode: "Review",
    role: "Code Reviewer",
    summary: "Reads diffs, catches bugs, and flags missing tests.",
    defaultCliId: "claude",
    defaultPrompt: "Review the change for bugs, regressions, missing tests, and risky assumptions.",
    accent: "#fbbf24",
  },
  {
    id: "tester",
    label: "Tester",
    name: "Shell Deployer",
    mode: "Deployment",
    role: "Build Verifier",
    summary: "Runs commands, checks builds, and reports failures.",
    defaultCliId: "shell",
    defaultPrompt: "Run the relevant verification commands and report deterministic failures only.",
    accent: "#86efac",
  },
  {
    id: "research",
    label: "Research",
    name: "Gemini Scout",
    mode: "Knowledge",
    role: "Research Specialist",
    summary: "Looks up APIs, docs, and edge cases before coding.",
    defaultCliId: "gemini",
    defaultPrompt: "Research the relevant docs and summarize the implementation constraints and best path forward.",
    accent: "#60a5fa",
  },
  {
    id: "ops",
    label: "Ops",
    name: "Agy Operator",
    mode: "Automation",
    role: "Automation Engineer",
    summary: "Handles scripts, releases, and environment checks.",
    defaultCliId: "agy",
    defaultPrompt: "Inspect the environment, run the needed scripts, and report any operational blockers.",
    accent: "#fdba9b",
  },
  {
    id: "builder",
    label: "Builder",
    name: "Kiro Architect",
    mode: "Developer",
    role: "Agent Builder",
    summary: "Creates new agent profiles, prompts, and workflows.",
    defaultCliId: "kiro",
    defaultPrompt: "Draft a reusable agent profile for this project with sensible defaults and permissions.",
    accent: "#f472b6",
  },
  {
    id: "security",
    label: "Security",
    name: "Security Sentinel",
    mode: "Security",
    role: "Gatekeeper",
    summary: "Checks permissions, secrets, and risky commands.",
    defaultCliId: "shell",
    defaultPrompt: "Review the plan for secret exposure, unsafe commands, and permission issues before execution.",
    accent: "#fb7185",
  },
  {
    id: "local",
    label: "Local",
    name: "Local Model",
    mode: "Local",
    role: "Offline Assistant",
    summary: "Runs with local models and offline-friendly defaults.",
    defaultCliId: "ollama",
    defaultPrompt: "Use the local model to complete the task with offline-friendly reasoning and concise steps.",
    accent: "#67e8f9",
  },
  {
    id: "custom",
    label: "Custom",
    name: "Custom Agent",
    mode: "Custom",
    role: "Bring Your Own",
    summary: "Uses your own binary, model, and prompt contract.",
    defaultCliId: "custom",
    defaultPrompt: "Follow the custom agent contract and adapt to the configured binary and prompt style.",
    accent: "#c4b5fd",
  },
];

const moduleById = new Map<AgentModuleId, AgentModuleDefinition>(agentModules.map((entry) => [entry.id, entry]));

const moduleByCli: Record<AgentCliId, AgentModuleId> = {
  claude: "reviewer",
  kiro: "builder",
  codex: "coder",
  gemini: "research",
  agy: "ops",
  grok: "research",
  amazonq: "ops",
  aider: "coder",
  opencode: "builder",
  cursor: "coder",
  copilot: "coder",
  qwen: "coder",
  ollama: "local",
  shell: "tester",
  custom: "custom",
};

const personaByCli: Partial<Record<AgentCliId, AgentPersona>> = {
  kiro: {
    name: "Kiro Architect",
    mode: "Developer",
    summary: "Plans developer work and keeps contracts aligned.",
  },
  agy: {
    name: "Agy Operator",
    mode: "Automation",
    summary: "Runs fast automation passes and test drills.",
  },
  claude: {
    name: "Claude Scribe",
    mode: "Review",
    summary: "Reviews code and writes architecture context.",
  },
  codex: {
    name: "Codex Forge",
    mode: "Coding",
    summary: "Implements coding tasks inside the local repo.",
  },
  gemini: {
    name: "Gemini Scout",
    mode: "Knowledge",
    summary: "Handles long-context reading and research lanes.",
  },
  shell: {
    name: "Shell Deployer",
    mode: "Deployment",
    summary: "Runs package, build, and verification commands.",
  },
  grok: {
    name: "Grok Scout",
    mode: "Knowledge",
    summary: "Explores broad context and compares implementation options.",
  },
  amazonq: {
    name: "Q Operator",
    mode: "Automation",
    summary: "Handles cloud-aware automation and local workflow checks.",
  },
  aider: {
    name: "Aider Coder",
    mode: "Coding",
    summary: "Applies focused code edits with tight repository context.",
  },
  opencode: {
    name: "OpenCode Builder",
    mode: "Developer",
    summary: "Builds reusable agent profiles, prompts, and workflows.",
  },
  cursor: {
    name: "Cursor Pair",
    mode: "Coding",
    summary: "Supports pair-programming style edits and local code navigation.",
  },
  copilot: {
    name: "Copilot Helper",
    mode: "Coding",
    summary: "Assists implementation tasks through GitHub Copilot CLI workflows.",
  },
  qwen: {
    name: "Qwen Coder",
    mode: "Coding",
    summary: "Runs coding-focused model passes with concise implementation output.",
  },
  ollama: {
    name: "Local Model",
    mode: "Local",
    summary: "Runs offline-friendly local model workflows.",
  },
  custom: {
    name: "Custom Agent",
    mode: "Custom",
    summary: "Uses your own binary, model, and prompt contract.",
  },
};

export const agentCliRosterOrder: AgentCliId[] = ["kiro", "agy", "claude", "codex", "gemini", "shell"];

export function getAgentModule(moduleId: AgentModuleId): AgentModuleDefinition {
  return moduleById.get(moduleId) ?? moduleById.get("custom")!;
}

export function moduleTag(moduleId: AgentModuleId): string {
  return `module:${moduleId}`;
}

export function moduleTagToId(tags?: string[]): AgentModuleId | null {
  const match = tags?.find((tag) => tag.startsWith("module:"));
  if (!match) return null;
  const candidate = match.slice("module:".length) as AgentModuleId;
  return moduleById.has(candidate) ? candidate : null;
}

export function moduleForCli(cliId: AgentCliId): AgentModuleDefinition {
  return getAgentModule(moduleByCli[cliId] ?? "custom");
}

export function resolveModuleSeed(input: {
  cliId?: AgentCliId;
  moduleId?: AgentModuleId | null;
  tags?: string[] | null;
}): AgentModuleSeed {
  const moduleId = input.moduleId ?? moduleTagToId(input.tags ?? undefined) ?? (input.cliId ? moduleByCli[input.cliId] : "coder");
  const module = getAgentModule(moduleId);
  const persona = input.cliId ? personaByCli[input.cliId] : null;

  return {
    moduleId: module.id,
    label: module.label,
    name: persona?.name ?? module.name,
    mode: persona?.mode ?? module.mode,
    role: module.role,
    summary: persona?.summary ?? module.summary,
    defaultCliId: module.defaultCliId,
    defaultPrompt: module.defaultPrompt,
  };
}

export function compareAgentCliId(left: AgentCliId, right: AgentCliId): number {
  const leftIndex = agentCliRosterOrder.indexOf(left);
  const rightIndex = agentCliRosterOrder.indexOf(right);
  return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
}

export function sortAgentCatalog<T extends { id: AgentCliId }>(items: T[]): T[] {
  return [...items].sort((left, right) => compareAgentCliId(left.id, right.id));
}
