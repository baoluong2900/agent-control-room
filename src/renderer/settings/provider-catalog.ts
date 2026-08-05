import { Bot, GitBranch, Globe, KeyRound, Radio, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProviderConnectionAuthMode, ProviderConnectionProvider } from "@contracts";

export type ProviderCatalogEntry = {
  provider: ProviderConnectionProvider;
  label: string;
  description: string;
  harness: string;
  authMode: ProviderConnectionAuthMode;
  authUrl?: string;
  accent: string;
  defaultAccountLabel: string;
  runtimeHint: string;
  icon: LucideIcon;
  /** Short line under the connect button explaining what the click actually does. */
  connectHint: string;
  /** Placeholder shown in the endpoint field, and the value assumed when it is blank. */
  defaultBaseUrl?: string;
};

/** Default bind address of `hermes proxy start` (127.0.0.1:8645). */
export const HERMES_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8645/v1";

export const providerCatalog: ProviderCatalogEntry[] = [
  {
    provider: "hermes-agent",
    label: "Hermes Agent",
    description:
      "Local OpenAI-compatible proxy from Hermes Agent. It attaches your own OAuth credentials upstream, so every OpenAI-style CLI here can run without a vendor API key.",
    harness: "Any OpenAI-compatible CLI",
    authMode: "oauth",
    authUrl: "https://hermes-agent.nousresearch.com/docs/",
    accent: "#a78bfa",
    defaultAccountLabel: "Hermes proxy",
    runtimeHint: "hermes proxy start",
    icon: Radio,
    connectHint: "Run `hermes proxy start` first, then Verify checks the endpoint is answering.",
    defaultBaseUrl: HERMES_PROXY_DEFAULT_BASE_URL,
  },
  {
    provider: "openai-codex",
    label: "OpenAI Codex",
    description: "Local Codex CLI profile backed by an OpenAI account or API key.",
    harness: "Codex CLI",
    authMode: "oauth",
    authUrl: "https://platform.openai.com/",
    accent: "#67e8f9",
    defaultAccountLabel: "OpenAI account",
    runtimeHint: "codex",
    icon: Bot,
    connectHint: "Opens the OpenAI dashboard, then saves the local connection record.",
  },
  {
    provider: "claude-code",
    label: "Claude Code",
    description: "Anthropic account linked to the Claude Code terminal runtime.",
    harness: "Claude Code",
    authMode: "oauth",
    authUrl: "https://claude.ai/",
    accent: "#fbbf24",
    defaultAccountLabel: "Claude account",
    runtimeHint: "claude",
    icon: ShieldCheck,
    connectHint: "Opens claude.ai, then saves the local connection record.",
  },
  {
    provider: "github-copilot",
    label: "GitHub Copilot",
    description: "Copilot account for terminal agent workflows and code review.",
    harness: "Copilot CLI",
    authMode: "oauth",
    authUrl: "https://github.com/login",
    accent: "#f472b6",
    defaultAccountLabel: "GitHub account",
    runtimeHint: "copilot",
    icon: GitBranch,
    connectHint: "Opens the GitHub login page, then saves the local connection record.",
  },
  {
    provider: "kiro",
    label: "Kiro",
    description: "Kiro CLI profile for planning and implementation passes.",
    harness: "Kiro CLI",
    authMode: "device",
    authUrl: "https://kiro.dev/",
    accent: "#c4b5fd",
    defaultAccountLabel: "Kiro account",
    runtimeHint: "kiro",
    icon: Globe,
    connectHint: "Opens kiro.dev for the device login, then saves the connection record.",
  },
  {
    provider: "custom-api",
    label: "Custom API",
    description: "Bring your own OpenAI-compatible endpoint and local API key.",
    harness: "Any CLI",
    authMode: "api-key",
    accent: "#67e8f9",
    defaultAccountLabel: "Custom API key",
    runtimeHint: "custom",
    icon: KeyRound,
    connectHint: "Stores the key in the local encrypted vault. Nothing is sent anywhere.",
  },
];

export function getProviderCatalogEntry(provider: ProviderConnectionProvider): ProviderCatalogEntry {
  return providerCatalog.find((entry) => entry.provider === provider) ?? providerCatalog[providerCatalog.length - 1];
}

/**
 * Providers whose CLI reads a base-URL env var, so pointing them at a local
 * router/proxy actually takes effect. The others authenticate through their own
 * CLI login and ignore an endpoint override, so offering the field would imply
 * a redirect the app cannot deliver.
 */
const baseUrlProviders = new Set<ProviderConnectionProvider>([
  "openai-codex",
  "claude-code",
  "custom-api",
  "hermes-agent",
]);

export function supportsBaseUrl(provider: ProviderConnectionProvider): boolean {
  return baseUrlProviders.has(provider);
}

/** Providers that need a locally stored secret before they can be saved at all. */
export function requiresApiKey(provider: ProviderConnectionProvider): boolean {
  return getProviderCatalogEntry(provider).authMode === "api-key";
}
