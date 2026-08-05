import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Inbound HTTP listener for `webhook` workflow triggers.
 *
 * This is the first thing in the app that opens a port, so the defaults are the
 * conservative ones:
 *
 * - **Loopback only.** Bound to `127.0.0.1`, never `0.0.0.0`. Nothing on the LAN
 *   can reach it, and on macOS/Windows binding loopback does not raise the firewall
 *   prompt that binding a public interface does. Remote delivery is still possible,
 *   but only if the user deliberately tunnels (`ssh -R`, `cloudflared`) — which is
 *   their explicit choice rather than something the app did to them silently.
 * - **Token required.** Every request must carry the local token. Any process on the
 *   machine can reach a loopback port, so "local" is not by itself a trust boundary.
 * - **Off unless used.** The caller only starts this when an active webhook workflow
 *   exists, so a user who never touches webhooks never has a port open.
 *
 * Deliberately not implemented here: provider-specific signature verification
 * (GitHub's `X-Hub-Signature-256`, Stripe's `Stripe-Signature`). Those need a
 * per-workflow shared secret and a provider-specific canonicalisation, and getting
 * one wrong yields a check that looks secure and is not. The shared local token is
 * honest about what it does.
 */

/** Requests larger than this are refused before the body is buffered. */
const MAX_BODY_BYTES = 1024 * 1024;

/** How long the server gets to close before a stop gives up waiting on it. */
const CLOSE_TIMEOUT_MS = 2_000;

export type WebhookDelivery = {
  /** Trailing path segment after `/hooks/`, used to select the workflow. */
  hook: string;
  /** Parsed JSON body, or the raw string when the body is not JSON. */
  payload: unknown;
  /** Raw body, capped at `MAX_BODY_BYTES`. */
  raw: string;
  receivedAt: Date;
};

export type WebhookDeliveryResult = {
  /** Workflow ids started by this delivery. */
  fired: string[];
};

export type WebhookListenerOptions = {
  /** 0 lets the OS choose, which is what tests use to avoid port collisions. */
  port?: number;
  /** Injected so tests can pin a value; generated and persisted by the caller otherwise. */
  token: string;
  /** Invoked once per authenticated delivery. */
  onDelivery: (delivery: WebhookDelivery) => Promise<WebhookDeliveryResult>;
  /** Surfaces listener-level problems (port in use) to the UI log. */
  onError?: (message: string) => void;
};

export type WebhookListenerStatus = {
  running: boolean;
  port: number | null;
  /** The URL a caller should POST to, minus the hook segment. */
  baseUrl: string | null;
  /** Why the listener is not running, when it should be. */
  error: string | null;
};

/** Generates a token with enough entropy that guessing it is not a threat model. */
export function generateWebhookToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compares two tokens without leaking their common prefix through timing.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be a length
 * oracle, so the lengths are checked first and a mismatch returns early with no
 * comparison at all.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reads the bearer token from either `Authorization` or the `X-Webhook-Token` header. */
function extractToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const alternate = request.headers["x-webhook-token"];
  if (typeof alternate === "string") return alternate.trim();
  return "";
}

export class WebhookListenerService {
  private server: Server | null = null;
  private port: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: WebhookListenerOptions) {}

  status(): WebhookListenerStatus {
    return {
      running: this.server !== null,
      port: this.port,
      baseUrl: this.port === null ? null : `http://127.0.0.1:${this.port}/hooks`,
      error: this.lastError,
    };
  }

  /** Starts the listener, or resolves immediately when it is already running. */
  async start(): Promise<WebhookListenerStatus> {
    if (this.server) return this.status();

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    // A port already in use is the expected failure (a second app instance, or the
    // user's own service). It must not crash the app, and the reason has to reach
    // the UI, otherwise webhooks silently never arrive.
    const listening = new Promise<WebhookListenerStatus>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        const detail =
          error.code === "EADDRINUSE"
            ? `Port ${this.options.port ?? 0} is already in use. Close the other process or pick a different port.`
            : error.message;
        this.lastError = detail;
        this.options.onError?.(`⚠ Webhook listener could not start: ${detail}`);
        this.server = null;
        this.port = null;
        resolve(this.status());
      };

      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : null;
        this.lastError = null;
        this.server = server;
        // Errors after startup (a dropped socket) must not take the process down.
        server.on("error", (late: Error) => {
          this.options.onError?.(`⚠ Webhook listener error: ${late.message}`);
        });
        resolve(this.status());
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port ?? 0, "127.0.0.1");
    });

    return listening;
  }

  /** Stops the listener and waits for in-flight connections to finish closing. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;

    await new Promise<void>((resolve) => {
      // `close` waits for keep-alive connections, which a webhook client may hold
      // open. The app must not hang on quit because of one, so the wait is bounded.
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeAllConnections?.();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST") {
        return respond(response, 405, { error: "Only POST is accepted." });
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/hooks\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname);
      if (!match) {
        return respond(response, 404, { error: "Unknown hook path. Use /hooks/<name>." });
      }

      // Authenticate before reading the body: an unauthenticated caller should not
      // be able to make the app buffer a megabyte per request.
      if (!tokensMatch(extractToken(request), this.options.token)) {
        return respond(response, 401, { error: "Missing or invalid webhook token." });
      }

      const declared = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return respond(response, 413, { error: "Body too large." });
      }

      const raw = await readBody(request);
      if (raw === null) {
        return respond(response, 413, { error: "Body too large." });
      }

      const delivery: WebhookDelivery = {
        hook: match[1],
        payload: parseMaybeJson(raw),
        raw,
        receivedAt: new Date(),
      };

      const result = await this.options.onDelivery(delivery);
      // 202 rather than 200: the workflow was accepted and runs asynchronously, so
      // the sender should not read this as "the work finished".
      return respond(response, 202, { accepted: true, fired: result.fired });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`⚠ Webhook delivery failed: ${message}`);
      // Never echo the error text back: it can carry local paths or internals to a
      // caller that only proved it holds the token.
      return respond(response, 500, { error: "Delivery failed." });
    }
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Buffers the body, returning null when it exceeds the cap mid-stream. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A lying or absent content-length is the reason this is checked again here.
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** JSON when the body parses, the original string otherwise. */
function parseMaybeJson(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
