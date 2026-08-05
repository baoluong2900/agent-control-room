import assert from "node:assert/strict";
import test from "node:test";
import type { WebhookDelivery } from "../src/main/workflows/webhook-listener.ts";
import { WebhookListenerService, generateWebhookToken } from "../src/main/workflows/webhook-listener.ts";

const TOKEN = "test-token-0123456789abcdef";

type Harness = {
  baseUrl: string;
  deliveries: WebhookDelivery[];
  errors: string[];
  post: (path: string, body?: string, headers?: Record<string, string>) => Promise<Response>;
};

/** Starts a real listener on an OS-assigned port and tears it down after the test. */
async function listener(
  t: { after: (fn: () => unknown) => void },
  options: { fired?: string[] } = {},
): Promise<Harness> {
  const deliveries: WebhookDelivery[] = [];
  const errors: string[] = [];

  const service = new WebhookListenerService({
    port: 0,
    token: TOKEN,
    onDelivery: async (delivery) => {
      deliveries.push(delivery);
      return { fired: options.fired ?? ["wf-1"] };
    },
    onError: (message) => errors.push(message),
  });

  const status = await service.start();
  assert.ok(status.running && status.baseUrl, "listener bound to a port");
  t.after(() => service.stop());

  const post = (path: string, body = "{}", headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${status.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body,
    });

  return { baseUrl: status.baseUrl as string, deliveries, errors, post };
}

test("a valid delivery is accepted and passed on", async (t) => {
  const harness = await listener(t);

  const response = await harness.post("/hooks/deploy", JSON.stringify({ ref: "refs/heads/main" }));

  assert.equal(response.status, 202, "202, not 200: the run is asynchronous");
  assert.deepEqual(await response.json(), { accepted: true, fired: ["wf-1"] });
  assert.equal(harness.deliveries.length, 1);
  assert.equal(harness.deliveries[0].hook, "deploy");
  assert.deepEqual(harness.deliveries[0].payload, { ref: "refs/heads/main" });
});

test("the listener binds loopback only", async (t) => {
  const harness = await listener(t);

  // Binding 0.0.0.0 would expose the port to the LAN and trip the OS firewall
  // prompt. The URL handed to the user must be the loopback one.
  assert.match(harness.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/hooks$/);
});

test("a request without a token is rejected", async (t) => {
  const harness = await listener(t);

  const response = await fetch(`${harness.baseUrl}/deploy`, {
    method: "POST",
    body: "{}",
  });

  // Any local process can reach a loopback port, so "local" is not a trust
  // boundary on its own.
  assert.equal(response.status, 401);
  assert.deepEqual(harness.deliveries, [], "and nothing ran");
});

test("a request with the wrong token is rejected", async (t) => {
  const harness = await listener(t);

  for (const bad of ["", "wrong", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase()]) {
    const response = await harness.post("/hooks/deploy", "{}", { authorization: `Bearer ${bad}` });
    assert.equal(response.status, 401, `token "${bad}" must not be accepted`);
  }
  assert.deepEqual(harness.deliveries, []);
});

test("the token is also accepted from X-Webhook-Token", async (t) => {
  const harness = await listener(t);

  // Some senders cannot set Authorization freely; a second header keeps them usable
  // without weakening the check.
  const response = await fetch(`${harness.baseUrl}/deploy`, {
    method: "POST",
    headers: { "x-webhook-token": TOKEN },
    body: "{}",
  });

  assert.equal(response.status, 202);
});

test("non-POST methods are refused", async (t) => {
  const harness = await listener(t);

  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await fetch(`${harness.baseUrl}/deploy`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 405, `${method} must not deliver`);
  }
  assert.deepEqual(harness.deliveries, []);
});

test("unknown and malformed paths do not reach a workflow", async (t) => {
  const harness = await listener(t);

  for (const path of ["/", "/hooks", "/hooks/", "/other/deploy", "/hooks/a/b"]) {
    const response = await harness.post(path);
    assert.equal(response.status, 404, `${path} must not be treated as a hook`);
  }

  // Path traversal in the hook segment must not be mistaken for a hook name.
  const traversal = await harness.post("/hooks/..%2F..%2Fetc");
  assert.equal(traversal.status, 404);
  assert.deepEqual(harness.deliveries, []);
});

test("a non-JSON body is delivered as raw text rather than rejected", async (t) => {
  const harness = await listener(t);

  const response = await harness.post("/hooks/deploy", "plain text payload", {
    "content-type": "text/plain",
  });

  // Not every sender posts JSON; dropping those would silently lose deliveries.
  assert.equal(response.status, 202);
  assert.equal(harness.deliveries[0].payload, "plain text payload");
  assert.equal(harness.deliveries[0].raw, "plain text payload");
});

test("an oversized body is refused before it is buffered", async (t) => {
  const harness = await listener(t);

  const response = await harness.post("/hooks/deploy", "x".repeat(2 * 1024 * 1024), {
    "content-type": "text/plain",
  });

  assert.equal(response.status, 413);
  assert.deepEqual(harness.deliveries, [], "an oversized body never reaches a workflow");
});

test("a body that lies about its content-length is still capped", async (t) => {
  const harness = await listener(t);

  // The declared length is checked first, but a sender can understate it, so the
  // stream is counted as it arrives too.
  const response = await fetch(`${harness.baseUrl}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    body: "y".repeat(2 * 1024 * 1024),
  }).catch((error: Error) => error);

  // The server destroys the request, so either a 413 or a transport error is a
  // correct outcome; what matters is that nothing was delivered.
  if (response instanceof Response) {
    assert.equal(response.status, 413);
  }
  assert.deepEqual(harness.deliveries, []);
});

test("a throwing handler returns 500 without leaking the reason", async (t) => {
  const service = new WebhookListenerService({
    port: 0,
    token: TOKEN,
    onDelivery: async () => {
      throw new Error("/Users/someone/secret/path exploded");
    },
  });
  const status = await service.start();
  t.after(() => service.stop());

  const response = await fetch(`http://127.0.0.1:${status.port}/hooks/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });

  assert.equal(response.status, 500);
  const body = await response.text();
  // The caller only proved it holds the token; it does not get local paths back.
  assert.equal(body.includes("secret/path"), false, "internal detail must not be echoed");
});

test("a port already in use fails cleanly instead of throwing", async (t) => {
  const first = new WebhookListenerService({ port: 0, token: TOKEN, onDelivery: async () => ({ fired: [] }) });
  const firstStatus = await first.start();
  t.after(() => first.stop());

  const errors: string[] = [];
  const second = new WebhookListenerService({
    port: firstStatus.port as number,
    token: TOKEN,
    onDelivery: async () => ({ fired: [] }),
    onError: (message) => errors.push(message),
  });

  const status = await second.start();

  // The app must survive this: a second instance, or the user's own service on the
  // port, is ordinary — and the reason has to reach the UI or webhooks just never
  // arrive with no explanation.
  assert.equal(status.running, false);
  assert.match(status.error ?? "", /already in use/i);
  assert.equal(errors.length, 1);
});

test("stop closes the port so a restart can rebind it", async (t) => {
  const service = new WebhookListenerService({ port: 0, token: TOKEN, onDelivery: async () => ({ fired: [] }) });
  const status = await service.start();
  const port = status.port as number;

  await service.stop();
  assert.equal(service.status().running, false);

  // Rebinding the same port proves the socket was really released, not just marked
  // stopped — which is what keeps the quit path from leaking a listener.
  const again = new WebhookListenerService({ port, token: TOKEN, onDelivery: async () => ({ fired: [] }) });
  const restarted = await again.start();
  t.after(() => again.stop());

  assert.equal(restarted.running, true);
  assert.equal(restarted.port, port);
});

test("generated tokens are long and unique", () => {
  const a = generateWebhookToken();
  const b = generateWebhookToken();

  assert.equal(a.length, 64, "32 bytes of hex");
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]+$/);
});
