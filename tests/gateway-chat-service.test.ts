import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayChatEvent, ProviderConnection } from "../src/contracts/index.ts";
import type { ProviderSecretVault } from "../src/main/settings/provider-secret-vault.ts";
import { GatewayChatService, selectChatConnection } from "../src/main/gateway/gateway-chat-service.ts";

/**
 * Tests for the routing/cancellation half. The client tests cover the wire; these
 * cover the decisions this class owns: which connection a prompt goes through, that
 * the credential never leaves it, and that `cancel(requestId)` actually reaches an
 * in-flight request.
 */

const NOW = new Date().toISOString();

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "hermes-agent",
    authMode: "oauth",
    storageMode: "local",
    status: "connected",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVault(entries: Record<string, string> = {}) {
  return {
    save: () => "provider-secret:1",
    read: (reference?: string) => (reference ? entries[reference] : undefined),
    delete: () => {},
  } as unknown as ProviderSecretVault;
}

/** Collects events pushed at the renderer. */
function makeSink() {
  const events: GatewayChatEvent[] = [];
  const sink = () => ({ send: (_channel: string, payload: GatewayChatEvent) => void events.push(payload) });
  return { events, sink };
}

/** A fetch stand-in that streams the given frames. */
function streamingFetch(frames: string[]): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

test("an explicit connection id wins and a bad one does not fall back to another account", () => {
  const hermes = connection({ id: "hermes-1" });
  const custom = connection({ id: "custom-1", provider: "custom-api", baseUrl: "http://127.0.0.1:1234/v1" });

  assert.equal(selectChatConnection([hermes, custom], "custom-1")?.id, "custom-1");
  // Silently routing an explicitly-chosen account's prompt somewhere else would send
  // the user's data to a gateway they did not pick.
  assert.equal(selectChatConnection([hermes, custom], "nope"), null);
});

test("the local proxy is preferred over a hand-typed endpoint when nothing is chosen", () => {
  const custom = connection({ id: "custom-1", provider: "custom-api", baseUrl: "http://127.0.0.1:1234/v1" });
  const hermes = connection({ id: "hermes-1" });

  assert.equal(selectChatConnection([custom, hermes])?.id, "hermes-1");
  assert.equal(selectChatConnection([custom])?.id, "custom-1");
});

test("only OpenAI-compatible providers with a usable status and an endpoint are eligible", () => {
  // A CLI-backed vendor connection cannot serve /v1 itself.
  assert.equal(selectChatConnection([connection({ provider: "claude-code" })]), null);
  // Something concluded these were broken.
  assert.equal(selectChatConnection([connection({ status: "expired" })]), null);
  assert.equal(selectChatConnection([connection({ status: "disconnected" })]), null);
  // Every connection starts unverified, so excluding it would make a fresh one unusable.
  assert.equal(selectChatConnection([connection({ status: "unverified" })])?.id, "conn-1");
  // custom-api has no default address, so without a baseUrl there is nowhere to send.
  assert.equal(selectChatConnection([connection({ provider: "custom-api" })]), null);
});

test("targets report whether a credential is stored without ever carrying one", () => {
  const service = new GatewayChatService(
    { listProviderConnections: () => [connection({ tokenReference: "provider-secret:1", accountLabel: "Local proxy" })] },
    makeVault({ "provider-secret:1": "super-secret-value" }),
    () => null,
  );

  const targets = service.listTargets();

  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "Local proxy");
  assert.equal(targets[0].hasCredential, true);
  // The hermes default address is filled in and normalized to exactly one /v1.
  assert.equal(targets[0].baseUrl, "http://127.0.0.1:8645/v1");
  assert.ok(!JSON.stringify(targets).includes("super-secret-value"), "no credential crosses the bridge");
});

test("a connection with no resolvable endpoint is not offered as a target", () => {
  const service = new GatewayChatService(
    { listProviderConnections: () => [connection({ provider: "custom-api" })] },
    makeVault(),
    () => null,
  );

  assert.deepEqual(service.listTargets(), []);
});

test("with no gateway configured the failure names that, not a missing key", async () => {
  const { events, sink } = makeSink();
  const service = new GatewayChatService({ listProviderConnections: () => [] }, makeVault(), sink, {
    fetchImpl: (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch,
  });

  const result = await service.sendChat({
    requestId: "req-1",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "no-connection");
  // The failure is also announced, so a subscriber that missed the promise still learns.
  assert.equal(events.at(-1)?.type, "gateway:chat-error");
});

test("a streamed reply emits deltas then a terminal completion event", async () => {
  const { events, sink } = makeSink();
  const service = new GatewayChatService(
    { listProviderConnections: () => [connection()] },
    makeVault(),
    sink,
    { fetchImpl: streamingFetch([delta("Hel"), delta("lo"), "data: [DONE]\n\n"]) },
  );

  const result = await service.sendChat({
    requestId: "req-2",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(result.ok);
  assert.equal(result.data.text, "Hello");

  assert.deepEqual(
    events.filter((event) => event.type === "gateway:chat-delta").map((event) => event.delta),
    ["Hel", "lo"],
  );
  const done = events.at(-1);
  assert.equal(done?.type, "gateway:chat-done");
  assert.equal(done?.requestId, "req-2");
  assert.equal(done?.completion?.text, "Hello");
});

test("the stored credential is sent upstream but never returned to a caller", async () => {
  let seenAuth = "";
  const secret = ["sk", "vault", "value"].join("-");
  const service = new GatewayChatService(
    { listProviderConnections: () => [connection({ tokenReference: "provider-secret:1" })] },
    makeVault({ "provider-secret:1": secret }),
    () => null,
    {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
  );

  const result = await service.sendChat({
    requestId: "req-3",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.equal(seenAuth, `Bearer ${secret}`);
  assert.ok(result.ok);
  assert.ok(!JSON.stringify(result).includes(secret), "the completion carries no credential");
});

test("a gateway with no stored key still gets a bearer, because the SDKs require one", async () => {
  let seenAuth = "";
  const service = new GatewayChatService(
    { listProviderConnections: () => [connection()] },
    makeVault(),
    () => null,
    {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
  );

  await service.sendChat({
    requestId: "req-4",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.match(seenAuth, /^Bearer \S+/);
});

test("a locked keychain degrades to the placeholder bearer instead of failing the request", async () => {
  const throwingVault = {
    save: () => "provider-secret:1",
    read: () => {
      throw new Error("keychain locked");
    },
    delete: () => {},
  } as unknown as ProviderSecretVault;

  const service = new GatewayChatService(
    { listProviderConnections: () => [connection({ tokenReference: "provider-secret:1" })] },
    throwingVault,
    () => null,
    {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch,
    },
  );

  const result = await service.sendChat({
    requestId: "req-5",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.ok(result.ok);
});

test("cancel stops a live stream and the partial text is still returned", async () => {
  const { events, sink } = makeSink();
  let service: GatewayChatService;
  const encoder = new TextEncoder();

  // Pull-based so the first frame is genuinely delivered before the cancel lands;
  // erroring a stream discards anything still queued.
  let served = 0;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (served === 0) {
            served += 1;
            controller.enqueue(encoder.encode(delta("first-")));
            return;
          }
          // Cancel through the public API, which is the path the UI uses.
          const stopped = service.cancel("req-6");
          assert.equal(stopped, true, "an in-flight request must be findable by id");
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), sink, { fetchImpl });

  const result = await service.sendChat({
    requestId: "req-6",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(result.ok);
  assert.equal(result.data.text, "first-");
  assert.equal(result.data.cancelled, true);
  assert.equal(events.at(-1)?.completion?.cancelled, true);
  // The registry is cleared before the caller sees the result, so an immediate
  // retry with the same id is not rejected as already running.
  assert.equal(service.isRunning("req-6"), false);
});

test("cancelling an unknown id reports false rather than pretending it worked", () => {
  const service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), () => null);

  // "Already finished" and "cancelled" are different outcomes for the UI.
  assert.equal(service.cancel("never-existed"), false);
});

test("a duplicate request id is refused instead of orphaning the first request", async () => {
  const service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), () => null, {
    fetchImpl: (async () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })),
          50,
        );
      })) as unknown as typeof fetch,
  });

  const first = service.sendChat({
    requestId: "req-7",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  // Overwriting the registry entry would leave the first stream uncancellable.
  const second = await service.sendChat({
    requestId: "req-7",
    model: "m",
    messages: [{ role: "user", content: "again" }],
    stream: false,
  });

  assert.ok(!second.ok);
  assert.match(second.error.message, /already running/);
  assert.ok((await first).ok);
});

test("a request with no id is refused without emitting an event nobody can correlate", async () => {
  const { events, sink } = makeSink();
  const service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), sink);

  const result = await service.sendChat({ requestId: "  ", model: "m", messages: [{ role: "user", content: "hi" }] });

  assert.ok(!result.ok);
  assert.deepEqual(events, []);
});

test("stopAll aborts everything and silences emission for the quit path", async () => {
  const { events, sink } = makeSink();
  const service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), sink, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch,
  });

  service.stopAll();
  await service.sendChat({
    requestId: "req-8",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  // Same write-after-close class the process manager hit: nothing may be pushed at a
  // webContents that is being destroyed.
  assert.deepEqual(events, []);
});

test("a 401 from the gateway is reported as a credential problem", async () => {
  const service = new GatewayChatService({ listProviderConnections: () => [connection()] }, makeVault(), () => null, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch,
  });

  const result = await service.sendChat({
    requestId: "req-9",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.ok(!result.ok);
  assert.equal(result.error.kind, "unauthorized");
  assert.equal(result.error.statusCode, 401);
});
