import type {
  GatewayChatCompletion,
  GatewayChatError,
  GatewayChatEvent,
  GatewayChatRequest,
  GatewayChatResult,
  GatewayChatTarget,
  ProviderConnection,
} from "@contracts";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";
import { resolveConnectionBaseUrl } from "../agents/provider-runtime-env";
import { normalizeChatBaseUrl, requestChatCompletion } from "./gateway-chat-client";

/**
 * Routes chat completions through a configured gateway connection.
 *
 * The counterpart to `gateway-chat-client.ts`: the client is pure transport, this is
 * the only place that reads the vault, picks a connection, and owns the in-flight
 * registry that makes cancellation possible. Same split as the usage pair, for the
 * same reason — "where does the credential live" stays answerable in one file.
 *
 * Cancellation is why this class holds state at all. A CLI run is stopped by
 * signalling a pid; an HTTP stream has no pid, so an `AbortController` per request id
 * is the handle, and the registry is what lets a later `cancel(requestId)` find it.
 */

/** Providers that *are* an OpenAI-compatible endpoint rather than a vendor CLI. */
const GATEWAY_PROVIDERS: ReadonlySet<ProviderConnection["provider"]> = new Set(["hermes-agent", "custom-api"]);

/**
 * Statuses a connection may be routed through.
 *
 * `unverified` is included for the same reason `provider-runtime-env` includes it:
 * every connection starts there, and excluding it would make a freshly saved
 * endpoint unusable until the user clicked Verify. Only states something actually
 * concluded were broken are withheld.
 */
const USABLE_STATUSES: ReadonlySet<ProviderConnection["status"]> = new Set(["connected", "unverified"]);

export type ChatConnectionSource = {
  listProviderConnections(): ProviderConnection[];
};

/** Pushes stream progress at the renderer. Returns null when no window is alive. */
export type ChatEventSink = () => { send(channel: string, payload: GatewayChatEvent): void } | null;

export type GatewayChatServiceOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * Selects the connection to route through.
 *
 * Exported and pure so the preference order is testable without a database: an
 * explicit id always wins (and a bad one is an error rather than a silent fallback
 * to some other account), then `hermes-agent` ahead of `custom-api` because a local
 * proxy is the case that needs no typing.
 */
export function selectChatConnection(
  connections: ProviderConnection[],
  requestedId?: string,
): ProviderConnection | null {
  const usable = connections.filter(
    (connection) =>
      GATEWAY_PROVIDERS.has(connection.provider) &&
      USABLE_STATUSES.has(connection.status) &&
      Boolean(resolveConnectionBaseUrl(connection)),
  );

  if (requestedId?.trim()) {
    return usable.find((connection) => connection.id === requestedId.trim()) ?? null;
  }

  for (const provider of ["hermes-agent", "custom-api"] as const) {
    const match = usable.find((connection) => connection.provider === provider);
    if (match) return match;
  }
  return null;
}

export class GatewayChatService {
  /** Live requests by id, so `cancel` has something to abort. */
  private readonly inFlight = new Map<string, AbortController>();
  /** Set on quit so a late stream cannot emit into a closing app. */
  private shuttingDown = false;

  constructor(
    private readonly connections: ChatConnectionSource,
    private readonly secretVault: ProviderSecretVault,
    private readonly sink: ChatEventSink,
    private readonly options: GatewayChatServiceOptions = {},
  ) {}

  /**
   * Gateway routes available to the user.
   *
   * Reports `hasCredential` rather than the credential: a gateway that authenticates
   * upstream on the user's behalf needs none, so its absence is not an error and the
   * UI should not present it as one.
   */
  listTargets(): GatewayChatTarget[] {
    return this.connections
      .listProviderConnections()
      .filter((connection) => GATEWAY_PROVIDERS.has(connection.provider) && USABLE_STATUSES.has(connection.status))
      .flatMap((connection) => {
        const baseUrl = resolveConnectionBaseUrl(connection);
        if (!baseUrl) return [];
        return [
          {
            connectionId: connection.id,
            label: connection.accountLabel?.trim() || connection.provider,
            provider: connection.provider,
            baseUrl: normalizeChatBaseUrl(baseUrl),
            hasCredential: Boolean(connection.tokenReference?.trim()),
          } satisfies GatewayChatTarget,
        ];
      });
  }

  /** True while a request with this id is running. */
  isRunning(requestId: string): boolean {
    return this.inFlight.has(requestId);
  }

  /**
   * Sends one prompt and resolves with the completion, streaming deltas as events.
   *
   * Always resolves. A rejection here would cross the IPC bridge as an `Error` whose
   * stack carries main-process paths, and every caller would need its own try/catch.
   */
  async sendChat(request: GatewayChatRequest): Promise<GatewayChatResult> {
    const requestId = request.requestId?.trim();
    if (!requestId) {
      return this.fail("", { kind: "server-error", message: "A chat request needs a request id." });
    }
    if (this.inFlight.has(requestId)) {
      return this.fail(requestId, {
        kind: "server-error",
        message: `A request with id ${requestId} is already running.`,
      });
    }

    const connection = selectChatConnection(this.connections.listProviderConnections(), request.connectionId);
    if (!connection) {
      return this.fail(requestId, {
        kind: "no-connection",
        message: request.connectionId
          ? "That gateway connection is not available. Check it in Settings."
          : "No gateway connection is configured. Add one in Settings to send prompts through it.",
      });
    }

    const baseUrl = resolveConnectionBaseUrl(connection);
    if (!baseUrl) {
      return this.fail(requestId, {
        kind: "not-configured",
        message: "That connection has no endpoint configured.",
      });
    }

    const controller = new AbortController();
    this.inFlight.set(requestId, controller);

    try {
      const result = await requestChatCompletion(
        {
          requestId,
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          stream: request.stream,
          signal: controller.signal,
          onDelta: (delta) => this.emit({ type: "gateway:chat-delta", requestId, delta }),
        },
        {
          baseUrl,
          apiKey: this.readCredential(connection),
          fetchImpl: this.options.fetchImpl,
          timeoutMs: this.options.timeoutMs,
          now: this.options.now,
        },
      );

      if (result.ok) return this.succeed(result.data);
      return this.fail(requestId, result.error);
    } finally {
      // Cleared before the caller sees the result, so a UI that immediately retries
      // the same id is not told it is still running.
      this.inFlight.delete(requestId);
    }
  }

  /**
   * Stops an in-flight request.
   *
   * Returns whether anything was actually aborted. Reporting false for an unknown id
   * matters: it distinguishes "cancelled" from "already finished", which a UI shows
   * differently, and it is the honest answer when a request completed a tick before
   * the click landed.
   */
  cancel(requestId: string): boolean {
    const controller = this.inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Aborts everything, for the quit path.
   *
   * `shuttingDown` is set first so an abort that resolves a stream cannot emit into
   * a window that is going away — the same write-after-close class the process
   * manager and the webhook listener both hit.
   */
  stopAll(): void {
    this.shuttingDown = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /**
   * Reads the connection's stored credential.
   *
   * Private, and there is no IPC channel that returns it. A missing or unreadable
   * secret degrades to an empty string rather than throwing: gateways that attach
   * their own upstream credentials accept any bearer, so an absent key is a normal
   * configuration, and the client supplies a placeholder.
   */
  private readCredential(connection: ProviderConnection): string {
    if (!connection.tokenReference?.trim()) return "";
    try {
      return this.secretVault.read(connection.tokenReference) ?? "";
    } catch {
      // The vault throws when the OS keychain is locked. From here that is
      // indistinguishable from "no key stored", and both mean "send the placeholder".
      return "";
    }
  }

  private succeed(completion: GatewayChatCompletion): GatewayChatResult {
    this.emit({ type: "gateway:chat-done", requestId: completion.requestId, completion });
    return { ok: true, data: completion };
  }

  private fail(requestId: string, error: GatewayChatError): GatewayChatResult {
    if (requestId) this.emit({ type: "gateway:chat-error", requestId, error });
    return { ok: false, error };
  }

  private emit(event: Omit<GatewayChatEvent, "timestamp">): void {
    if (this.shuttingDown) return;
    this.sink()?.send("gateway:chat-event", { ...event, timestamp: new Date().toISOString() });
  }
}
