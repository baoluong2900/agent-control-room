/**
 * Streaming chat completions against an OpenAI-compatible gateway.
 *
 * Phase 3 of `docs/feature/ai-gateway-sidecar.md`. Every workflow step and agent run
 * so far spawns a CLI; this is the second transport, and it is modelled as a
 * *request with an id* rather than a promise of text so cancellation has something
 * to name. A CLI run is cancelled by signalling a pid — an HTTP stream has no pid,
 * so the id issued here is the handle.
 *
 * The credential never appears in these types. The main process reads it from the
 * secret vault per request, exactly as `GatewayUsageService` does.
 */

export type GatewayChatRole = "system" | "user" | "assistant";

export interface GatewayChatMessage {
  role: GatewayChatRole;
  content: string;
}

export interface GatewayChatRequest {
  /**
   * Caller-issued handle used to cancel and to correlate stream events.
   *
   * Supplied by the caller rather than returned, because a renderer has to be able
   * to cancel a request whose *response* has not arrived yet — an id that only came
   * back with the completion would leave the first seconds uncancellable.
   */
  requestId: string;
  /**
   * Which provider connection to route through. Omitted means "pick the first
   * OpenAI-compatible one", which is what a user with a single proxy expects.
   */
  connectionId?: string;
  /** Model label passed straight through; the gateway owns the catalogue. */
  model: string;
  messages: GatewayChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** False sends `stream: false` and resolves in one shot. Defaults to true. */
  stream?: boolean;
}

/**
 * Why a chat call produced no completion.
 *
 * Shares four kinds with `GatewayUsageErrorKind` on purpose — they describe the
 * same four failure situations for the same transport — and adds two this path can
 * reach that a dashboard read cannot: a user-initiated `cancelled`, and
 * `no-connection` for "there is no gateway configured to route through", which is
 * a different fix from "the configured one rejected the key".
 */
export type GatewayChatErrorKind =
  | "no-connection"
  | "not-configured"
  | "unauthorized"
  | "unreachable"
  | "server-error"
  | "cancelled";

export interface GatewayChatError {
  kind: GatewayChatErrorKind;
  /** Human-readable, already scrubbed of anything key-shaped. */
  message: string;
  statusCode?: number;
}

/** Token accounting, when the gateway reports it. Null when it does not. */
export interface GatewayChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GatewayChatCompletion {
  requestId: string;
  /** Model the gateway said it used, which may differ from the one requested. */
  model: string;
  text: string;
  finishReason: string | null;
  usage: GatewayChatUsage | null;
  streamed: boolean;
  durationMs: number;
  /**
   * Time to first token. Null for a non-streamed call, where it was never
   * measured — zero would be a claim about a measurement nobody took.
   */
  ttftMs: number | null;
  /**
   * True when the caller stopped it. The partial text is still returned: the
   * tokens were generated and billed, so discarding them would be both a worse UI
   * and a less honest record.
   */
  cancelled: boolean;
}

export type GatewayChatResult =
  | { ok: true; data: GatewayChatCompletion }
  | { ok: false; error: GatewayChatError };

export type GatewayChatEventType = "gateway:chat-delta" | "gateway:chat-done" | "gateway:chat-error";

/**
 * Incremental progress pushed to the renderer while a stream runs.
 *
 * Deltas are pushed rather than polled because the whole point of streaming is that
 * the caller sees tokens before the request ends. The terminal `done`/`error` event
 * carries the same payload the `sendChat` promise resolves with, so a subscriber
 * that missed the promise still learns the outcome.
 */
export interface GatewayChatEvent {
  type: GatewayChatEventType;
  requestId: string;
  /** Present on `gateway:chat-delta`: the newly generated text only. */
  delta?: string;
  /** Present on `gateway:chat-done`. */
  completion?: GatewayChatCompletion;
  /** Present on `gateway:chat-error`. */
  error?: GatewayChatError;
  timestamp: string;
}

/** A gateway route the user can send a prompt through. */
export interface GatewayChatTarget {
  connectionId: string;
  /** Display label: the account label, falling back to the provider id. */
  label: string;
  provider: string;
  baseUrl: string;
  /** Whether a credential is stored. Gateways often need none. */
  hasCredential: boolean;
}
