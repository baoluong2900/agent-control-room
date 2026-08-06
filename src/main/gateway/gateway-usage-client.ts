import type {
  GatewayBalance,
  GatewayKeyInfo,
  GatewayLifetime,
  GatewayPricingEntry,
  GatewayRequestPage,
  GatewayRequestRecord,
  GatewayUsageError,
  GatewayUsageOverview,
  GatewayUsageResult,
  GatewayUsageSnapshot,
  GatewayUsageStats,
} from "@contracts";

/**
 * HTTP client for the Pool API gateway's `/dashboard/*` endpoints.
 *
 * Lives in the main process because the credential is an `sk-` key held in the
 * `safeStorage` vault. The renderer asks for *numbers*; it never sees the key, the
 * `Authorization` header, or a raw error object.
 *
 * The gateway is a separate product with its own release cadence, so every field is
 * read defensively: a payload that grows a field is fine, and a payload missing one
 * yields a zero rather than an `undefined` that renders as "NaN" three components
 * later. `normalize*` are exported for exactly this reason — they are the part worth
 * testing, and testing them requires no socket.
 */

/** How long a dashboard call gets before it counts as unreachable. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Rows pulled for the "recent requests" list. Enough to scroll, cheap to fetch. */
const RECENT_REQUEST_LIMIT = 25;

/** Default window for the overview rollups. */
const DEFAULT_WINDOW_DAYS = 30;

/** Matches an `sk-` style credential anywhere in a string, for scrubbing. */
const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{4,}/g;

/** Coerces anything the gateway might send into a finite number. */
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Coerces to a trimmed string, treating null/undefined as empty. */
function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Nullable ISO-ish timestamp: empty strings collapse to null so the UI shows "—". */
function nullableStr(value: unknown): string | null {
  const text = str(value).trim();
  return text ? text : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Removes anything key-shaped from a message before it leaves the main process.
 *
 * A gateway that echoes the offending header in an error body, or a Node error that
 * embeds a URL with the key in a query string, would otherwise hand the renderer
 * the very secret this module exists to contain.
 */
export function scrubSecrets(message: string): string {
  return message.replace(KEY_PATTERN, "sk-***");
}

export function normalizeStats(raw: unknown): GatewayUsageStats {
  const source = record(raw);
  const inputTokens = num(source.input_tokens);
  const outputTokens = num(source.output_tokens);
  return {
    requests: num(source.requests),
    succeeded: num(source.succeeded),
    failed: num(source.failed),
    inputTokens,
    outputTokens,
    // Derived when absent: older gateway builds omit the total, and a dash where a
    // number belongs reads as breakage rather than as a missing optional field.
    totalTokens: source.total_tokens == null ? inputTokens + outputTokens : num(source.total_tokens),
    costUsd: num(source.cost_usd),
    avgLatencyMs: num(source.avg_latency_ms),
  };
}

function normalizeKey(raw: unknown): GatewayKeyInfo {
  const source = record(raw);
  return {
    prefix: str(source.prefix),
    plan: str(source.plan) || "unknown",
    requestsPerMinute: num(source.requests_per_minute),
    tokensPerMinute: num(source.tokens_per_minute),
    maxConcurrency: num(source.max_concurrency),
    dailySpendLimitUsd: num(source.daily_spend_limit_usd),
  };
}

export function normalizeBalance(raw: unknown): GatewayBalance {
  const source = record(raw);
  const availableUsd = num(source.available_usd);
  return {
    balanceUsd: num(source.balance_usd),
    creditLimitUsd: num(source.credit_limit_usd),
    availableUsd,
    reservedUsd: num(source.reserved_usd),
    spentTodayUsd: num(source.spent_today_usd),
    // Trusts the server's flag when present. Re-deriving it in two places is how the
    // banner ends up disagreeing with the 402 the gateway actually returns.
    exhausted: typeof source.exhausted === "boolean" ? source.exhausted : availableUsd <= 0,
    percentRemaining: Math.min(100, Math.max(0, num(source.percent_remaining))),
    updatedAt: nullableStr(source.updated_at),
  };
}

function normalizeLifetime(raw: unknown): GatewayLifetime {
  const source = record(raw);
  const inputTokens = num(source.input_tokens);
  const outputTokens = num(source.output_tokens);
  return {
    requests: num(source.requests),
    inputTokens,
    outputTokens,
    totalTokens: source.total_tokens == null ? inputTokens + outputTokens : num(source.total_tokens),
    costUsd: num(source.cost_usd),
    lastRequestAt: nullableStr(source.last_request_at),
  };
}

function normalizePricing(raw: unknown): GatewayPricingEntry {
  const source = record(raw);
  const model = str(source.model);
  return {
    model,
    displayName: str(source.display_name) || model,
    family: str(source.family),
    contextWindow: num(source.context_window),
    mode: source.mode === "request" ? "request" : "token",
    inputPerMillionUsd: num(source.input_per_million_usd),
    outputPerMillionUsd: num(source.output_per_million_usd),
    cachedInputPerMillionUsd: num(source.cached_input_per_million_usd),
    perRequestUsd: num(source.per_request_usd),
    outputMultiplier: num(source.output_multiplier),
  };
}

export function normalizeOverview(raw: unknown): GatewayUsageOverview {
  const source = record(raw);
  const windowSource = record(source.window);
  return {
    key: normalizeKey(source.key),
    balance: normalizeBalance(source.balance),
    today: normalizeStats(source.today),
    window: {
      days: num(windowSource.days) || DEFAULT_WINDOW_DAYS,
      stats: normalizeStats(windowSource.stats),
    },
    lifetime: normalizeLifetime(source.lifetime),
    byDay: array(source.by_day).map((entry) => {
      const day = record(entry);
      return { day: str(day.day), stats: normalizeStats(day.stats) };
    }),
    // Sorted by spend so the expensive model is first regardless of how the
    // gateway happened to order the group-by.
    byModel: array(source.by_model)
      .map((entry) => {
        const model = record(entry);
        return { model: str(model.model) || "unknown", stats: normalizeStats(model.stats) };
      })
      .sort((left, right) => right.stats.costUsd - left.stats.costUsd),
    pricing: array(source.pricing).map(normalizePricing),
  };
}

export function normalizeRequestRecord(raw: unknown): GatewayRequestRecord {
  const source = record(raw);
  return {
    requestId: str(source.request_id),
    model: str(source.model) || "unknown",
    provider: str(source.provider),
    status: str(source.status) || "unknown",
    httpStatus: num(source.http_status),
    inputTokens: num(source.input_tokens),
    outputTokens: num(source.output_tokens),
    cachedTokens: num(source.cached_tokens),
    costUsd: num(source.cost_usd),
    latencyMs: num(source.latency_ms),
    // Genuinely optional: a non-streamed request has no time-to-first-token, and
    // zero would be a lie about a measurement that was never taken.
    ttftMs: source.ttft_ms == null ? null : num(source.ttft_ms),
    streamed: Boolean(source.streamed),
    errorCode: nullableStr(source.error_code),
    createdAt: str(source.created_at),
  };
}

export function normalizeRequestPage(raw: unknown): GatewayRequestPage {
  const source = record(raw);
  const data = array(source.data).map(normalizeRequestRecord);
  return {
    data,
    total: num(source.total),
    limit: num(source.limit) || data.length,
    offset: num(source.offset),
    hasMore: Boolean(source.has_more),
  };
}

/**
 * Turns an HTTP status into the error kind the panel branches on.
 *
 * 401 and 403 both mean "the stored key will never work", which is a different fix
 * from a 5xx that will resolve on its own.
 */
export function classifyHttpFailure(statusCode: number, body: string): GatewayUsageError {
  const detail = extractErrorMessage(body);
  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: "unauthorized",
      statusCode,
      message: detail ?? "The gateway rejected this API key. Check the key saved in Settings.",
    };
  }
  return {
    kind: "server-error",
    statusCode,
    message: detail ?? `The gateway answered ${statusCode}.`,
  };
}

/**
 * Pulls the human-readable line out of an OpenAI-shaped error envelope.
 *
 * The gateway returns `{"error":{"message":…}}`. Falling back to the raw body would
 * put an HTML error page into a UI label, so anything unparseable yields null and
 * the caller supplies its own wording.
 */
function extractErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const message = record(record(parsed).error).message;
    const text = typeof message === "string" ? message.trim() : "";
    return text ? scrubSecrets(text) : null;
  } catch {
    return null;
  }
}

/** Normalizes a base URL so callers may paste one with or without a trailing slash. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export type GatewayUsageClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Performs one authenticated GET and returns a result rather than throwing.
 *
 * Exported so tests can drive every branch — timeout, transport failure, 401,
 * malformed body — through a stub `fetch` with no gateway running.
 */
export async function fetchDashboard<T>(
  path: string,
  options: GatewayUsageClientOptions,
  parse: (raw: unknown) => T,
): Promise<GatewayUsageResult<T>> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    return { ok: false, error: { kind: "not-configured", message: "No gateway URL is configured." } };
  }
  if (!options.apiKey.trim()) {
    return { ok: false, error: { kind: "not-configured", message: "No gateway API key is saved." } };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${options.apiKey.trim()}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      // Body read inside the guard: a 401 envelope is small, and reading it is what
      // lets the panel show the gateway's own wording instead of a bare status code.
      const body = await response.text().catch(() => "");
      return { ok: false, error: classifyHttpFailure(response.status, body) };
    }

    const payload = await response.json();
    return { ok: true, data: parse(payload) };
  } catch (error) {
    return { ok: false, error: describeTransportFailure(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classifies a thrown fetch/parse failure.
 *
 * An abort is a timeout, not a crash, and it is worth saying so: "took longer than
 * 5s" tells the user the process is up but wedged, which "fetch failed" does not.
 */
function describeTransportFailure(error: unknown): GatewayUsageError {
  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const message = scrubSecrets(raw);

  if (name === "AbortError" || name === "TimeoutError") {
    return { kind: "unreachable", message: "The gateway did not answer in time." };
  }
  if (error instanceof SyntaxError) {
    return { kind: "server-error", message: "The gateway returned a response that was not valid JSON." };
  }
  return { kind: "unreachable", message: `Could not reach the gateway: ${message}` };
}

export function fetchOverview(
  options: GatewayUsageClientOptions,
  days = DEFAULT_WINDOW_DAYS,
): Promise<GatewayUsageResult<GatewayUsageOverview>> {
  return fetchDashboard(`/dashboard/overview?days=${encodeURIComponent(String(days))}`, options, normalizeOverview);
}

export function fetchRecentRequests(
  options: GatewayUsageClientOptions,
  limit = RECENT_REQUEST_LIMIT,
): Promise<GatewayUsageResult<GatewayRequestPage>> {
  return fetchDashboard(
    `/dashboard/requests?limit=${encodeURIComponent(String(limit))}&offset=0`,
    options,
    normalizeRequestPage,
  );
}

/**
 * Fetches everything the panel needs for one render.
 *
 * The two calls run together because they are independent and the panel shows them
 * as one screen; serialising them would double the visible refresh latency. The
 * overview decides the outcome — if it failed, the request list is not worth
 * showing on its own, and an empty history next to a real balance would read as
 * "you have no requests" when it actually means "that call failed".
 */
export async function fetchUsageSnapshot(
  options: GatewayUsageClientOptions,
  days = DEFAULT_WINDOW_DAYS,
): Promise<GatewayUsageResult<GatewayUsageSnapshot>> {
  const [overview, recent] = await Promise.all([fetchOverview(options, days), fetchRecentRequests(options)]);

  if (!overview.ok) return overview;

  return {
    ok: true,
    data: {
      overview: overview.data,
      // A failed history call degrades to an empty list rather than sinking the
      // whole snapshot: balance and today's spend are the reason the panel exists.
      recent: recent.ok ? recent.data.data : [],
      fetchedAt: new Date().toISOString(),
    },
  };
}
