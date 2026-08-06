/**
 * Credit and usage telemetry read from the Pool API gateway's `/dashboard/*`
 * endpoints.
 *
 * These types describe what the *renderer* receives, which is deliberately not the
 * raw gateway payload. The gateway speaks snake_case and returns decimals that a
 * brand-new account leaves null; the renderer gets camelCase with every numeric
 * field already defaulted, so a panel never has to guard `?? 0` on every read.
 * `gateway-usage-client.ts` owns that translation.
 *
 * The API key itself never appears here. It is read from the secret vault inside
 * the main process on each call and never crosses the IPC bridge.
 */

/** Rollup counters. Shared by "today", the N-day window, per-day and per-model. */
export type GatewayUsageStats = {
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
};

/** The calling key's own limits, for showing what plan the spend is measured against. */
export type GatewayKeyInfo = {
  /** Display-safe prefix (e.g. `sk-abc…`). Never the full key. */
  prefix: string;
  plan: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrency: number;
  dailySpendLimitUsd: number;
};

export type GatewayBalance = {
  balanceUsd: number;
  creditLimitUsd: number;
  availableUsd: number;
  reservedUsd: number;
  spentTodayUsd: number;
  /** Server's verdict, not re-derived here — see the note in DashboardEndpoints.cs. */
  exhausted: boolean;
  /** 0-100. Clamped by the gateway. */
  percentRemaining: number;
  updatedAt: string | null;
};

export type GatewayLifetime = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  lastRequestAt: string | null;
};

export type GatewayModelUsage = {
  model: string;
  stats: GatewayUsageStats;
};

export type GatewayDayUsage = {
  day: string;
  stats: GatewayUsageStats;
};

export type GatewayPricingEntry = {
  model: string;
  displayName: string;
  family: string;
  contextWindow: number;
  mode: "token" | "request";
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  perRequestUsd: number;
  outputMultiplier: number;
};

export type GatewayUsageOverview = {
  key: GatewayKeyInfo;
  balance: GatewayBalance;
  today: GatewayUsageStats;
  window: { days: number; stats: GatewayUsageStats };
  lifetime: GatewayLifetime;
  byDay: GatewayDayUsage[];
  byModel: GatewayModelUsage[];
  pricing: GatewayPricingEntry[];
};

export type GatewayRequestRecord = {
  requestId: string;
  model: string;
  provider: string;
  status: string;
  httpStatus: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  ttftMs: number | null;
  streamed: boolean;
  errorCode: string | null;
  createdAt: string;
};

export type GatewayRequestPage = {
  data: GatewayRequestRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

/**
 * Why a usage read did not produce data.
 *
 * Modelled as a closed union rather than a message string because each case needs
 * different UI: `not-configured` invites the user to add a key, `unauthorized`
 * means the stored key is wrong, and `unreachable` means the gateway is down and
 * retrying will help. Collapsing them into one error string is how a panel ends up
 * telling someone to check their key when the process simply is not running.
 */
export type GatewayUsageErrorKind = "not-configured" | "unauthorized" | "unreachable" | "server-error";

export type GatewayUsageError = {
  kind: GatewayUsageErrorKind;
  /** Human-readable, already scrubbed of anything key-shaped. */
  message: string;
  /** Present for HTTP-level failures. */
  statusCode?: number;
};

/**
 * Every usage call resolves to this instead of rejecting.
 *
 * A polling panel that has to try/catch each tick leaks unhandled rejections the
 * moment a poll overlaps an unmount, and the renderer must never receive a raw
 * `Error` (its `.stack` would carry main-process paths). A discriminated result
 * makes the failure path as type-checked as the success path.
 */
export type GatewayUsageResult<T> = { ok: true; data: T } | { ok: false; error: GatewayUsageError };

/** Where the panel reads its configuration from, minus the secret itself. */
export type GatewayUsageSettings = {
  baseUrl: string;
  /** Whether a key is present in the vault. The key itself is never sent. */
  hasApiKey: boolean;
  /** Display-safe tail of the stored key, for confirming which one is saved. */
  keyHint: string | null;
};

export type GatewayUsageSettingsInput = {
  baseUrl?: string;
  /**
   * Plaintext key on its way to the vault. Absent leaves the stored key alone;
   * empty string clears it.
   */
  apiKey?: string;
};

/** Bundle fetched per poll, so the panel renders from one round trip. */
export type GatewayUsageSnapshot = {
  overview: GatewayUsageOverview;
  recent: GatewayRequestRecord[];
  fetchedAt: string;
};
