import type { GatewayUsageError, GatewayUsageErrorKind } from "@contracts";

/**
 * Presentation helpers for the gateway credit panel.
 *
 * Split out of the component so the formatting and the state machine can be tested
 * without rendering React. The panel itself then contains only markup and the poll
 * lifecycle, which is the part tests would have to spin up a DOM for anyway.
 */

/** Balance fraction at or below which the panel warns. */
export const LOW_BALANCE_PERCENT = 15;

/** Formats USD. Small balances keep more precision than a currency formatter gives. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const absolute = Math.abs(value);
  // Sub-cent spend is normal on a per-request basis, and rounding it to "$0.00"
  // makes a working meter look broken.
  if (absolute > 0 && absolute < 0.01) return `$${value.toFixed(4)}`;
  if (absolute < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compacts token counts: 1.2M reads faster than 1,234,567 in a stat tile. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Math.round(value).toLocaleString();
}

export function formatLatency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

/** Relative timestamp. Mirrors the helper IntegrationsModule already uses. */
export function formatRelativeTime(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export type BalanceTone = "critical" | "low" | "healthy";

/**
 * Grades a balance for the meter's colour and warning copy.
 *
 * `exhausted` wins over the percentage because the gateway starts refusing requests
 * on its own flag; a panel that showed "healthy" while calls 402'd would be worse
 * than showing nothing.
 */
export function gradeBalance(input: { exhausted: boolean; percentRemaining: number }): BalanceTone {
  if (input.exhausted || input.percentRemaining <= 0) return "critical";
  if (input.percentRemaining <= LOW_BALANCE_PERCENT) return "low";
  return "healthy";
}

/** Per-request status pill class, kept to the three the CSS styles. */
export function statusTone(status: string): "ok" | "warn" | "fail" {
  const normalized = status.trim().toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") return "ok";
  if (normalized === "error" || normalized === "failed" || normalized === "failure") return "fail";
  return "warn";
}

export type GatewayPanelCopy = {
  title: string;
  detail: string;
  /** Label for the recovery button, when one would actually help. */
  action?: "settings" | "retry";
};

/**
 * Turns a typed error into user-facing copy.
 *
 * Each kind gets its own instruction because the fixes differ, and the raw message
 * is only ever appended for the cases where the gateway's own wording adds
 * something. `unreachable` deliberately drops it — "fetch failed ECONNREFUSED
 * 127.0.0.1:5100" is noise to the person who just needs to start the gateway.
 */
export function describeUsageError(error: GatewayUsageError): GatewayPanelCopy {
  const kind: GatewayUsageErrorKind = error.kind;
  switch (kind) {
    case "not-configured":
      return {
        title: "Not connected",
        detail: "Add your Pool API key to track credit, spend, and request history here.",
        action: "settings",
      };
    case "unauthorized":
      return {
        title: "Key rejected",
        detail: error.message || "The gateway rejected this API key.",
        action: "settings",
      };
    case "unreachable":
      return {
        title: "Gateway unreachable",
        detail: "The gateway is not answering. Check that it is running, then retry.",
        action: "retry",
      };
    case "server-error":
    default:
      return {
        title: "Gateway error",
        detail: error.message || "The gateway could not return usage right now.",
        action: "retry",
      };
  }
}

/**
 * True when the account exists but has never been used.
 *
 * Distinguished from a failed fetch so the panel can say "no requests yet" instead
 * of rendering a wall of zeros that looks like a bug.
 */
export function isBrandNewAccount(input: { lifetimeRequests: number; todayRequests: number }): boolean {
  return input.lifetimeRequests <= 0 && input.todayRequests <= 0;
}
