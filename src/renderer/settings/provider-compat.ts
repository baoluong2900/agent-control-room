import type { AgentCliId, ProviderConnectionProvider } from "@contracts";

const providerByCli: Partial<Record<AgentCliId, ProviderConnectionProvider>> = {
  claude: "claude-code",
  codex: "openai-codex",
  copilot: "github-copilot",
  kiro: "kiro",
  amazonq: "kiro",
};

const customApiCompatible = new Set<AgentCliId>(["aider", "opencode", "custom", "agy", "grok", "qwen"]);

export function compatibleProviderForCli(cliId: AgentCliId): ProviderConnectionProvider[] {
  const direct = providerByCli[cliId];
  if (direct) return [direct];
  if (customApiCompatible.has(cliId)) return ["custom-api"];
  return [];
}
