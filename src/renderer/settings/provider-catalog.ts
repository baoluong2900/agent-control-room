import { Bot, GitBranch, Globe, KeyRound, ShieldCheck } from "lucide-react";
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
};

export const providerCatalog: ProviderCatalogEntry[] = [
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
  },
  {
    provider: "kiro",
    label: "Kiro",
    description: "Kiro CLI profile for planning and implementation passes.",
    harness: "Kiro CLI",
    authMode: "device",
    authUrl: "https://kiro.dev/",
    accent: "#a78bfa",
    defaultAccountLabel: "Kiro account",
    runtimeHint: "kiro",
    icon: Globe,
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
  },
];

export function getProviderCatalogEntry(provider: ProviderConnectionProvider): ProviderCatalogEntry {
  return providerCatalog.find((entry) => entry.provider === provider) ?? providerCatalog[providerCatalog.length - 1];
}
