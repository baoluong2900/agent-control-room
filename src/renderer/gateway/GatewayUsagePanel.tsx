import { AlertTriangle, Coins, Gauge, KeyRound, RefreshCw, Wallet } from "lucide-react";
import type { GatewayUsageSnapshot } from "@contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceNavKey } from "../workspace-navigation";
import {
  describeUsageError,
  formatCount,
  formatLatency,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  gradeBalance,
  isBrandNewAccount,
  statusTone,
  type GatewayPanelCopy,
} from "./gateway-usage-ui";
import "./gateway.css";

/**
 * Credit and usage for the Pool API gateway.
 *
 * Polls `gateway.getUsageSnapshot`, which resolves to a discriminated result rather
 * than rejecting, so there is no try/catch around the tick and no unhandled
 * rejection when a poll lands after unmount.
 *
 * Polling is tied to visibility twice over: the effect only runs while `visible` is
 * true (the parent unmounts or flags the panel when another module is on screen),
 * and the interval also stands down while the OS window is hidden. A desktop app
 * left open on another module for an hour should not have issued 360 requests.
 */

/** Poll cadence. Balance moves per-request, but this is a monitor, not a ticker. */
const POLL_INTERVAL_MS = 15_000;

type GatewayUsagePanelProps = {
  /** False while another module is on screen; stops the poll without unmounting. */
  visible?: boolean;
  onNavigate?: (nav: WorkspaceNavKey) => void;
};

export function GatewayUsagePanel({ visible = true, onNavigate }: GatewayUsagePanelProps) {
  const [snapshot, setSnapshot] = useState<GatewayUsageSnapshot | null>(null);
  const [problem, setProblem] = useState<GatewayPanelCopy | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Guards every setState behind "is this component still mounted".
   *
   * An in-flight fetch cannot be cancelled from here (the request lives in the main
   * process), so the resolution has to be discarded instead.
   */
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    // Optional-chained because the harnesses build the renderer without the full
    // preload surface; a missing bridge should render "not connected", not crash.
    const bridge = window.agentic?.gateway;
    if (!bridge) {
      if (mountedRef.current) {
        setProblem({
          title: "Unavailable",
          detail: "The gateway bridge is not available in this build.",
        });
        setLoading(false);
      }
      return;
    }

    try {
      const result = await bridge.getUsageSnapshot();
      if (!mountedRef.current) return;

      if (result.ok) {
        setSnapshot(result.data);
        setProblem(null);
      } else {
        setProblem(describeUsageError(result.error));
        // Deliberately keeps the last good snapshot on screen behind the banner:
        // a transient gateway restart should not blank out the numbers.
      }
    } catch (error) {
      // Reached only if the IPC channel itself is missing (no handler registered).
      if (!mountedRef.current) return;
      setProblem({
        title: "Unavailable",
        detail: error instanceof Error ? error.message : "Usage could not be loaded.",
        action: "retry",
      });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };

    // A hidden window still runs timers; pausing here is what keeps a backgrounded
    // app from polling all day.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    void refresh();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, refresh]);

  const overview = snapshot?.overview ?? null;
  const balance = overview?.balance ?? null;
  const tone = balance ? gradeBalance(balance) : "healthy";
  const empty = overview
    ? isBrandNewAccount({
        lifetimeRequests: overview.lifetime.requests,
        todayRequests: overview.today.requests,
      })
    : false;

  return (
    <section className="gateway-panel">
      <header className="gateway-panel-header">
        <div>
          <span className="gateway-eyebrow">
            <Coins size={13} />
            Pool API
          </span>
          <h2>Credit &amp; Usage</h2>
          <p>
            {snapshot
              ? `Updated ${formatRelativeTime(snapshot.fetchedAt)}${overview?.key.plan ? ` · ${overview.key.plan} plan` : ""}`
              : loading
                ? "Reading gateway balance…"
                : "No usage data yet."}
          </p>
        </div>
        <button className="gateway-link" onClick={() => void refresh()} type="button" disabled={loading}>
          <RefreshCw size={12} />
          Refresh
        </button>
      </header>

      {problem && (
        <div className={`gateway-banner ${problem.action === "settings" ? "info" : "error"}`}>
          <AlertTriangle size={14} />
          <span>
            <strong>{problem.title}</strong>
            <small>{problem.detail}</small>
          </span>
          {problem.action === "settings" && onNavigate && (
            <button className="gateway-link" onClick={() => onNavigate("Settings")} type="button">
              <KeyRound size={12} />
              Add key
            </button>
          )}
          {problem.action === "retry" && (
            <button className="gateway-link" onClick={() => void refresh()} type="button">
              <RefreshCw size={12} />
              Retry
            </button>
          )}
        </div>
      )}

      {balance && (
        <div className={`gateway-balance tone-${tone}`}>
          <div className="gateway-balance-head">
            <span>
              <Wallet size={15} />
              Available
            </span>
            <strong>{formatUsd(balance.availableUsd)}</strong>
          </div>
          <div className="gateway-meter" role="presentation">
            <span style={{ width: `${Math.max(0, Math.min(100, balance.percentRemaining))}%` }} />
          </div>
          <div className="gateway-balance-meta">
            <span>
              <strong>{formatUsd(balance.balanceUsd)}</strong>
              <small>Balance</small>
            </span>
            <span>
              <strong>{formatUsd(balance.creditLimitUsd)}</strong>
              <small>Credit line</small>
            </span>
            <span>
              <strong>{formatUsd(balance.spentTodayUsd)}</strong>
              <small>Spent today</small>
            </span>
            <span>
              <strong>{balance.percentRemaining.toFixed(1)}%</strong>
              <small>Remaining</small>
            </span>
          </div>
          {tone !== "healthy" && (
            <p className="gateway-warning">
              <AlertTriangle size={12} />
              {balance.exhausted
                ? "Credit is exhausted — the gateway will refuse new requests until it is topped up."
                : "Balance is running low. Top up to avoid interrupted requests."}
            </p>
          )}
        </div>
      )}

      {overview && (
        <div className="gateway-stat-grid">
          <StatTile label="Requests today" value={formatCount(overview.today.requests)} tone="blue" />
          <StatTile label="Tokens today" value={formatTokens(overview.today.totalTokens)} tone="cyan" />
          <StatTile label="Spend today" value={formatUsd(overview.today.costUsd)} tone="purple" />
          <StatTile label="Avg latency" value={formatLatency(overview.today.avgLatencyMs)} tone="green" />
        </div>
      )}

      {empty && (
        <p className="gateway-empty">
          <Gauge size={13} />
          No requests recorded yet. Usage appears here as soon as this key is used.
        </p>
      )}

      {overview && overview.byModel.length > 0 && (
        <div className="gateway-section">
          <h3>By model · last {overview.window.days} days</h3>
          <div className="gateway-model-list">
            {overview.byModel.slice(0, 6).map((entry) => (
              <article className="gateway-model-row" key={entry.model}>
                <div>
                  <strong>{entry.model}</strong>
                  <small>
                    {formatCount(entry.stats.requests)} req · {formatTokens(entry.stats.totalTokens)} tokens
                  </small>
                </div>
                <span className="gateway-model-cost">{formatUsd(entry.stats.costUsd)}</span>
              </article>
            ))}
          </div>
        </div>
      )}

      {snapshot && snapshot.recent.length > 0 && (
        <div className="gateway-section">
          <h3>Recent requests</h3>
          <div className="gateway-request-list">
            {snapshot.recent.slice(0, 8).map((entry) => (
              <article className="gateway-request-row" key={entry.requestId || `${entry.model}-${entry.createdAt}`}>
                <span className={`gateway-status ${statusTone(entry.status)}`}>{entry.status}</span>
                <div>
                  <strong>{entry.model}</strong>
                  <small>
                    {formatTokens(entry.inputTokens + entry.outputTokens)} tokens ·{" "}
                    {formatLatency(entry.latencyMs)}
                    {entry.errorCode ? ` · ${entry.errorCode}` : ""}
                  </small>
                </div>
                <span className="gateway-request-meta">
                  <strong>{formatUsd(entry.costUsd)}</strong>
                  <small>{formatRelativeTime(entry.createdAt)}</small>
                </span>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StatTile({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "blue" | "cyan" | "purple" | "green";
  value: string;
}) {
  return (
    <article className={`gateway-stat tone-${tone}`}>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}
