export type AppLoginMethod = "google" | "github" | "email";

export type AppIdentityStatus = "signed-in" | "signed-out";

export interface AppIdentity {
  id: string;
  email: string;
  displayName: string;
  loginMethod: AppLoginMethod;
  status: AppIdentityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppIdentityInput {
  email: string;
  displayName: string;
  loginMethod: AppLoginMethod;
  status?: AppIdentityStatus;
}

export type ProviderConnectionProvider =
  | "openai-codex"
  | "claude-code"
  | "github-copilot"
  | "kiro"
  | "custom-api";

export type ProviderConnectionStatus = "connected" | "expired" | "disconnected";

export type ProviderConnectionStorageMode = "local";

export type ProviderConnectionAuthMode = "oauth" | "device" | "api-key";

export interface ProviderConnection {
  id: string;
  userId: string;
  provider: ProviderConnectionProvider;
  authMode: ProviderConnectionAuthMode;
  storageMode: ProviderConnectionStorageMode;
  accountLabel?: string;
  status: ProviderConnectionStatus;
  tokenReference?: string;
  quotaLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export interface ProviderConnectionInput {
  id?: string;
  userId?: string;
  provider: ProviderConnectionProvider;
  authMode?: ProviderConnectionAuthMode;
  accountLabel?: string;
  status?: ProviderConnectionStatus;
  tokenReference?: string;
  tokenSecret?: string;
  quotaLabel?: string;
}

export interface ProviderConnectionAuthRequest {
  provider: ProviderConnectionProvider;
}

export interface ProviderConnectionAuthResult {
  provider: ProviderConnectionProvider;
  opened: boolean;
  url?: string;
}
