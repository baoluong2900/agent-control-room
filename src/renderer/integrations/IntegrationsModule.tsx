import {
  AlertTriangle,
  ArrowUpRight,
  KeyRound,
  Network,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Bot,
  Workflow,
} from "lucide-react";
import type { ProjectSummary, ProviderConnection, SystemDiagnostics } from "@contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { providerCatalog } from "../settings/provider-catalog";
import { workspaceNavigation, type WorkspaceNavKey } from "../workspace-navigation";
import "./integrations.css";

type IntegrationsModuleProps = {
  diagnostics: SystemDiagnostics | null;
  project: ProjectSummary | null;
  onNavigate: (nav: WorkspaceNavKey) => void;
  onRefreshDiagnostics: () => Promise<void>;
};

export function IntegrationsModule({ diagnostics, project, onNavigate, onRefreshDiagnostics }: IntegrationsModuleProps) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadConnections = async () => {
    setLoading(true);
    try {
      const nextConnections = await window.agentic.settings.listProviderConnections();
      setConnections(nextConnections);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  // The gateway panel renders `diagnostics`, which lives in App state, so a
  // refresh that only reloaded connections left the CLI list stale on screen.
  const refresh = async () => {
    setLoading(true);
    try {
      const [nextConnections] = await Promise.all([
        window.agentic.settings.listProviderConnections(),
        onRefreshDiagnostics(),
      ]);
      setConnections(nextConnections);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConnections();
  }, []);

  const installedTools = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const totalTools = diagnostics?.tools.length ?? 0;
  const connected = connections.filter((connection) => connection.status === "connected").length;
  const expired = connections.filter((connection) => connection.status === "expired").length;
  const apiKeys = connections.filter((connection) => connection.authMode === "api-key").length;
  const providerById = useMemo(() => new Map(connections.map((connection) => [connection.provider, connection])), [connections]);
  const missingTools = diagnostics?.tools.filter((tool) => !tool.installed).slice(0, 5) ?? [];

  return (
    <div className="integrations-page">
      <section className="integrations-hero">
        <div>
          <span className="integrations-eyebrow">
            <PlugZap size={13} />
            Integrations
          </span>
          <h1>Provider Mesh</h1>
          <p>AI accounts, local CLIs, and workspace routing stay aligned with the same desktop control surface.</p>
        </div>
        <div className="integrations-actions">
          <button className="integrations-ghost" onClick={() => onNavigate("Overview")} type="button">
            Overview
          </button>
          <button className="integrations-ghost" onClick={() => onNavigate("Agents")} type="button">
            Fleet
          </button>
          <button className="integrations-primary" onClick={() => onNavigate("Settings")} type="button">
            Manage Access
          </button>
        </div>
      </section>

      {error && (
        <p className="integrations-banner error">
          <AlertTriangle size={14} />
          {error}
        </p>
      )}

      <section className="integrations-stat-grid" aria-label="Provider summary">
        <MetricCard icon={<Network size={16} />} label="Connected Providers" value={connected} tone="blue" />
        <MetricCard icon={<ShieldCheck size={16} />} label="OAuth/Device Links" value={connections.length - apiKeys} tone="green" />
        <MetricCard icon={<KeyRound size={16} />} label="API Keys" value={apiKeys} tone="purple" />
        <MetricCard icon={<Workflow size={16} />} label="Ready CLIs" value={totalTools ? `${installedTools}/${totalTools}` : "Pending"} tone="cyan" />
        <MetricCard icon={<AlertTriangle size={16} />} label="Expired" value={expired} tone="amber" />
      </section>

      <div className="integrations-layout">
        <main className="integrations-main">
          <section className="integrations-panel">
            <header>
              <div>
                <h2>Provider Connections</h2>
                <p>Connections feed agent profiles, tasks, and workflows.</p>
              </div>
              <button className="integrations-link" onClick={() => onNavigate("Settings")} type="button">
                Open settings
              </button>
            </header>
            <div className="integrations-provider-grid">
              {providerCatalog.map((entry) => {
                const connection = providerById.get(entry.provider);
                return (
                  <article key={entry.provider} className="integrations-provider-card">
                    <header>
                      <span className="integrations-provider-icon" style={{ ["--provider-accent" as string]: entry.accent }}>
                        <entry.icon size={14} />
                      </span>
                      <div>
                        <strong>{entry.label}</strong>
                        <small>{entry.description}</small>
                      </div>
                      <span className={`integrations-status ${connection?.status ?? "missing"}`}>
                        {connection?.status ?? "missing"}
                      </span>
                    </header>
                    <div className="integrations-provider-meta">
                      <span>
                        <strong>{entry.harness}</strong>
                        <small>Harness</small>
                      </span>
                      <span>
                        <strong>{entry.runtimeHint}</strong>
                        <small>Runtime hint</small>
                      </span>
                      <span>
                        <strong>{connection?.accountLabel ?? entry.defaultAccountLabel}</strong>
                        <small>Account</small>
                      </span>
                      <span>
                        <strong>{connection?.quotaLabel ?? (entry.authMode === "api-key" ? "API key" : "OAuth")}</strong>
                        <small>Auth mode</small>
                      </span>
                    </div>
                    <footer>
                      <span>{connection?.lastConnectedAt ? formatRelative(connection.lastConnectedAt) : "Not connected"}</span>
                      <button className="integrations-link" onClick={() => onNavigate("Settings")} type="button">
                        Manage
                        <ArrowUpRight size={12} />
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="integrations-panel">
            <header>
              <div>
                <h2>Local CLI Readiness</h2>
                <p>Detected CLIs and missing tools that affect the agent fleet.</p>
              </div>
              <button className="integrations-link" onClick={refresh} type="button">
                <RefreshCw size={12} />
                Refresh
              </button>
            </header>
            <div className="integrations-tool-grid">
              {missingTools.length > 0 ? (
                missingTools.map((tool) => (
                  <article key={tool.id} className="integrations-tool-card missing">
                    <AlertTriangle size={14} />
                    <div>
                      <strong>{tool.displayName}</strong>
                      <small>{tool.detail}</small>
                    </div>
                  </article>
                ))
              ) : (
                <article className="integrations-tool-card ready">
                  <Bot size={14} />
                  <div>
                    <strong>All detected tools are ready.</strong>
                    <small>Local command surface is available for the agent modules.</small>
                  </div>
                </article>
              )}
            </div>
          </section>
        </main>

        <aside className="integrations-rail">
          <section className="integrations-panel">
            <header>
              <div>
                <h2>Workspace Route</h2>
                <p>{project ? project.name : "No project selected"}</p>
              </div>
            </header>
            <div className="integrations-summary">
              <span>
                <strong>{connected}</strong>
                <small>Connected</small>
              </span>
              <span>
                <strong>{expired}</strong>
                <small>Expired</small>
              </span>
              <span>
                <strong>{installedTools}</strong>
                <small>Tools ready</small>
              </span>
              <span>
                <strong>{project ? "Linked" : "Select"}</strong>
                <small>Project</small>
              </span>
            </div>
          </section>

          <section className="integrations-panel">
            <header>
              <div>
                <h2>Module Links</h2>
                <p>Jump to the parts that use these connections.</p>
              </div>
            </header>
            <div className="integrations-link-grid">
              {workspaceNavigation
                .filter((item) => item.key !== "Overview")
                .map((item) => (
                  <button key={item.key} className="integrations-link-card" onClick={() => onNavigate(item.key)} type="button">
                    <item.icon size={14} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.summary}</small>
                    </span>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
            </div>
          </section>
        </aside>
      </div>

      {loading && <p className="integrations-loading">Refreshing provider mesh...</p>}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "green" | "purple" | "cyan" | "amber";
  value: number | string;
}) {
  return (
    <article className={`integrations-stat tone-${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  );
}

function formatRelative(value?: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}
