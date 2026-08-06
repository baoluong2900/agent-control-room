import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHttpFailure,
  fetchDashboard,
  fetchUsageSnapshot,
  normalizeBalance,
  normalizeBaseUrl,
  normalizeOverview,
  normalizeRequestPage,
  normalizeRequestRecord,
  normalizeStats,
  scrubSecrets,
} from "../src/main/gateway/gateway-usage-client.ts";

/**
 * The gateway is a separate product on its own release cadence, so these tests pin
 * the parsing contract rather than the happy path alone: a field that goes missing
 * must yield a zero, never an `undefined` that reaches the UI as "NaN".
 */

/** Minimal stub `fetch` returning a fixed JSON body. */
function respondWith(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(String(url), init);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }) as unknown as typeof fetch;
}

const options = (fetchImpl: typeof fetch) => ({
  baseUrl: "http://localhost:5100",
  apiKey: "sk-test-key-abcd1234",
  fetchImpl,
});

test("stats normalize missing fields to zero rather than undefined", () => {
  const stats = normalizeStats({ requests: 4 });

  assert.equal(stats.requests, 4);
  assert.equal(stats.succeeded, 0);
  assert.equal(stats.costUsd, 0);
  assert.equal(stats.avgLatencyMs, 0);
});

test("total tokens are derived when the gateway omits them", () => {
  const stats = normalizeStats({ input_tokens: 120, output_tokens: 80 });

  // An older gateway build omits the total; a dash where a number belongs reads
  // as breakage rather than as a missing optional field.
  assert.equal(stats.totalTokens, 200);
});

test("an explicit total wins over the derived sum", () => {
  const stats = normalizeStats({ input_tokens: 1, output_tokens: 1, total_tokens: 99 });

  assert.equal(stats.totalTokens, 99);
});

test("balance trusts the server's exhausted flag", () => {
  // Non-zero available with exhausted=true is what a reserved-funds hold looks
  // like. Re-deriving the flag here would disagree with the 402 the gateway sends.
  const balance = normalizeBalance({ available_usd: 5, exhausted: true, percent_remaining: 12 });

  assert.equal(balance.exhausted, true);
  assert.equal(balance.availableUsd, 5);
});

test("balance falls back to deriving exhaustion when the flag is absent", () => {
  assert.equal(normalizeBalance({ available_usd: 0 }).exhausted, true);
  assert.equal(normalizeBalance({ available_usd: 3 }).exhausted, false);
});

test("percent remaining is clamped into 0-100", () => {
  assert.equal(normalizeBalance({ percent_remaining: 140 }).percentRemaining, 100);
  assert.equal(normalizeBalance({ percent_remaining: -20 }).percentRemaining, 0);
});

test("a brand-new account parses into zeroes, not a crash", () => {
  // Exactly what the gateway returns before the first request: empty arrays and
  // nulls where timestamps would be.
  const overview = normalizeOverview({
    key: { prefix: "sk-abc", plan: "free" },
    balance: { balance_usd: 0, available_usd: 0, exhausted: true, percent_remaining: 0, updated_at: null },
    today: {},
    window: { days: 30, stats: {} },
    lifetime: { last_request_at: null },
    by_day: [],
    by_model: [],
    pricing: [],
  });

  assert.equal(overview.today.requests, 0);
  assert.equal(overview.lifetime.requests, 0);
  assert.equal(overview.lifetime.lastRequestAt, null);
  assert.deepEqual(overview.byModel, []);
  assert.equal(overview.window.days, 30);
});

test("overview survives a completely empty payload", () => {
  // Defensive: a proxy returning `{}` must not take the panel down.
  const overview = normalizeOverview({});

  assert.equal(overview.key.plan, "unknown");
  assert.equal(overview.balance.availableUsd, 0);
  assert.deepEqual(overview.pricing, []);
  assert.equal(overview.window.days, 30, "falls back to the default window");
});

test("per-model rows are ordered by spend", () => {
  const overview = normalizeOverview({
    by_model: [
      { model: "cheap", stats: { cost_usd: 0.5 } },
      { model: "expensive", stats: { cost_usd: 12 } },
      { model: "middle", stats: { cost_usd: 3 } },
    ],
  });

  assert.deepEqual(
    overview.byModel.map((entry) => entry.model),
    ["expensive", "middle", "cheap"],
  );
});

test("a request without a ttft keeps null instead of a fabricated zero", () => {
  const record = normalizeRequestRecord({ request_id: "r1", ttft_ms: null, streamed: false });

  // Zero would be a lie about a measurement that was never taken.
  assert.equal(record.ttftMs, null);
  assert.equal(record.streamed, false);
});

test("request pages default the limit to the row count", () => {
  const page = normalizeRequestPage({ data: [{ request_id: "a" }, { request_id: "b" }] });

  assert.equal(page.limit, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.data[0].model, "unknown", "a missing model is labelled, not blank");
});

test("a 401 is classified as unauthorized and keeps the gateway's wording", () => {
  const error = classifyHttpFailure(
    401,
    JSON.stringify({ error: { message: "Invalid API key provided.", type: "invalid_request_error" } }),
  );

  assert.equal(error.kind, "unauthorized");
  assert.equal(error.statusCode, 401);
  assert.match(error.message, /Invalid API key/);
});

test("a 403 is also unauthorized, not a generic server error", () => {
  assert.equal(classifyHttpFailure(403, "").kind, "unauthorized");
});

test("a 500 is a server error with a fallback message", () => {
  const error = classifyHttpFailure(500, "<html>Bad Gateway</html>");

  assert.equal(error.kind, "server-error");
  // An HTML error page must not become a UI label.
  assert.equal(error.message, "The gateway answered 500.");
});

test("secrets are scrubbed out of error text", () => {
  const scrubbed = scrubSecrets("auth failed for sk-live-abcd1234efgh using header");

  assert.match(scrubbed, /sk-\*\*\*/);
  assert.ok(!scrubbed.includes("abcd1234efgh"), "the key body never survives");
});

test("a 401 body carrying the key is scrubbed before it leaves the process", () => {
  const error = classifyHttpFailure(401, JSON.stringify({ error: { message: "key sk-leaked-9999 is revoked" } }));

  assert.ok(!error.message.includes("sk-leaked-9999"));
});

test("base urls normalize away trailing slashes", () => {
  assert.equal(normalizeBaseUrl("http://localhost:5100/"), "http://localhost:5100");
  assert.equal(normalizeBaseUrl("  http://localhost:5100///  "), "http://localhost:5100");
});

test("a missing key short-circuits before any HTTP call", async () => {
  let called = false;
  const result = await fetchDashboard(
    "/dashboard/overview",
    {
      baseUrl: "http://localhost:5100",
      apiKey: "   ",
      fetchImpl: respondWith(200, {}, () => {
        called = true;
      }),
    },
    (raw) => raw,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "not-configured");
  assert.equal(called, false, "an unconfigured panel must not hit the network");
});

test("the api key travels as a bearer header and never in the url", async () => {
  let seenUrl = "";
  let seenInit: RequestInit = {};
  await fetchDashboard(
    "/dashboard/overview?days=30",
    options(
      respondWith(200, {}, (url, init) => {
        seenUrl = url;
        seenInit = init;
      }),
    ),
    (raw) => raw,
  );

  const headers = seenInit.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test-key-abcd1234");
  assert.ok(!seenUrl.includes("sk-test-key"), "the key must never appear in a URL");
});

test("a transport failure resolves to unreachable rather than throwing", async () => {
  const failing = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:5100");
  }) as unknown as typeof fetch;

  const result = await fetchDashboard("/dashboard/overview", { ...options(failing) }, (raw) => raw);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "unreachable");
});

test("an abort is reported as a timeout, not a crash", async () => {
  const aborting = (async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await fetchDashboard("/dashboard/overview", { ...options(aborting) }, (raw) => raw);

  assert.equal(result.ok === false && result.error.kind, "unreachable");
  assert.match(result.ok === false ? result.error.message : "", /did not answer in time/);
});

test("a snapshot still renders when only the request history fails", async () => {
  // Balance and today's spend are the reason the panel exists; losing the history
  // list must not sink the whole screen.
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/dashboard/requests")) {
      return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({ today: { requests: 7 }, balance: { available_usd: 4 } }),
    };
  }) as unknown as typeof fetch;

  const result = await fetchUsageSnapshot(options(fetchImpl));

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.data.overview.today.requests, 7);
  assert.deepEqual(result.ok === true && result.data.recent, []);
});

test("a failed overview sinks the whole snapshot", async () => {
  // The inverse: an empty history next to a real balance would read as "you have
  // no requests" when it actually means "that call failed".
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/dashboard/overview")) {
      return { ok: false, status: 401, text: async () => "", json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({ data: [] }) };
  }) as unknown as typeof fetch;

  const result = await fetchUsageSnapshot(options(fetchImpl));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "unauthorized");
});

test("malformed json is reported as a server error, not an unreachable gateway", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: async () => "not json",
    json: async () => {
      throw new SyntaxError("Unexpected token o in JSON at position 1");
    },
  })) as unknown as typeof fetch;

  const result = await fetchDashboard("/dashboard/overview", { ...options(fetchImpl) }, (raw) => raw);

  assert.equal(result.ok === false && result.error.kind, "server-error");
});
