import type { GatewayChatCompletion, GatewayChatError, GatewayChatTarget } from "@contracts";

/**
 * Presentation helpers for the gateway chat panel.
 *
 * Split out of the component for the same reason as `gateway-usage-ui.ts`: the state
 * machine and the copy are the parts worth asserting, and asserting them here needs
 * no DOM. The component keeps only markup and the subscription lifecycle.
 */

/** What the panel is doing right now. */
export type ChatPhase = "idle" | "sending" | "streaming" | "done" | "cancelled" | "error";

export type ChatPanelCopy = {
  title: string;
  detail: string;
  /** Recovery affordance, when one would actually help. */
  action?: "settings" | "retry";
};

/**
 * Turns a typed chat error into user-facing copy.
 *
 * `no-connection` and `not-configured` both point at Settings but say different
 * things: one means "you have no gateway at all", the other "the one you picked has
 * no endpoint". Collapsing them would send a user hunting for a key they already
 * saved. `cancelled` gets no action at all — the user did it on purpose.
 */
export function describeChatError(error: GatewayChatError): ChatPanelCopy {
  switch (error.kind) {
    case "no-connection":
      return {
        title: "No gateway connection",
        detail: error.message || "Add an OpenAI-compatible connection in Settings to route prompts through it.",
        action: "settings",
      };
    case "not-configured":
      return {
        title: "Endpoint missing",
        detail: error.message || "That connection has no endpoint configured.",
        action: "settings",
      };
    case "unauthorized":
      return {
        title: "Credential rejected",
        detail: error.message || "The gateway rejected this credential.",
        action: "settings",
      };
    case "unreachable":
      return {
        title: "Gateway unreachable",
        detail: "The gateway is not answering. Check that it is running, then retry.",
        action: "retry",
      };
    case "cancelled":
      return {
        title: "Cancelled",
        detail: error.message || "The request was cancelled.",
      };
    case "server-error":
    default:
      return {
        title: "Gateway error",
        detail: error.message || "The gateway could not complete this request.",
        action: "retry",
      };
  }
}

/**
 * One-line summary of a finished completion.
 *
 * Time to first token is only shown when it was measured. A non-streamed call never
 * measures it, and printing "0 ms" there would claim a latency nobody observed.
 */
export function describeCompletion(completion: GatewayChatCompletion): string {
  const parts = [`${(completion.durationMs / 1_000).toFixed(2)}s`];
  if (completion.ttftMs !== null) parts.push(`first token ${Math.round(completion.ttftMs)}ms`);
  if (completion.usage) parts.push(`${completion.usage.totalTokens.toLocaleString()} tokens`);
  parts.push(completion.model);
  if (completion.cancelled) parts.push("stopped early");
  return parts.join(" · ");
}

/** Label for a routing option. Says when a gateway carries no stored credential. */
export function describeTarget(target: GatewayChatTarget): string {
  const suffix = target.hasCredential ? "" : " · no stored key";
  return `${target.label} — ${target.baseUrl}${suffix}`;
}

/**
 * Whether the Send button should be disabled.
 *
 * A blank prompt, a request already running, or no route to send it through are
 * three separate reasons, and each is reported by `sendBlockedReason` so the UI can
 * explain itself rather than presenting a dead button.
 */
export function sendBlockedReason(input: {
  prompt: string;
  phase: ChatPhase;
  targets: GatewayChatTarget[];
}): string | null {
  if (input.phase === "sending" || input.phase === "streaming") return "A request is already running.";
  if (input.targets.length === 0) return "No gateway connection is available.";
  if (!input.prompt.trim()) return "Type a prompt first.";
  return null;
}

/** True while a request is live, i.e. while Cancel is meaningful. */
export function isActive(phase: ChatPhase): boolean {
  return phase === "sending" || phase === "streaming";
}
