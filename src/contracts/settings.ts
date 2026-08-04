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

export type ProviderConnectionStatus = "connected" | "expired" | "disconnected" | "unverified";

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
  /**
   * OpenAI-compatible endpoint the CLI should talk to instead of the provider's
   * default, e.g. a local router/proxy on `http://127.0.0.1:20128/v1`. Empty means
   * "use the provider's own endpoint".
   */
  baseUrl?: string;
  quotaLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  /** When `verify` last ran against this connection, successfully or not. */
  lastVerifiedAt?: string;
  /** Human-readable outcome of the last verification attempt. */
  verificationDetail?: string;
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
  /** Proxy/router endpoint for this connection; pass an empty string to clear it. */
  baseUrl?: string;
  quotaLabel?: string;
  /** `null` clears the stored value; `undefined` leaves it untouched. */
  lastVerifiedAt?: string | null;
  /** `null` clears the stored value; `undefined` leaves it untouched. */
  verificationDetail?: string | null;
}

export interface ProviderConnectionAuthRequest {
  provider: ProviderConnectionProvider;
}

export interface ProviderConnectionAuthResult {
  provider: ProviderConnectionProvider;
  opened: boolean;
  url?: string;
}

/**
 * What `verifyProviderConnection` could actually establish. This is deliberately
 * narrow: the app checks that a credential is present and that the provider's CLI
 * answers, not that the token is accepted by a remote API.
 */
export type ProviderVerificationOutcome = "verified" | "missing-credential" | "cli-missing" | "unsupported";

export interface ProviderConnectionVerifyResult {
  connectionId: string;
  outcome: ProviderVerificationOutcome;
  /** Status the connection was moved to as a result of this check. */
  status: ProviderConnectionStatus;
  detail: string;
  checkedAt: string;
  connection: ProviderConnection;
}
