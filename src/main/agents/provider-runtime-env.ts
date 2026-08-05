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

/**
 * CLIs that talk to an OpenAI-compatible `/v1` endpoint and read `OPENAI_BASE_URL`
 * (or the `OPENAI_API_BASE` spelling). Any provider that *is* such an endpoint —
 * `custom-api` and the local Hermes Agent proxy — can drive these.
 */
const openAiCompatibleClis = new Set<AgentCliId>(["aider", "opencode", "custom", "agy", "grok", "qwen", "codex"]);

/**
 * Providers a CLI can be pointed at, in preference order. A CLI's own vendor
 * provider wins; an OpenAI-compatible gateway is the fallback so a user who runs
 * `hermes proxy start` can drive Codex/Aider/OpenCode without a vendor key.
 */
export function compatibleProvidersForCli(cliId: AgentCliId): ProviderConnection["provider"][] {
  const providers: ProviderConnection["provider"][] = [];
  const native = providerByCli[cliId];
  if (native) providers.push(native);
  if (openAiCompatibleClis.has(cliId)) providers.push("hermes-agent", "custom-api");
  return providers;
}

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

  for (const provider of compatibleProvidersForCli(cliId)) {
    const match = connected.find((connection) => connection.provider === provider);
    if (match) return match;
  }

  return null;
}

/**
 * The endpoint a connection routes through. Hermes Agent connections default to
 * the proxy's own bind address (`hermes proxy start` listens on 8645) so the
 * common case needs no typing, while an explicit base URL still wins.
 */
export function resolveConnectionBaseUrl(connection: ProviderConnection): string | undefined {
  const explicit = connection.baseUrl?.trim();
  if (explicit) return explicit;
  if (connection.provider === "hermes-agent") return HERMES_PROXY_DEFAULT_BASE_URL;
  return undefined;
}

/** Default bind address of `hermes proxy start` (host 127.0.0.1, port 8645). */
export const HERMES_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8645/v1";

/**
 * Placeholder bearer for the Hermes proxy. The proxy accepts any token and
 * attaches the user's real OAuth credentials upstream, but the CLIs refuse to
 * start with an empty key, so one is always supplied.
 */
const HERMES_PROXY_PLACEHOLDER_KEY = "hermes-proxy";

export function buildProviderRuntimeEnv({ connection, secret }: ProviderRuntimeContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    AGENTIC_PROVIDER_CONNECTION_ID: connection.id,
    AGENTIC_PROVIDER: connection.provider,
    AGENTIC_PROVIDER_AUTH_MODE: connection.authMode,
    AGENTIC_PROVIDER_ACCOUNT: connection.accountLabel ?? "",
  };

  const baseUrl = resolveConnectionBaseUrl(connection);
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
      case "hermes-agent":
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_API_BASE = baseUrl;
        break;
      default:
        break;
    }
  }

  // The proxy authenticates upstream on the user's behalf, so a stored key is
  // optional here — but the OpenAI SDK inside every CLI still demands one.
  const effectiveSecret =
    connection.provider === "hermes-agent" ? secret?.trim() || HERMES_PROXY_PLACEHOLDER_KEY : secret;

  if (!effectiveSecret) return env;

  env.AGENTIC_PROVIDER_API_KEY = effectiveSecret;

  switch (connection.provider) {
    case "openai-codex":
      env.OPENAI_API_KEY = effectiveSecret;
      break;
    case "claude-code":
      env.ANTHROPIC_API_KEY = effectiveSecret;
      break;
    case "github-copilot":
      env.GITHUB_TOKEN = effectiveSecret;
      break;
    case "kiro":
      env.KIRO_API_KEY = effectiveSecret;
      break;
    case "hermes-agent":
      env.OPENAI_API_KEY = effectiveSecret;
      env.HERMES_PROXY_API_KEY = effectiveSecret;
      break;
    case "custom-api":
      env.OPENAI_API_KEY = effectiveSecret;
      env.CUSTOM_API_KEY = effectiveSecret;
      break;
  }

  return env;
}
