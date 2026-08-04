import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  Globe2,
  KeyRound,
  Loader2,
  LogIn,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Unlink,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type {
  AppIdentity,
  AppIdentityStatus,
  AppLoginMethod,
  ProviderConnection,
  ProviderConnectionProvider,
  ProviderConnectionStatus,
} from "@contracts";
import { useEffect, useMemo, useState } from "react";
import { getProviderCatalogEntry, providerCatalog, supportsBaseUrl } from "./provider-catalog";
import "./settings.css";

type BannerTone = "success" | "error" | "idle";

type LoginMethodOption = {
  value: AppLoginMethod;
  label: string;
  icon: LucideIcon;
  detail: string;
};

type SettingsModuleProps = {
  authOnly?: boolean;
  onIdentityChange?: (identity: AppIdentity) => void;
};

const loginMethods: LoginMethodOption[] = [
  { value: "google", label: "Google", icon: Globe2, detail: "Workspace account" },
  { value: "github", label: "GitHub", icon: GitBranch, detail: "Developer account" },
  { value: "email", label: "Email", icon: UserRound, detail: "Local email profile" },
];

const emptyIdentity: AppIdentity = {
  id: "",
  email: "owner@agentic.local",
  displayName: "Local Workspace",
  loginMethod: "email",
  status: "signed-out",
  createdAt: "",
  updatedAt: "",
};

export function SettingsModule({ authOnly = false, onIdentityChange }: SettingsModuleProps) {
  const [identity, setIdentity] = useState<AppIdentity>(emptyIdentity);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [drafts, setDrafts] = useState<Record<ProviderConnectionProvider, string>>({
    "openai-codex": "OpenAI account",
    "claude-code": "Claude account",
    "github-copilot": "GitHub account",
    kiro: "Kiro account",
    "custom-api": "Custom API key",
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [baseUrlDrafts, setBaseUrlDrafts] = useState<Partial<Record<ProviderConnectionProvider, string>>>({});
  const [loading, setLoading] = useState(true);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [busyProvider, setBusyProvider] = useState<ProviderConnectionProvider | null>(null);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [tone, setTone] = useState<BannerTone>("idle");
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const providerGroups = useMemo(
    () =>
      providerCatalog.map((entry) => ({
        entry,
        items: connections.filter((connection) => connection.provider === entry.provider),
      })),
    [connections],
  );

  const summary = useMemo(() => {
    const connected = connections.filter((connection) => connection.status === "connected").length;
    const unverified = connections.filter((connection) => connection.status === "unverified").length;
    const expired = connections.filter((connection) => connection.status === "expired").length;
    const apiKeys = connections.filter((connection) => connection.authMode === "api-key").length;
    return {
      signedIn: identity.status === "signed-in" ? 1 : 0,
      connected,
      unverified,
      expired,
      apiKeys,
    };
  }, [connections, identity.status]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextIdentity, nextConnections] = await Promise.all([
        window.agentic.settings.getIdentity(),
        window.agentic.settings.listProviderConnections(),
      ]);
      setIdentity(nextIdentity);
      onIdentityChange?.(nextIdentity);
      setConnections(nextConnections);
      setDrafts((current) => {
        const next = { ...current };
        for (const entry of providerCatalog) {
          const existing = nextConnections.find((connection) => connection.provider === entry.provider);
          next[entry.provider] = existing?.accountLabel ?? current[entry.provider] ?? entry.defaultAccountLabel;
        }
        return next;
      });
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function saveIdentity(nextStatus: AppIdentityStatus, loginMethod = identity.loginMethod) {
    setSavingIdentity(true);
    setError(null);
    try {
      const saved = await window.agentic.settings.saveIdentity({
        displayName: identity.displayName.trim() || emptyIdentity.displayName,
        email: identity.email.trim() || emptyIdentity.email,
        loginMethod,
        status: nextStatus,
      });
      setIdentity(saved);
      onIdentityChange?.(saved);
      showBanner(
        nextStatus === "signed-in"
          ? `Signed in locally with ${methodLabel(loginMethod)}.`
          : "Signed out of the local app account.",
        nextStatus === "signed-in" ? "success" : "idle",
      );
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setSavingIdentity(false);
    }
  }

  async function connectProvider(provider: ProviderConnectionProvider) {
    const entry = getProviderCatalogEntry(provider);
    const accountLabel = drafts[provider].trim() || entry.defaultAccountLabel;
    setBusyProvider(provider);
    setError(null);
    try {
      if (entry.authMode !== "api-key") {
        const result = await window.agentic.settings.openProviderAuth({ provider });
        if (!result.opened) {
          throw new Error(`Could not open ${entry.label}.`);
        }
      }

      const saved = await window.agentic.settings.saveProviderConnection({
        provider,
        authMode: entry.authMode,
        accountLabel,
        status: "connected",
        tokenSecret: provider === "custom-api" ? apiKeyDraft.trim() : undefined,
        baseUrl: supportsBaseUrl(provider) ? baseUrlDrafts[provider]?.trim() ?? "" : undefined,
        quotaLabel: provider === "custom-api" ? "API key" : undefined,
      });

      setConnections((current) => {
        const next = current.filter((connection) => connection.id !== saved.id);
        return [saved, ...next];
      });
      setDrafts((current) => ({ ...current, [provider]: accountLabel }));
      if (provider === "custom-api") {
        setApiKeyDraft("");
      }
      showBanner(`${entry.label} connected locally.`, "success");
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusyProvider(null);
    }
  }

  async function reconnectProvider(connection: ProviderConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      const entry = getProviderCatalogEntry(connection.provider);
      if (entry.authMode !== "api-key") {
        const result = await window.agentic.settings.openProviderAuth({ provider: connection.provider });
        if (!result.opened) {
          throw new Error(`Could not open ${entry.label}.`);
        }
      }

      const saved = await window.agentic.settings.saveProviderConnection({
        id: connection.id,
        provider: connection.provider,
        authMode: connection.authMode,
        accountLabel: connection.accountLabel,
        status: "connected",
        baseUrl: connection.baseUrl,
        quotaLabel: connection.quotaLabel,
      });

      setConnections((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      showBanner(`${entry.label} reconnected.`, "success");
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function disconnectProvider(connection: ProviderConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      const saved = await window.agentic.settings.saveProviderConnection({
        id: connection.id,
        provider: connection.provider,
        authMode: connection.authMode,
        accountLabel: connection.accountLabel,
        baseUrl: connection.baseUrl,
        quotaLabel: connection.quotaLabel,
        status: "disconnected",
      });
      setConnections((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      showBanner(`${getProviderCatalogEntry(connection.provider).label} disconnected.`, "idle");
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function verifyConnection(connection: ProviderConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      const result = await window.agentic.settings.verifyProviderConnection(connection.id);
      setConnections((current) => current.map((item) => (item.id === result.connectionId ? result.connection : item)));
      showBanner(result.detail, result.outcome === "verified" ? "success" : "idle");
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function removeConnection(connection: ProviderConnection) {
    setBusyConnectionId(connection.id);
    setError(null);
    try {
      await window.agentic.settings.deleteProviderConnection(connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      showBanner(`Removed ${connection.accountLabel ?? getProviderCatalogEntry(connection.provider).label}.`, "idle");
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusyConnectionId(null);
    }
  }

  function showBanner(message: string, nextTone: BannerTone) {
    setBanner(message);
    setTone(nextTone);
  }

  const connectedByProvider = new Map<ProviderConnectionProvider, ProviderConnection[]>(
    providerCatalog.map((entry) => [
      entry.provider,
      connections.filter((connection) => connection.provider === entry.provider),
    ]),
  );

  return (
    <main className={`settings-page ${authOnly ? "auth-only" : ""}`}>
      <section className="settings-hero">
        <div className="settings-hero-copy">
          <span className="settings-eyebrow">
            <Settings2 size={13} />
            {authOnly ? "Workspace access" : "Settings"}
          </span>
          <h1>{authOnly ? "Sign in to AgenticOS" : "App account and AI providers"}</h1>
          <p>
            {authOnly
              ? "Use a local workspace account to unlock the desktop app."
              : "App sign-in is kept separate from AI account links. The desktop app owns project state, while provider records stay local on this machine."}
          </p>
        </div>
        {!authOnly && (
          <button className="settings-action settings-action-secondary" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        )}
      </section>

      {!authOnly && (
        <section className="settings-stats" aria-label="Identity summary">
          <StatPill label="Local sign-in" value={summary.signedIn ? "Signed in" : "Signed out"} tone="cyan" />
          <StatPill label="Connected" value={summary.connected} tone="green" />
          <StatPill label="Unverified" value={summary.unverified} tone="cyan" />
          <StatPill label="Expired" value={summary.expired} tone="amber" />
          <StatPill label="API keys" value={summary.apiKeys} tone="purple" />
        </section>
      )}

      {banner && <div className={`settings-banner tone-${tone}`}>{banner}</div>}
      {error && (
        <div className="settings-banner tone-error">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      <section className={`settings-grid ${authOnly ? "auth-only" : ""}`}>
        <article className="settings-panel settings-identity-panel">
          <header>
            <div>
              <h2>App account</h2>
              <p>{authOnly ? "Local sign-in for the desktop workspace." : "Used for projects, tasks, and sync metadata."}</p>
            </div>
            <LogIn size={16} />
          </header>

          <div className="settings-field-grid">
            <label className="settings-field">
              Display name
              <input
                value={identity.displayName}
                onChange={(event) => setIdentity((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="Local Workspace"
              />
            </label>
            <label className="settings-field">
              Email
              <input
                value={identity.email}
                onChange={(event) => setIdentity((current) => ({ ...current, email: event.target.value }))}
                placeholder="owner@agentic.local"
              />
            </label>
          </div>

          <div className="settings-login-methods" role="group" aria-label="Login method">
            {loginMethods.map((method) => {
              const Icon = method.icon;
              const selected = identity.loginMethod === method.value;
              return (
                <button
                  key={method.value}
                  className={`settings-choice ${selected ? "selected" : ""}`}
                  onClick={() => {
                    setIdentity((current) => ({ ...current, loginMethod: method.value }));
                    void saveIdentity("signed-in", method.value);
                  }}
                  disabled={savingIdentity}
                  type="button"
                >
                  <span className="settings-choice-icon">
                    <Icon size={15} />
                  </span>
                  <span className="settings-choice-copy">
                    <strong>{method.label}</strong>
                    <small>{method.detail}</small>
                  </span>
                  {selected && <CheckCircle2 size={15} className="settings-choice-check" />}
                </button>
              );
            })}
          </div>

          <div className="settings-panel-actions">
            <button
              className="settings-action settings-action-secondary"
              onClick={() => void saveIdentity("signed-in")}
              disabled={savingIdentity}
            >
              {savingIdentity ? <Loader2 size={14} className="spin" /> : authOnly ? <LogIn size={14} /> : <Save size={14} />}
              {authOnly ? "Sign in" : "Save profile"}
            </button>
            {!authOnly && (
              <button
                className="settings-action settings-action-ghost"
                onClick={() => void saveIdentity("signed-out")}
                disabled={savingIdentity}
              >
                Sign out
              </button>
            )}
          </div>
        </article>

        {!authOnly && (
          <aside className="settings-panel settings-summary-panel">
            <header>
              <div>
                <h2>Current routing</h2>
                <p>Agent profiles use a saved provider connection as metadata.</p>
              </div>
              <ShieldCheck size={16} />
            </header>

            <div className="settings-route-list">
              {providerCatalog.map((entry) => {
                const connectionsForProvider = connectedByProvider.get(entry.provider) ?? [];
                // "unverified" counts as configured here: the routing row reports
                // whether a provider has a usable connection, and an unchecked one
                // is what every connection looks like before Verify is clicked.
                const active = connectionsForProvider.find(
                  (connection) => connection.status === "connected" || connection.status === "unverified",
                );
                const Icon = entry.icon;
                return (
                  <div key={entry.provider} className="settings-route-row">
                    <span className="settings-route-icon" style={{ ["--route-accent" as string]: entry.accent }}>
                      <Icon size={15} />
                    </span>
                    <div className="settings-route-copy">
                      <strong>{entry.label}</strong>
                      <small>
                        {entry.harness} · {entry.runtimeHint}
                      </small>
                    </div>
                    <em>
                      {active ? active.accountLabel ?? "Connected" : `${connectionsForProvider.length} saved`}
                    </em>
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </section>

      {!authOnly && (
        <section className="settings-provider-section">
          <header className="settings-section-head">
            <div>
              <h2>AI providers</h2>
              <p>Open the official provider page, then save the local connection record on this machine.</p>
            </div>
          </header>

          <div className="settings-provider-grid">
            {providerGroups.map(({ entry, items }) => {
              const Icon = entry.icon;
              return (
                <article key={entry.provider} className="provider-card">
                  <header className="provider-head">
                    <span className="provider-icon" style={{ ["--provider-accent" as string]: entry.accent }}>
                      <Icon size={16} />
                    </span>
                    <div className="provider-head-copy">
                      <strong>{entry.label}</strong>
                      <small>
                        {entry.description}
                      </small>
                    </div>
                    <span className="provider-meta">{items.length} saved</span>
                  </header>

                  <div className="provider-create">
                    <label className="settings-field compact">
                      Account label
                      <input
                        value={drafts[entry.provider]}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [entry.provider]: event.target.value }))
                        }
                        placeholder={entry.defaultAccountLabel}
                      />
                    </label>
                    {entry.provider === "custom-api" && (
                      <label className="settings-field compact">
                        API key
                        <input
                          value={apiKeyDraft}
                          onChange={(event) => setApiKeyDraft(event.target.value)}
                          placeholder="sk-..."
                          type="password"
                        />
                      </label>
                    )}
                    {supportsBaseUrl(entry.provider) && (
                      <label className="settings-field compact">
                        Base URL <span className="settings-field-hint">optional proxy / router</span>
                        <input
                          value={baseUrlDrafts[entry.provider] ?? ""}
                          onChange={(event) =>
                            setBaseUrlDrafts((current) => ({ ...current, [entry.provider]: event.target.value }))
                          }
                          placeholder="http://127.0.0.1:20128/v1"
                        />
                      </label>
                    )}
                    <button
                      className="settings-action settings-action-primary"
                      onClick={() => void connectProvider(entry.provider)}
                      disabled={busyProvider === entry.provider || (entry.provider === "custom-api" && !apiKeyDraft.trim())}
                      type="button"
                    >
                      {busyProvider === entry.provider ? <Loader2 size={14} className="spin" /> : <Link2Icon provider={entry.provider} />}
                      {entry.provider === "custom-api" ? "Store key" : "Connect"}
                    </button>
                  </div>

                  <div className="provider-connection-list">
                    {items.length > 0 ? (
                      items.map((connection) => {
                        const isBusy = busyConnectionId === connection.id;
                        return (
                          <div key={connection.id} className="provider-connection-row">
                            <div className="provider-connection-copy">
                              <strong>{connection.accountLabel ?? entry.defaultAccountLabel}</strong>
                              <small>
                                <StatusChip status={connection.status} />
                                <span>{connection.authMode.replace("-", " ")}</span>
                                {connection.quotaLabel && <span>{connection.quotaLabel}</span>}
                              </small>
                              {connection.verificationDetail && (
                                <small className="provider-connection-detail" title={connection.verificationDetail}>
                                  {connection.verificationDetail}
                                </small>
                              )}
                            </div>
                            <div className="provider-connection-actions">
                              <button
                                className="settings-mini-button"
                                onClick={() => void verifyConnection(connection)}
                                disabled={isBusy}
                              >
                                {isBusy ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
                                Verify
                              </button>
                              <button
                                className="settings-mini-button"
                                onClick={() => void reconnectProvider(connection)}
                                disabled={isBusy}
                              >
                                {isBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                                Reconnect
                              </button>
                              <button
                                className="settings-mini-button"
                                onClick={() => void disconnectProvider(connection)}
                                disabled={isBusy || connection.status === "disconnected"}
                              >
                                <Unlink size={13} />
                                Disconnect
                              </button>
                              <button
                                className="settings-mini-button danger"
                                onClick={() => void removeConnection(connection)}
                                disabled={isBusy}
                              >
                                <Trash2 size={13} />
                                Remove
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="provider-empty">
                        <Clock3 size={14} />
                        Not connected yet.
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

function Link2Icon({ provider }: { provider: ProviderConnectionProvider }) {
  return provider === "custom-api" ? <KeyRound size={14} /> : <ExternalLink size={14} />;
}

function StatPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "cyan" | "green" | "amber" | "purple";
}) {
  return (
    <article className={`settings-stat tone-${tone}`}>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}

function StatusChip({ status }: { status: ProviderConnectionStatus }) {
  return <span className={`status-chip status-${status}`}>{status}</span>;
}

function methodLabel(method: AppLoginMethod): string {
  return loginMethods.find((entry) => entry.value === method)?.label ?? method;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
