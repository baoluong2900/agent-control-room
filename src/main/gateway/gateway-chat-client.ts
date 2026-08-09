import type {
  GatewayChatCompletion,
  GatewayChatError,
  GatewayChatMessage,
  GatewayChatUsage,
} from "@contracts";

/**
 * OpenAI-compatible `/v1/chat/completions` client.
 *
 * Pure HTTP plus parsing with an injectable `fetch`, mirroring the split that makes
 * `gateway-usage-client.ts` testable: nothing here touches the secret vault or the
 * settings table, so every branch — SSE framing, a mid-stream abort, a 401, a
 * truncated final frame — is drivable from a test with no server running.
 *
 * Streaming is the interesting part and the reason this is hand-rolled rather than
 * done with an SDK. Two properties matter:
 *
 *   1. SSE frames do not align with chunk boundaries. A `data:` line can arrive
 *      split across two reads, so the parser has to buffer and only consume
 *      complete `\n\n`-delimited events.
 *   2. A cancelled stream must still yield the text produced so far. Those tokens
 *      were generated and billed; throwing them away would misreport what happened
 *      and lose work the user already saw on screen.
 */

/** Ceiling for a whole completion. Long enough for a real answer, still bounded. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Matches an `sk-` style credential anywhere in a string, for scrubbing. */
const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{4,}/g;

/**
 * Removes anything key-shaped before a message leaves the main process.
 *
 * Same guarantee as the usage client: a gateway that echoes the offending
 * `Authorization` header into an error body must not hand the renderer the secret.
 */
export function scrubChatSecrets(message: string): string {
  return message.replace(KEY_PATTERN, "sk-***");
}

/** Normalizes a base URL and guarantees exactly one `/v1` segment. */
export function normalizeChatBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // Connections store either `http://host:port` or `http://host:port/v1`, because
  // the CLIs that consume `OPENAI_BASE_URL` expect the latter. Appending blindly
  // would produce `/v1/v1` for those and fail with a 404 that looks like the
  // gateway is broken.
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export type GatewayChatClientOptions = {
  baseUrl: string;
  /** Bearer sent upstream. Gateways that authenticate on the user's behalf accept any. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injection seam for tests: monotonic-ish clock used for duration and TTFT. */
  now?: () => number;
};

export type GatewayChatCallInput = {
  requestId: string;
  model: string;
  messages: GatewayChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Aborts the request. The partial text is still returned. */
  signal?: AbortSignal;
  /** Called with each newly generated fragment while streaming. */
  onDelta?: (delta: string) => void;
};

export type GatewayChatCallResult =
  | { ok: true; data: GatewayChatCompletion }
  | { ok: false; error: GatewayChatError };

/**
 * One completion request, streamed or not, resolved as a discriminated result.
 *
 * Never rejects. A caller driving this from IPC would otherwise have to translate
 * every throw into a renderer-safe shape at each call site, and an `Error` crossing
 * the bridge would carry main-process paths in its stack.
 */
export async function requestChatCompletion(
  input: GatewayChatCallInput,
  options: GatewayChatClientOptions,
): Promise<GatewayChatCallResult> {
  const baseUrl = normalizeChatBaseUrl(options.baseUrl);
  if (!baseUrl) {
    return { ok: false, error: { kind: "not-configured", message: "No gateway endpoint is configured." } };
  }
  if (input.messages.length === 0) {
    return { ok: false, error: { kind: "server-error", message: "A chat request needs at least one message." } };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? Date.now;
  const streaming = input.stream !== false;
  const startedAt = clock();

  // Two abort sources: the caller's cancel and our own timeout. They are merged
  // rather than chained so the completion can report *which* happened — a
  // user-initiated stop is not a failure and must not be reported as one.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const cancelledByCaller = () => Boolean(input.signal?.aborted) && !timedOut;

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${options.apiKey.trim() || "gateway"}`,
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: streaming,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: classifyChatFailure(response.status, body) };
    }

    if (!streaming) {
      const payload = await response.json();
      const parsed = parseCompletionPayload(payload);
      // Same trap as the streaming path: a 200 body can still carry an error
      // envelope, and treating it as a completion would record an empty answer as a
      // success. Verified against a real gateway with no healthy upstream.
      if (parsed.error) {
        return {
          ok: false,
          error: { kind: classifyStreamErrorCode(parsed.error.code), message: parsed.error.message },
        };
      }
      return {
        ok: true,
        data: {
          requestId: input.requestId,
          model: parsed.model || input.model,
          text: parsed.text,
          finishReason: parsed.finishReason,
          usage: parsed.usage,
          streamed: false,
          durationMs: clock() - startedAt,
          // Never measured for a single-shot response, and 0 would be a lie.
          ttftMs: null,
          cancelled: false,
        },
      };
    }

    return await consumeStream(response, input, {
      startedAt,
      clock,
      cancelledByCaller,
      timedOut: () => timedOut,
    });
  } catch (error) {
    if (cancelledByCaller()) {
      // Aborted before any byte arrived: there is no partial text to keep, but the
      // outcome is still a cancellation rather than a transport failure.
      return {
        ok: false,
        error: { kind: "cancelled", message: "The request was cancelled before the gateway answered." },
      };
    }
    return { ok: false, error: describeChatTransportFailure(error, timedOut) };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Reads an SSE body into a completion.
 *
 * Split out because it is the part worth reading closely: a cancellation lands
 * *here*, mid-iteration, and the contract is that whatever arrived before the abort
 * is returned as a successful-but-cancelled completion rather than thrown away.
 */
async function consumeStream(
  response: Response,
  input: GatewayChatCallInput,
  context: {
    startedAt: number;
    clock: () => number;
    cancelledByCaller: () => boolean;
    /** True when *our* timeout fired, so a mid-stream abort is not read as a cancel. */
    timedOut: () => boolean;
  },
): Promise<GatewayChatCallResult> {
  const { startedAt, clock, cancelledByCaller } = context;
  let text = "";
  let model = "";
  let finishReason: string | null = null;
  let usage: GatewayChatUsage | null = null;
  let ttftMs: number | null = null;

  const emit = (delta: string) => {
    if (!delta) return;
    // First *token*, not first byte: a role-only opening chunk carries no content,
    // and counting it would understate latency the user actually perceives.
    if (ttftMs === null) ttftMs = clock() - startedAt;
    text += delta;
    input.onDelta?.(delta);
  };

  try {
    for await (const frame of readEventStream(response)) {
      if (frame === "[DONE]") break;

      const parsed = parseStreamFrame(frame);
      if (!parsed) continue;

      // An in-stream error envelope is a *failure*, even though the status line said
      // 200 and the content type said event-stream. Reported before anything else so
      // a gateway with no healthy upstream cannot be recorded as a completion whose
      // text merely happens to be empty.
      if (parsed.error) {
        return {
          ok: false,
          error: {
            kind: classifyStreamErrorCode(parsed.error.code),
            message: parsed.error.message,
          },
        };
      }

      if (parsed.model) model = parsed.model;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      if (parsed.usage) usage = parsed.usage;
      emit(parsed.delta);
    }
  } catch (error) {
    // Not folded into the check below: a *thrown* iterator that was not cancelled is
    // a genuine transport failure and must not be reported as a partial success.
    if (!cancelledByCaller()) {
      return { ok: false, error: describeChatTransportFailure(error, context.timedOut()) };
    }
  }

  // Checked once, after the loop, because an abort surfaces either as a throw or as
  // the iterator simply ending — setting the flag inside the catch as well would be
  // a second source of truth for the same fact.
  const cancelled = cancelledByCaller();

  return {
    ok: true,
    data: {
      requestId: input.requestId,
      model: model || input.model,
      text,
      finishReason: cancelled ? "cancelled" : finishReason,
      usage,
      streamed: true,
      durationMs: clock() - startedAt,
      ttftMs,
      cancelled,
    },
  };
}

/**
 * Yields SSE payloads from a response body.
 *
 * Frames are `\n\n`-delimited and a single `data:` payload can straddle two network
 * chunks, so the buffer is only consumed up to the last complete delimiter. Reading
 * chunk-by-chunk and assuming one frame per chunk is the classic way to lose tokens
 * on a fast stream.
 */
export async function* readEventStream(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) {
    // Some fetch stand-ins (and non-streaming proxies) return the whole payload as
    // text. Falling back keeps them working rather than silently yielding nothing.
    const whole = await response.text();
    for (const frame of splitFrames(whole).frames) yield frame;
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const frame of frames) yield frame;
    }
  } finally {
    // Releasing matters on the cancel path: an unreleased reader keeps the socket
    // half-open until GC, which shows up as a leaked handle in tests.
    reader.releaseLock();
  }

  buffer += decoder.decode();
  // A stream that ends without a trailing blank line still has a usable last frame.
  const trailing = buffer.trim();
  if (trailing) {
    for (const frame of extractData(trailing)) yield frame;
  }
}

/** Splits complete SSE events off the front of a buffer. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;

  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary === -1) break;
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    frames.push(...extractData(block));
  }

  return { frames, rest };
}

/** Pulls the `data:` payloads out of one SSE block, ignoring comments and ids. */
function extractData(block: string): string[] {
  const payloads: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (!trimmed.startsWith("data:")) continue;
    payloads.push(trimmed.slice(5).trim());
  }
  return payloads;
}

export type ParsedStreamFrame = {
  delta: string;
  model: string;
  finishReason: string | null;
  usage: GatewayChatUsage | null;
  /**
   * Set when the frame is an error envelope rather than a completion chunk.
   *
   * A gateway can answer `200 text/event-stream` and then put the failure *inside*
   * the stream — verified against Pool API, which returns
   * `data: {"error":{"message":"No healthy upstream deployment was available."}}`
   * followed by `[DONE]` with a 200 status. Without this, such a response parses as
   * a successful completion whose text happens to be empty, and the caller reports
   * a working request that produced nothing.
   */
  error: StreamErrorEnvelope | null;
};

/**
 * Parses one streaming frame.
 *
 * Returns null for anything unparseable instead of throwing: a gateway that
 * interleaves a keep-alive or a vendor-specific frame must not abort a completion
 * that is otherwise working.
 */
export function parseStreamFrame(payload: string): ParsedStreamFrame | null {
  if (!payload || payload === "[DONE]") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const source = asRecord(parsed);
  const choice = asRecord(asArray(source.choices)[0]);
  const delta = asRecord(choice.delta);

  return {
    // `delta.content` is the streaming shape; `message.content` appears when a
    // gateway sends a single non-incremental frame over SSE.
    delta: text(delta.content) || text(asRecord(choice.message).content),
    model: text(source.model),
    finishReason: nullableText(choice.finish_reason),
    usage: parseUsage(source.usage),
    error: parseErrorEnvelope(source.error),
  };
}

export type ParsedCompletion = {
  text: string;
  model: string;
  finishReason: string | null;
  usage: GatewayChatUsage | null;
  /** Same 200-with-an-error-body case the streaming parser handles. */
  error: StreamErrorEnvelope | null;
};

/** Parses a non-streamed `chat.completion` body. */
export function parseCompletionPayload(payload: unknown): ParsedCompletion {
  const source = asRecord(payload);
  const choice = asRecord(asArray(source.choices)[0]);
  return {
    text: text(asRecord(choice.message).content) || text(choice.text),
    model: text(source.model),
    finishReason: nullableText(choice.finish_reason),
    usage: parseUsage(source.usage),
    error: parseErrorEnvelope(source.error),
  };
}

/** Error envelope a gateway may embed in an otherwise-successful response. */
export type StreamErrorEnvelope = { message: string; code: string | null };

/**
 * Reads an OpenAI-shaped `error` object out of a payload.
 *
 * Shared by both parsers rather than inlined twice: the streaming and non-streaming
 * paths hit the identical trap (HTTP 200 carrying a failure), and two copies would
 * be two chances to disagree about what counts as an error.
 */
function parseErrorEnvelope(raw: unknown): StreamErrorEnvelope | null {
  const envelope = asRecord(raw);
  const message = text(envelope.message).trim();
  if (!message) return null;
  return { message: scrubChatSecrets(message), code: nullableText(envelope.code) };
}

/**
 * Normalizes a usage block, deriving the total when the gateway omits it.
 *
 * Returns null rather than zeroes when there is no usage at all: "not reported" and
 * "reported as zero" are different facts, and a cost view built on the second would
 * be quietly wrong.
 */
function parseUsage(raw: unknown): GatewayChatUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const promptTokens = num(source.prompt_tokens);
  const completionTokens = num(source.completion_tokens);
  const declared = source.total_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: declared == null ? promptTokens + completionTokens : num(declared),
  };
}

/**
 * Maps an in-stream error code onto the kind the UI branches on.
 *
 * There is no HTTP status to lean on here — the response was a 200 — so the code the
 * gateway put in the envelope is the only signal available. An auth failure delivered
 * this way still has to point the user at Settings rather than at a retry button.
 */
function classifyStreamErrorCode(code: string | null): GatewayChatError["kind"] {
  const normalized = code?.toLowerCase() ?? "";
  if (normalized.includes("api_key") || normalized.includes("auth") || normalized.includes("permission")) {
    return "unauthorized";
  }
  return "server-error";
}

/**
 * Turns an HTTP status into the kind the UI branches on.
 *
 * 401/403 mean the stored credential will never work; 402 is its own situation
 * worth keeping distinct in the message, since "out of credit" is fixed by topping
 * up rather than by re-pasting a key.
 */
export function classifyChatFailure(statusCode: number, body: string): GatewayChatError {
  const detail = extractChatErrorMessage(body);
  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: "unauthorized",
      statusCode,
      message: detail ?? "The gateway rejected this credential. Check the key saved in Settings.",
    };
  }
  if (statusCode === 402) {
    return {
      kind: "server-error",
      statusCode,
      message: detail ?? "The gateway refused the request for lack of credit.",
    };
  }
  return {
    kind: "server-error",
    statusCode,
    message: detail ?? `The gateway answered ${statusCode}.`,
  };
}

/** Pulls the human-readable line out of an OpenAI-shaped error envelope. */
function extractChatErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const message = asRecord(asRecord(parsed).error).message;
    const value = typeof message === "string" ? message.trim() : "";
    return value ? scrubChatSecrets(value) : null;
  } catch {
    return null;
  }
}

/** Classifies a thrown fetch/parse failure. */
function describeChatTransportFailure(error: unknown, timedOut: boolean): GatewayChatError {
  const name = error instanceof Error ? error.name : "";
  const raw = error instanceof Error ? error.message : String(error);
  const message = scrubChatSecrets(raw);

  if (timedOut) {
    return { kind: "unreachable", message: "The gateway did not finish the response in time." };
  }
  if (name === "AbortError" || name === "TimeoutError") {
    return { kind: "unreachable", message: "The gateway did not answer in time." };
  }
  if (error instanceof SyntaxError) {
    return { kind: "server-error", message: "The gateway returned a response that was not valid JSON." };
  }
  return { kind: "unreachable", message: `Could not reach the gateway: ${message}` };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const parsed = text(value).trim();
  return parsed ? parsed : null;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
