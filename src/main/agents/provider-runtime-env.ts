import type { AgentCliId, ProviderConnection } from "@contracts";

export type ProviderRuntimeContext = {
  connection: ProviderConnection;
  secret?: string;
};

export const providerByCli: Partial<Record<AgentCliId, ProviderConnection["provider"]>> = {
  claude: "claude-code",
  codex: "openai-codex",
  copilot: "github-copilot",
  kiro: "kiro",
  amazonq: "kiro",
};

const customApiCompatible = new Set<AgentCliId>(["aider", "opencode", "custom", "agy", "grok", "qwen"]);

/**
 * Statuses a connection can be spawned with. "unverified" is included on purpose:
 * it means nobody has run a check yet, not that the credential is known bad, and
 * every connection starts there. Excluding it would make a freshly saved key
 * unusable until the user clicked Verify. Only "expired"/"disconnected" — states
 * something actually concluded were broken — are withheld.
 */
const usableStatuses = new Set<ProviderConnection["status"]>(["connected", "unverified"]);

export function selectProviderConnection(
  cliId: AgentCliId,
  connections: ProviderConnection[],
  requestedId?: string,
): ProviderConnection | null {
  const connected = connections.filter((connection) => usableStatuses.has(connection.status));
  if (requestedId) {
    return connected.find((connection) => connection.id === requestedId) ?? null;
  }

  const nativeProvider = providerByCli[cliId];
  if (nativeProvider) {
    return connected.find((connection) => connection.provider === nativeProvider) ?? null;
  }

  if (customApiCompatible.has(cliId)) {
    return connected.find((connection) => connection.provider === "custom-api") ?? null;
  }

  return null;
}

export function buildProviderRuntimeEnv({ connection, secret }: ProviderRuntimeContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    AGENTIC_PROVIDER_CONNECTION_ID: connection.id,
    AGENTIC_PROVIDER: connection.provider,
    AGENTIC_PROVIDER_AUTH_MODE: connection.authMode,
    AGENTIC_PROVIDER_ACCOUNT: connection.accountLabel ?? "",
  };

  const baseUrl = connection.baseUrl?.trim();
  if (baseUrl) {
    env.AGENTIC_PROVIDER_BASE_URL = baseUrl;
    // Both spellings are set because CLIs disagree on which they read, and an
    // unused variable is harmless while a missing one silently reaches the
    // provider's own endpoint instead of the user's router.
    switch (connection.provider) {
      case "claude-code":
        env.ANTHROPIC_BASE_URL = baseUrl;
        env.ANTHROPIC_API_URL = baseUrl;
        break;
      case "openai-codex":
      case "custom-api":
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_API_BASE = baseUrl;
        break;
      default:
        break;
    }
  }

  if (!secret) return env;

  env.AGENTIC_PROVIDER_API_KEY = secret;

  switch (connection.provider) {
    case "openai-codex":
      env.OPENAI_API_KEY = secret;
      break;
    case "claude-code":
      env.ANTHROPIC_API_KEY = secret;
      break;
    case "github-copilot":
      env.GITHUB_TOKEN = secret;
      break;
    case "kiro":
      env.KIRO_API_KEY = secret;
      break;
    case "custom-api":
      env.OPENAI_API_KEY = secret;
      env.CUSTOM_API_KEY = secret;
      break;
  }

  return env;
}
