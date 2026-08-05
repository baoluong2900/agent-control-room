import type { AgentCliId, ProviderConnectionProvider } from "@contracts";

const providerByCli: Partial<Record<AgentCliId, ProviderConnectionProvider>> = {
  claude: "claude-code",
  codex: "openai-codex",
  copilot: "github-copilot",
  kiro: "kiro",
  amazonq: "kiro",
};

/**
 * CLIs that speak to an OpenAI-compatible `/v1` endpoint, so any gateway-style
 * provider (the local Hermes Agent proxy, or a bring-your-own endpoint) can
 * drive them. Mirrors `openAiCompatibleClis` in the main process.
 */
const openAiCompatibleClis = new Set<AgentCliId>(["aider", "opencode", "custom", "agy", "grok", "qwen", "codex"]);

export function compatibleProviderForCli(cliId: AgentCliId): ProviderConnectionProvider[] {
  const providers: ProviderConnectionProvider[] = [];
  const native = providerByCli[cliId];
  if (native) providers.push(native);
  if (openAiCompatibleClis.has(cliId)) providers.push("hermes-agent", "custom-api");
  return providers;
}
