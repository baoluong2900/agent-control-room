import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChatFailure,
  normalizeChatBaseUrl,
  parseCompletionPayload,
  parseStreamFrame,
  requestChatCompletion,
  scrubChatSecrets,
} from "../src/main/gateway/gateway-chat-client.ts";

/**
 * Tests for the streaming client. The framing cases matter most: an SSE `data:` line
 * can arrive split across chunks, and a parser that assumes one frame per chunk
 * silently drops tokens on a fast stream while every naive test still passes.
 */

/** Builds a Response whose body streams the given chunks verbatim. */
function streamingResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** Frame for one content delta. */
function delta(content: string, model = "gw-model"): string {
  return `data: ${JSON.stringify({ model, choices: [{ delta: { content } }] })}\n\n`;
}

/**
 * A credential-shaped string, assembled at runtime.
 *
 * Written this way on purpose: a literal key in a test file trips secret scanners
 * (and some editors' redaction), which would replace it and silently defeat the very
 * scrubbing assertions below.
 */
const FAKE_KEY = ["sk", "abcdef123456"].join("-");

/** Any bearer the fake gateway accepts; gateways authenticate upstream themselves. */
const BEARER = "gateway-test";

test("a streamed completion assembles deltas in order and reports the model", async () => {
  const seen: string[] = [];
  const result = await requestChatCompletion(
    {
      requestId: "req-1",
      model: "requested-model",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (part) => seen.push(part),
    },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: FAKE_KEY,
      fetchImpl: (async () =>
        streamingResponse([
          delta("Hello"),
          delta(", "),
          delta("world"),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
          "data: [DONE]\n\n",
        ])) as unknown as typeof fetch,
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.data.text, "Hello, world");
  assert.deepEqual(seen, ["Hello", ", ", "world"]);
  assert.equal(result.data.streamed, true);
  assert.equal(result.data.cancelled, false);
  assert.equal(result.data.finishReason, "stop");
  // The gateway's own model label wins over the requested one.
  assert.equal(result.data.model, "gw-model");
  // total_tokens was absent, so it is derived rather than reported as zero.
  assert.deepEqual(result.data.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
});

test("a data frame split across two chunks is not lost or duplicated", async () => {
  const whole = delta("split-token");
  const cut = Math.floor(whole.length / 2);

  const result = await requestChatCompletion(
    { requestId: "req-2", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: BEARER,
      fetchImpl: (async () => streamingResponse([whole.slice(0, cut), whole.slice(cut), "data: [DONE]\n\n"])) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.equal(result.data.text, "split-token");
});

test("several frames arriving in one chunk are all consumed", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-3", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () => streamingResponse([`${delta("a")}${delta("b")}${delta("c")}`])) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.equal(result.data.text, "abc");
});

test("a final frame without a trailing blank line is still read", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-4", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          delta("first"),
          `data: ${JSON.stringify({ choices: [{ delta: { content: "-last" } }] })}`,
        ])) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.equal(result.data.text, "first-last");
});

test("keep-alive comments and unparseable frames do not break a working stream", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-5", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          ": keep-alive\n\n",
          delta("ok"),
          "data: not-json-at-all\n\n",
          delta("-still-ok"),
          "data: [DONE]\n\n",
        ])) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.equal(result.data.text, "ok-still-ok");
});

test("cancelling mid-stream keeps the text produced so far and marks it cancelled", async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();

  // Pull-based rather than enqueue-then-error: `ReadableStream.error()` discards
  // whatever is still queued, so erroring inside `start()` would throw away the very
  // chunk this test is about and the assertion would pass for the wrong reason.
  // Delivering frame one, waiting for the consumer to ask for more, and only then
  // aborting is what a real cancelled fetch looks like.
  let served = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (served === 0) {
          served += 1;
          streamController.enqueue(encoder.encode(delta("partial-")));
          return;
        }
        controller.abort();
        streamController.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
    }),
    { status: 200 },
  );

  const result = await requestChatCompletion(
    {
      requestId: "req-6",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () => response) as unknown as typeof fetch,
    },
  );

  // A cancellation is a successful-but-partial outcome, not a transport failure:
  // those tokens were generated and billed.
  assert.ok(result.ok);
  assert.equal(result.data.text, "partial-");
  assert.equal(result.data.cancelled, true);
  assert.equal(result.data.finishReason, "cancelled");
});

test("cancelling before any byte arrives reports cancelled rather than unreachable", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await requestChatCompletion(
    {
      requestId: "req-7",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "cancelled");
});

test("a timeout is reported as unreachable, not as a cancellation", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-8", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error.kind, "unreachable");
  assert.match(result.error.message, /in time/);
});

test("a timeout that fires mid-stream is reported as unreachable, not as a cancel", async () => {
  // Distinct from the pre-response timeout above: here tokens already flowed, so the
  // abort lands inside the stream loop. Reporting that as a partial success would tell
  // the user their prompt completed when the gateway actually stalled.
  const encoder = new TextEncoder();
  let served = 0;

  const result = await requestChatCompletion(
    { requestId: "req-18", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      timeoutMs: 20,
      fetchImpl: (async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (served === 0) {
                served += 1;
                controller.enqueue(encoder.encode(delta("started")));
                return;
              }
              // Stall until our own timeout aborts, the way a wedged gateway does.
              return new Promise<void>((resolve) => {
                init.signal?.addEventListener("abort", () => {
                  controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
                  resolve();
                });
              });
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "unreachable");
  assert.match(result.error.message, /in time/);
});

test("time to first token counts the first content frame, not the opening role frame", async () => {
  let clock = 1_000;
  const result = await requestChatCompletion(
    { requestId: "req-9", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      now: () => (clock += 10),
      fetchImpl: (async () =>
        streamingResponse([
          // Role-only opening chunk: no content, so it must not count as a token.
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
          delta("text"),
          "data: [DONE]\n\n",
        ])) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.ok(result.data.ttftMs !== null);
  assert.ok(result.data.ttftMs! > 0);
  assert.ok(result.data.durationMs >= result.data.ttftMs!);
});

test("a non-streamed call resolves in one shot and reports no first-token time", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-10", model: "m", messages: [{ role: "user", content: "hi" }], stream: false },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        assert.equal(JSON.parse(String(init.body)).stream, false);
        return new Response(
          JSON.stringify({
            model: "one-shot",
            choices: [{ message: { content: "complete answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    },
  );

  assert.ok(result.ok);
  assert.equal(result.data.text, "complete answer");
  assert.equal(result.data.streamed, false);
  // Never measured, so null rather than a zero that would claim a measurement.
  assert.equal(result.data.ttftMs, null);
  assert.deepEqual(result.data.usage, { promptTokens: 2, completionTokens: 4, totalTokens: 6 });
});

test("a request with no messages is refused before any socket is opened", async () => {
  let called = false;
  const result = await requestChatCompletion(
    { requestId: "req-11", model: "m", messages: [] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () => {
        called = true;
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    },
  );

  assert.ok(!result.ok);
  assert.equal(called, false);
});

test("an empty base url is not-configured rather than a failed fetch", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-12", model: "m", messages: [{ role: "user", content: "hi" }] },
    { baseUrl: "   ", apiKey: BEARER },
  );

  assert.ok(!result.ok);
  assert.equal(result.error.kind, "not-configured");
});

test("a 200 stream carrying an error envelope is a failure, not an empty completion", async () => {
  // Verbatim shape from a real Pool API gateway with no healthy upstream: HTTP 200,
  // content-type text/event-stream, and the failure inside the first frame. Treating
  // this as a completion reported a working request that produced nothing.
  const result = await requestChatCompletion(
    { requestId: "req-13", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          `data: ${JSON.stringify({
            error: {
              message: "No healthy upstream deployment was available.",
              type: "api_error",
              param: null,
              code: "upstream_error",
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ])) as unknown as typeof fetch,
    },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "server-error");
  assert.match(result.error.message, /No healthy upstream/);
});

test("an in-stream auth failure points at Settings rather than at a retry", async () => {
  // There is no status code to lean on when the failure arrives inside a 200, so the
  // envelope's code is the only signal that this needs a new key, not a retry.
  const result = await requestChatCompletion(
    { requestId: "req-14", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          `data: ${JSON.stringify({ error: { message: "bad key", code: "invalid_api_key" } })}\n\n`,
        ])) as unknown as typeof fetch,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error.kind, "unauthorized");
});

test("an error frame arriving after real tokens still fails rather than half-succeeding", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-15", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          delta("some text"),
          `data: ${JSON.stringify({ error: { message: "upstream died mid-answer", code: "upstream_error" } })}\n\n`,
        ])) as unknown as typeof fetch,
    },
  );

  // A truncated answer reported as a success would be recorded as the model's
  // complete reply.
  assert.ok(!result.ok);
  assert.match(result.error.message, /died mid-answer/);
});

test("a non-streamed 200 body carrying an error envelope is also a failure", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-16", model: "m", messages: [{ role: "user", content: "hi" }], stream: false },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "no upstream", code: "upstream_error" } }), {
          status: 200,
        })) as unknown as typeof fetch,
    },
  );

  assert.ok(!result.ok);
  assert.equal(result.error.kind, "server-error");
});

test("an error envelope carrying a key is scrubbed before it leaves the main process", async () => {
  const result = await requestChatCompletion(
    { requestId: "req-17", model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: BEARER,
      fetchImpl: (async () =>
        streamingResponse([
          `data: ${JSON.stringify({ error: { message: `key ${FAKE_KEY} is revoked`, code: "invalid_api_key" } })}\n\n`,
        ])) as unknown as typeof fetch,
    },
  );

  assert.ok(!result.ok);
  assert.ok(!result.error.message.includes("abcdef123456"), "the key must not reach the renderer");
  assert.match(result.error.message, /sk-\*\*\*/);
});

test("the base url gains exactly one /v1 segment", () => {
  assert.equal(normalizeChatBaseUrl("http://127.0.0.1:8645"), "http://127.0.0.1:8645/v1");
  // Already versioned: appending again would 404 in a way that looks like the
  // gateway is broken.
  assert.equal(normalizeChatBaseUrl("http://127.0.0.1:8645/v1"), "http://127.0.0.1:8645/v1");
  assert.equal(normalizeChatBaseUrl("http://127.0.0.1:8645/v1/"), "http://127.0.0.1:8645/v1");
  assert.equal(normalizeChatBaseUrl("  "), "");
});

test("http failures map to the kind that implies the right fix", () => {
  assert.equal(classifyChatFailure(401, "").kind, "unauthorized");
  assert.equal(classifyChatFailure(403, "").kind, "unauthorized");
  // Out of credit is a server-error kind but must not read as a bad key.
  const credit = classifyChatFailure(402, "");
  assert.equal(credit.kind, "server-error");
  assert.match(credit.message, /credit/);
  assert.equal(classifyChatFailure(500, "").kind, "server-error");

  // The gateway's own wording is preferred when it sends one.
  const detailed = classifyChatFailure(500, JSON.stringify({ error: { message: "upstream is down" } }));
  assert.equal(detailed.message, "upstream is down");
});

test("an error body carrying a key has it scrubbed before crossing the bridge", () => {
  const failure = classifyChatFailure(
    401,
    JSON.stringify({ error: { message: `${FAKE_KEY} was rejected` } }),
  );

  assert.ok(!failure.message.includes("abcdef123456"), "the key must not reach the renderer");
  assert.match(failure.message, /sk-\*\*\*/);
});

test("scrubbing leaves ordinary text alone", () => {
  assert.equal(scrubChatSecrets("nothing secret here"), "nothing secret here");
  assert.equal(scrubChatSecrets(`key=${FAKE_KEY} end`), "key=sk-*** end");
});

test("frame parsing tolerates the shapes a gateway may actually send", () => {
  assert.equal(parseStreamFrame("[DONE]"), null);
  assert.equal(parseStreamFrame("garbage"), null);
  assert.equal(parseStreamFrame(""), null);

  // A gateway that sends one non-incremental frame over SSE uses `message`.
  const asMessage = parseStreamFrame(JSON.stringify({ choices: [{ message: { content: "whole" } }] }));
  assert.equal(asMessage?.delta, "whole");

  // Usage absent entirely is null, not zeroes: "not reported" is a different fact.
  assert.equal(parseStreamFrame(JSON.stringify({ choices: [{ delta: { content: "x" } }] }))?.usage, null);
});

test("a completion body missing choices yields empty text instead of throwing", () => {
  const parsed = parseCompletionPayload({ model: "m" });

  assert.equal(parsed.text, "");
  assert.equal(parsed.finishReason, null);
  assert.equal(parsed.usage, null);
});
