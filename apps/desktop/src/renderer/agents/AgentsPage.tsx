import {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  Boxes,
  ChevronDown,
  CircleCheck,
  Cpu,
  Gauge,
  Grid2x2,
  List,
  Loader2,
  Maximize2,
  Minus,
  Pencil,
  Play,
  Plus,
  Search,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import type { AgentCliDescriptor, AgentProfile, AgentStatus } from "@contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { AgentBuilderModal } from "./AgentBuilderModal";
import { AgentTerminal } from "./AgentTerminal";
import { statusLabel, statusTone, useAgentsStore } from "../stores/agents-store";
import "./agents.css";

type ViewMode = "fleet" | "list" | "grid";
type TabKey = "all" | "active" | "busy" | "idle" | "disabled";

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "busy", label: "Busy" },
  { key: "idle", label: "Idle" },
  { key: "disabled", label: "Disabled" },
];

const roleByCli: Partial<Record<AgentProfile["cliId"], { name: string; role: string }>> = {
  kiro: { name: "Kiro Builder", role: "Senior Developer" },
  claude: { name: "Claude Reviewer", role: "Code Reviewer" },
  codex: { name: "Codex Implementer", role: "Implementation Engineer" },
  gemini: { name: "Gemini Researcher", role: "Research Specialist" },
  agy: { name: "Agy Operator", role: "Automation Engineer" },
  grok: { name: "Grok Explorer", role: "Research Specialist" },
  amazonq: { name: "Q Advisor", role: "Cloud Engineer" },
  aider: { name: "Aider Refactorer", role: "Refactor Specialist" },
  opencode: { name: "OpenCode Agent", role: "Full-stack Developer" },
  cursor: { name: "Cursor Agent", role: "Pair Programmer" },
  copilot: { name: "Copilot Helper", role: "Developer" },
  qwen: { name: "Qwen Coder", role: "Developer" },
  ollama: { name: "Local Model", role: "Offline Assistant" },
  shell: { name: "Shell Runner", role: "Build Verifier" },
};

export function AgentsPage({
  projectPath,
  onPickFolder,
}: {
  projectPath: string;
  onPickFolder: () => Promise<string | null>;
}) {
  const {
    activity,
    catalog,
    error,
    history,
    loadAll,
    ingest,
    pings,
    profiles,
    runtimes,
    saveProfile,
    sessions,
    deleteProfile,
    runProfile,
    setError,
  } = useAgentsStore();

  const [view, setView] = useState<ViewMode>("fleet");
  const [zoom, setZoom] = useState(100);
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");
  const [cliFilter, setCliFilter] = useState<string>("all");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [terminalProfileId, setTerminalProfileId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [performanceDays, setPerformanceDays] = useState(7);

  useEffect(() => {
    void loadAll();
    return window.agentic.events.subscribe(ingest);
  }, [ingest, loadAll]);

  const stats = useMemo(() => {
    const activeIds = new Set(sessions.map((session) => session.profileId).filter(Boolean) as string[]);
    const busy = Object.values(runtimes).filter((runtime) => statusTone[runtime.status] === "busy").length;
    const finished = history.filter((run) => run.status === "completed" || run.status === "failed");
    const completed = finished.filter((run) => run.status === "completed").length;

    return {
      total: profiles.length,
      active: activeIds.size,
      busy,
      idle: Math.max(profiles.length - activeIds.size, 0),
      successRate: finished.length ? Math.round((completed / finished.length) * 100) : 0,
      readyClis: catalog.filter((entry) => pings[entry.id]?.installed).length,
      totalClis: catalog.filter((entry) => entry.id !== "custom").length,
    };
  }, [catalog, history, pings, profiles.length, runtimes, sessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return profiles.filter((profile) => {
      const runtime = runtimes[profile.id];
      const isLive = sessions.some((session) => session.profileId === profile.id);
      const tone = runtime ? statusTone[runtime.status] : "idle";

      if (tab === "active" && !isLive) return false;
      if (tab === "busy" && tone !== "busy") return false;
      if (tab === "idle" && (isLive || tone === "busy")) return false;
      if (tab === "disabled" && profile.enabled) return false;
      if (cliFilter !== "all" && profile.cliId !== cliFilter) return false;
      if (!needle) return true;

      return [profile.name, profile.role, profile.cliId, profile.model].join(" ").toLowerCase().includes(needle);
    });
  }, [cliFilter, profiles, query, runtimes, sessions, tab]);

  const terminalProfile = profiles.find((profile) => profile.id === terminalProfileId) ?? null;
  const displayStats = {
    total: stats.total,
    active: stats.active,
    busy: stats.busy,
    idle: stats.idle,
    successRate: `${stats.successRate}%`,
    readyClis: stats.readyClis,
    totalClis: stats.totalClis,
  };
  const workspaceLabel = workspaceName(projectPath);
  const activeSessions = sessions.filter((session) => session.profileId);

  /** Presets follow the CLIs actually detected on this machine. */
  const quickStarts = useMemo(() => {
    const installed = catalog.filter((entry) => entry.id !== "custom" && pings[entry.id]?.installed);
    const source = installed.length > 0 ? installed : catalog.filter((entry) => entry.id !== "custom").slice(0, 4);
    return source.slice(0, 4).map((entry) => ({
      cliId: entry.id,
      name: roleByCli[entry.id]?.name ?? `${entry.displayName} Agent`,
      role: roleByCli[entry.id]?.role ?? "Agent",
    }));
  }, [catalog, pings]);

  const createQuickStart = async (preset: (typeof quickStarts)[number]) => {
    const descriptor = catalog.find((entry) => entry.id === preset.cliId);
    setSeeding(preset.cliId);
    try {
      await saveProfile({
        name: preset.name,
        role: preset.role,
        cliId: preset.cliId,
        model: (descriptor?.models.find((model) => model.recommended) ?? descriptor?.models[0])?.id ?? "default",
        accent: descriptor?.accent,
        cwd: projectPath || undefined,
        interactive: true,
        promptMode: descriptor?.promptMode,
        tags: [descriptor?.vendor ?? "local"],
      });
    } finally {
      setSeeding(null);
    }
  };

  const runNow = async (profile: AgentProfile) => {
    const cwd = profile.cwd || projectPath;
    if (!cwd) {
      setError("Select a project folder before running an agent.");
      return;
    }
    setTerminalProfileId(profile.id);
    await runProfile(profile, {
      prompt: profile.systemPrompt || "Review this project and propose the next smallest implementation step.",
      cwd,
    });
  };

  return (
    <div className="agents-page">
      <header className="agents-head">
        <div>
          <h1>Agents</h1>
          <p>Manage and monitor your AI agents</p>
        </div>
        <div className="agents-top-actions">
          <label className="agents-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents…" />
            <kbd>⌘K</kbd>
          </label>
          <div className="agent-menu-wrap">
            <button
              className="agent-notification-button"
              aria-label="Notifications"
              onClick={() => {
                setNotificationsOpen((open) => !open);
                setWorkspaceMenuOpen(false);
              }}
            >
              <Bell size={17} />
              {sessions.length > 0 && <span>{sessions.length}</span>}
            </button>
            {notificationsOpen && (
              <div className="agent-popover">
                <strong>Live Sessions</strong>
                {activeSessions.length > 0 ? (
                  activeSessions.slice(0, 5).map((session) => {
                    const profile = profiles.find((item) => item.id === session.profileId);
                    return (
                      <p key={session.runId}>
                        <span className="agent-popover-dot" />
                        {profile?.name ?? session.cliId} is {session.status}
                      </p>
                    );
                  })
                ) : (
                  <p>
                    <span className="agent-popover-dot idle" />
                    No live agent sessions.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="agent-menu-wrap">
            <button
              className="agent-user-button"
              aria-label="Open workspace menu"
              onClick={() => {
                setWorkspaceMenuOpen((open) => !open);
                setNotificationsOpen(false);
              }}
            >
              <span className="agent-user-photo">{workspaceInitials(workspaceLabel)}</span>
              <span className="agent-user-copy">
                <strong>{workspaceLabel}</strong>
                <small>{profiles.length} agents</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {workspaceMenuOpen && (
              <div className="agent-popover wide">
                <strong>Workspace Scope</strong>
                <p>
                  <span className="agent-popover-dot" />
                  {projectPath || "No project folder selected"}
                </p>
                <p>
                  <span className="agent-popover-dot idle" />
                  {displayStats.readyClis}/{displayStats.totalClis} CLIs ready
                </p>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="agents-head-actions">
        <button
          className="primary-action"
          onClick={() => {
            setEditing(null);
            setBuilderOpen(true);
          }}
        >
          <Plus size={15} />
          New Agent
        </button>
      </div>

      {error && (
        <p className="agents-error">
          <AlertTriangle size={14} />
          {error}
          <button onClick={() => setError(null)}>dismiss</button>
        </p>
      )}

      <div className="agents-layout">
        <div className="agents-main">
          <section className="platform-overview">
            <header>
              <h2>Platform Overview</h2>
              <div className="stat-strip">
                <Stat icon={<Bot size={13} />} tone="blue" value={displayStats.total} label="Total Agents" />
                <Stat icon={<Zap size={13} />} tone="green" value={displayStats.active} label="Active Now" />
                <Stat icon={<Activity size={13} />} tone="amber" value={displayStats.busy} label="Busy" />
                <Stat icon={<Boxes size={13} />} tone="slate" value={displayStats.idle} label="Idle" />
                <Stat icon={<Gauge size={13} />} tone="cyan" value={displayStats.successRate} label="Success Rate" />
              </div>
            </header>

            <div className="overview-canvas">
              {view === "fleet" && (
                <FleetMap
                  catalog={catalog}
                  history={history}
                  pings={pings}
                  profiles={profiles}
                  runtimes={runtimes}
                  sessions={sessions}
                  zoom={zoom}
                />
              )}
              {view === "list" && <CliTable catalog={catalog} pings={pings} />}
              {view === "grid" && <CliCards catalog={catalog} pings={pings} />}
              <div className="overview-map-toolbar">
                <div className="view-switch">
                  <button className={view === "fleet" ? "active" : ""} onClick={() => setView("fleet")}>
                    <Bot size={13} />
                    3D View
                  </button>
                  <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
                    <List size={13} />
                    List View
                  </button>
                  <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>
                    <Grid2x2 size={13} />
                    Grid View
                  </button>
                </div>
                <div className="zoom-controls" aria-label="Map zoom controls">
                  <button aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(70, value - 10))}>
                    <Minus size={14} />
                  </button>
                  <span>{zoom}%</span>
                  <button aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(130, value + 10))}>
                    <Plus size={14} />
                  </button>
                  <button aria-label="Fit to view" onClick={() => setZoom(100)}>
                    <Maximize2 size={14} />
                  </button>
                </div>
              </div>
            </div>

            <footer className="overview-foot">
              <span className="overview-meta">
                <Cpu size={13} />
                {displayStats.readyClis}/{displayStats.totalClis} CLIs detected on PATH
              </span>
            </footer>
          </section>

          <section className="all-agents">
            <header>
              <h2>All Agents</h2>
              <div className="agents-filters">
                <label className="agents-search compact">
                  <Search size={14} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents…" />
                </label>
                <select value={cliFilter} onChange={(event) => setCliFilter(event.target.value)}>
                  <option value="all">All Types</option>
                  {catalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </header>

            <nav className="agents-tabs">
              {tabs.map((entry) => (
                <button key={entry.key} className={tab === entry.key ? "active" : ""} onClick={() => setTab(entry.key)}>
                  {entry.label} ({countForTab(entry.key, profiles, runtimes, sessions)})
                </button>
              ))}
            </nav>

            {profiles.length === 0 ? (
              <QuickStartGrid
                history={history}
                quickStarts={quickStarts}
                seeding={seeding}
                pings={pings}
                onCreateQuickStart={createQuickStart}
              />
            ) : (
              <div className="agent-card-grid">
                {filtered.map((profile) => (
                  <AgentCard
                    key={profile.id}
                    profile={profile}
                    status={runtimes[profile.id]?.status}
                    live={sessions.some((session) => session.profileId === profile.id)}
                    installed={pings[profile.cliId]?.installed ?? false}
                    onRun={() => runNow(profile)}
                    onTerminal={() => setTerminalProfileId(profile.id)}
                    onEdit={() => {
                      setEditing(profile);
                      setBuilderOpen(true);
                    }}
                    onDelete={() => deleteProfile(profile.id)}
                  />
                ))}
                {filtered.length === 0 && <p className="agents-empty-inline">No agents match this filter.</p>}
              </div>
            )}
          </section>

          {terminalProfile && (
            <AgentTerminal
              profile={terminalProfile}
              cwd={terminalProfile.cwd || projectPath}
              onClose={() => setTerminalProfileId(null)}
            />
          )}
        </div>

        <aside className="agents-rail">
          <ActivityFeed activity={activity} expanded={activityExpanded} profiles={profiles} onToggleExpanded={() => setActivityExpanded((open) => !open)} />
          <PerformancePanel
            days={performanceDays}
            history={history}
            onChangeDays={() => setPerformanceDays((days) => (days === 7 ? 14 : days === 14 ? 30 : 7))}
          />
          <ResourcePanel
            readyClis={displayStats.readyClis}
            totalClis={displayStats.totalClis}
            successRate={stats.successRate}
            active={displayStats.active}
            total={Math.max(displayStats.total, 1)}
            historyCount={history.length}
          />
        </aside>
      </div>

      {builderOpen && (
        <AgentBuilderModal
          defaultCwd={projectPath}
          editing={editing}
          onClose={() => {
            setBuilderOpen(false);
            setEditing(null);
          }}
          onPickFolder={onPickFolder}
        />
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "green" | "amber" | "slate" | "cyan";
  value: number | string;
}) {
  return (
    <div className={`stat-pill tone-${tone}`}>
      <strong>
        {icon}
        {value}
      </strong>
      <small>{label}</small>
    </div>
  );
}

type PingMap = ReturnType<typeof useAgentsStore.getState>["pings"];
type QuickStartPreset = { cliId: AgentCliDescriptor["id"]; name: string; role: string };
type FleetNode = {
  accent: string;
  detail: string;
  id: string;
  metric: string;
  name: string;
  role: string;
  status: AgentStatus | "missing";
  x: number;
  y: number;
};

const fleetPositions = [
  { x: 50, y: 16 },
  { x: 75, y: 27 },
  { x: 80, y: 58 },
  { x: 58, y: 76 },
  { x: 29, y: 72 },
  { x: 19, y: 42 },
  { x: 36, y: 29 },
  { x: 64, y: 45 },
];

function FleetMap({
  catalog,
  history,
  pings,
  profiles,
  runtimes,
  sessions,
  zoom,
}: {
  catalog: AgentCliDescriptor[];
  history: ReturnType<typeof useAgentsStore.getState>["history"];
  pings: PingMap;
  profiles: AgentProfile[];
  runtimes: ReturnType<typeof useAgentsStore.getState>["runtimes"];
  sessions: ReturnType<typeof useAgentsStore.getState>["sessions"];
  zoom: number;
}) {
  const nodes = buildFleetNodes({ catalog, history, pings, profiles, runtimes, sessions });
  const activeCount = nodes.filter((node) => node.status !== "idle" && node.status !== "missing").length;
  const readyCount = catalog.filter((entry) => entry.id !== "custom" && pings[entry.id]?.installed).length;

  return (
    <div className="agent-map-stage" style={{ ["--fleet-zoom" as string]: zoom / 100 }}>
      <div className="agent-fleet-field">
        <svg className="agent-fleet-links" viewBox="0 0 100 100" aria-hidden="true">
          {nodes.map((node) => (
            <line
              key={node.id}
              x1="50"
              x2={node.x}
              y1="50"
              y2={node.y}
            />
          ))}
        </svg>

        <section className="agent-fleet-hub" aria-label="Agent fleet summary">
          <span className="agent-fleet-hub-icon">
            <Cpu size={20} />
          </span>
          <strong>{profiles.length}</strong>
          <small>{activeCount} active</small>
          <em>{readyCount}/{Math.max(catalog.filter((entry) => entry.id !== "custom").length, 1)} CLIs ready</em>
        </section>

        {nodes.map((node) => (
          <article
            className={`agent-fleet-node tone-${fleetTone(node.status)}`}
            key={node.id}
            style={{ ["--node-accent" as string]: node.accent, left: `${node.x}%`, top: `${node.y}%` }}
          >
            <span className="agent-fleet-avatar">
              <Bot size={15} />
            </span>
            <span className="agent-fleet-copy">
              <strong>{node.name}</strong>
              <small>{node.role}</small>
            </span>
            <span className="agent-fleet-status">{node.status === "missing" ? "Missing" : statusLabel[node.status]}</span>
            <em>{node.metric}</em>
          </article>
        ))}

        {nodes.length === 0 && (
          <section className="agent-fleet-empty">
            <Bot size={22} />
            <strong>No agent data yet</strong>
            <small>Create an agent or run CLI diagnostics to populate the fleet map.</small>
          </section>
        )}
      </div>
      <div className="agent-map-vignette" />
      <div className="agent-map-grid" />
    </div>
  );
}

function buildFleetNodes({
  catalog,
  history,
  pings,
  profiles,
  runtimes,
  sessions,
}: {
  catalog: AgentCliDescriptor[];
  history: ReturnType<typeof useAgentsStore.getState>["history"];
  pings: PingMap;
  profiles: AgentProfile[];
  runtimes: ReturnType<typeof useAgentsStore.getState>["runtimes"];
  sessions: ReturnType<typeof useAgentsStore.getState>["sessions"];
}): FleetNode[] {
  if (profiles.length > 0) {
    return profiles.slice(0, fleetPositions.length).map((profile, index) => {
      const runtime = runtimes[profile.id];
      const session = sessions.find((item) => item.profileId === profile.id);
      const runs = history.filter((run) => run.profileId === profile.id);
      const completed = runs.filter((run) => run.status === "completed").length;
      const status = session?.status ?? runtime?.status ?? profile.stats.lastStatus ?? "idle";
      return {
        accent: profile.accent,
        detail: profile.model,
        id: profile.id,
        metric: `${completed}/${runs.length} runs`,
        name: profile.name,
        role: profile.role,
        status,
        ...fleetPositions[index],
      };
    });
  }

  return catalog
    .filter((entry) => entry.id !== "custom")
    .slice(0, fleetPositions.length)
    .map((entry, index) => {
      const ping = pings[entry.id];
      const runs = history.filter((run) => run.cliId === entry.id);
      const completed = runs.filter((run) => run.status === "completed").length;
      return {
        accent: entry.accent,
        detail: entry.vendor,
        id: entry.id,
        metric: `${completed}/${runs.length} runs`,
        name: entry.displayName,
        role: ping?.command ?? entry.vendor,
        status: ping?.installed ? "idle" : "missing",
        ...fleetPositions[index],
      };
    });
}

function fleetTone(status: FleetNode["status"]): "active" | "busy" | "done" | "error" | "idle" {
  if (status === "missing") return "error";
  return statusTone[status];
}

function QuickStartGrid({
  history,
  onCreateQuickStart,
  pings,
  quickStarts,
  seeding,
}: {
  history: ReturnType<typeof useAgentsStore.getState>["history"];
  onCreateQuickStart: (preset: QuickStartPreset) => Promise<void>;
  pings: PingMap;
  quickStarts: QuickStartPreset[];
  seeding: string | null;
}) {
  return (
    <div className="reference-agent-grid">
      {quickStarts.map((preset) => {
        const ping = preset ? pings[preset.cliId] : null;
        const cliRuns = history.filter((run) => run.cliId === preset.cliId);
        const completedRuns = cliRuns.filter((run) => run.status === "completed").length;
        const totalMs = cliRuns.reduce((sum, run) => {
          if (!run.endedAt) return sum;
          const started = Date.parse(run.startedAt);
          const ended = Date.parse(run.endedAt);
          return Number.isFinite(started) && Number.isFinite(ended) ? sum + Math.max(0, ended - started) : sum;
        }, 0);
        return (
          <article
            className="reference-agent-card"
            key={preset.cliId}
            style={{ ["--cli-accent" as string]: ping?.installed ? "#38bdf8" : "#94a3b8" }}
          >
            <header>
              <span className="reference-agent-avatar">{preset.name.slice(0, 2).toUpperCase()}</span>
              <div className="reference-agent-copy">
                <strong>{preset.name}</strong>
                <small>{preset.role}</small>
              </div>
              <span className={`status-pill tone-${ping?.installed ? "done" : "idle"}`}>
                {ping?.installed ? "Ready" : "Missing"}
              </span>
            </header>

            <div className="reference-agent-metrics">
              <div>
                <strong>{ping?.latencyMs ?? 0}ms</strong>
                <small>CLI Latency</small>
              </div>
              <div>
                <strong>{completedRuns}</strong>
                <small>Completed Runs</small>
              </div>
              <div>
                <strong>{formatDuration(totalMs)}</strong>
                <small>Total Time</small>
              </div>
            </div>

            <div className="reference-agent-tools" aria-label={`${preset.name} runtime`}>
              <span>{preset.cliId}</span>
              <span>{ping?.command ?? "not found"}</span>
              <span>{ping?.version?.slice(0, 18) ?? "no version"}</span>
            </div>

            <button
              className="reference-agent-launch"
              disabled={!preset || seeding === preset.cliId}
              onClick={() => preset && void onCreateQuickStart(preset)}
            >
              {seeding === preset?.cliId ? <Loader2 className="spin" size={13} /> : <Plus size={13} />}
              {preset ? ping?.installed ? "Create from CLI" : "Create template" : "Template"}
            </button>
          </article>
        );
      })}
      {quickStarts.length === 0 && <p className="agents-empty-inline">No CLI catalog entries loaded yet.</p>}
    </div>
  );
}

function CliTable({ catalog, pings }: { catalog: AgentCliDescriptor[]; pings: PingMap }) {
  return (
    <div className="cli-table-wrap">
      <table className="cli-table">
        <thead>
          <tr>
            <th>CLI</th>
            <th>Vendor</th>
            <th>Status</th>
            <th>Version</th>
            <th>Models</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((entry) => {
            const ping = pings[entry.id];
            return (
              <tr key={entry.id}>
                <td>
                  <span className="cli-dot" style={{ background: entry.accent }} />
                  {entry.displayName}
                </td>
                <td>{entry.vendor}</td>
                <td>
                  <span className={`state-pill ${ping?.installed ? "ok" : "bad"}`}>
                    {ping ? (ping.installed ? "ready" : "missing") : "…"}
                  </span>
                </td>
                <td className="mono">{ping?.version?.slice(0, 40) ?? "—"}</td>
                <td>{entry.models.length}</td>
                <td className="mono">{ping ? `${ping.latencyMs}ms` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CliCards({ catalog, pings }: { catalog: AgentCliDescriptor[]; pings: PingMap }) {
  return (
    <div className="cli-card-grid">
      {catalog.map((entry) => {
        const ping = pings[entry.id];
        return (
          <article key={entry.id} className="cli-card" style={{ ["--cli-accent" as string]: entry.accent }}>
            <header>
              <span className="cli-avatar">{entry.displayName.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{entry.displayName}</strong>
                <small>{entry.vendor}</small>
              </div>
              <span className={`state-pill ${ping?.installed ? "ok" : "bad"}`}>
                {ping ? (ping.installed ? "ready" : "missing") : "…"}
              </span>
            </header>
            <p>{entry.description}</p>
            <footer>
              <span>{entry.models.length} models</span>
              <span className="mono">{ping?.version?.slice(0, 22) ?? "not detected"}</span>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

function AgentCard({
  installed,
  live,
  profile,
  status,
  onDelete,
  onEdit,
  onRun,
  onTerminal,
}: {
  installed: boolean;
  live: boolean;
  profile: AgentProfile;
  status?: AgentStatus;
  onDelete: () => void;
  onEdit: () => void;
  onRun: () => void;
  onTerminal: () => void;
}) {
  const tone = status ? statusTone[status] : "idle";

  return (
    <article className="agent-card" style={{ ["--cli-accent" as string]: profile.accent }}>
      <header>
        <span className="agent-card-avatar">{profile.name.slice(0, 2).toUpperCase()}</span>
        <div className="agent-card-copy">
          <strong>{profile.name}</strong>
          <small>{profile.role}</small>
        </div>
        <span className={`status-pill tone-${live ? "active" : tone}`}>
          {live ? "Running" : status ? statusLabel[status] : "Idle"}
        </span>
      </header>

      <div className="agent-metrics">
        <div>
          <strong>{profile.stats.successRate}%</strong>
          <small>Success Rate</small>
        </div>
        <div>
          <strong>{profile.stats.completed}</strong>
          <small>Tasks Completed</small>
        </div>
        <div>
          <strong>{formatDuration(profile.stats.totalMs)}</strong>
          <small>Total Time</small>
        </div>
      </div>

      <div className="agent-chips">
        <span className="chip">
          <Terminal size={11} />
          {profile.cliId}
        </span>
        <span className="chip">{profile.model}</span>
        {profile.interactive && <span className="chip">interactive</span>}
        {installed ? (
          <span className="chip ok">
            <CircleCheck size={11} />
            ready
          </span>
        ) : (
          <span className="chip warn">
            <AlertTriangle size={11} />
            CLI missing
          </span>
        )}
      </div>

      <footer className="agent-card-actions">
        <button className="ghost-button" onClick={onRun} disabled={!installed}>
          <Play size={13} />
          Run
        </button>
        <button className="ghost-button" onClick={onTerminal}>
          <Terminal size={13} />
          Terminal
        </button>
        <button className="icon-button" onClick={onEdit} aria-label={`Edit ${profile.name}`}>
          <Pencil size={14} />
        </button>
        <button className="icon-button danger" onClick={onDelete} aria-label={`Delete ${profile.name}`}>
          <Trash2 size={14} />
        </button>
      </footer>
    </article>
  );
}

function ActivityFeed({
  activity,
  expanded,
  onToggleExpanded,
  profiles,
}: {
  activity: ReturnType<typeof useAgentsStore.getState>["activity"];
  expanded: boolean;
  onToggleExpanded: () => void;
  profiles: AgentProfile[];
}) {
  const items = activity.slice(0, expanded ? 24 : 8).map((entry) => {
    const profile = profiles.find((item) => item.id === entry.profileId);
    return {
      id: entry.id,
      name: profile?.name ?? "Agent",
      detail: entry.detail,
      status: entry.title,
      tone: statusTone[entry.status],
      time: timeAgo(entry.at),
      accent: profile?.accent ?? "#8b5cf6",
    };
  });

  return (
    <section className="rail-card">
      <header>
        <h2>Agent Activity Feed</h2>
        <button className="rail-link" onClick={onToggleExpanded}>
          {expanded ? "View Recent" : "View All"}
        </button>
      </header>
      <ul className="activity-list">
        {items.map((entry) => (
          <li key={entry.id}>
            <span className="activity-avatar" style={{ ["--cli-accent" as string]: entry.accent }}>
              <Bot size={15} />
            </span>
            <span className="activity-copy">
              <strong>{entry.name}</strong>
              <small>{entry.detail}</small>
            </span>
            <span className={`activity-pill tone-${entry.tone}`}>{entry.status}</span>
            <span className="activity-time">{entry.time}</span>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p className="agents-empty-inline">Run an agent to populate live activity.</p>}
    </section>
  );
}

function PerformancePanel({
  days,
  history,
  onChangeDays,
}: {
  days: number;
  history: ReturnType<typeof useAgentsStore.getState>["history"];
  onChangeDays: () => void;
}) {
  const buckets = useMemo(() => {
    const now = Date.now();
    return Array.from({ length: days }, (_, index) => {
      const dayStart = now - (days - 1 - index) * 86_400_000;
      const label = new Date(dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const runs = history.filter((run) => {
        const started = new Date(run.startedAt).getTime();
        return started >= dayStart - 43_200_000 && started < dayStart + 43_200_000;
      });
      const finished = runs.filter((run) => run.status === "completed" || run.status === "failed");
      const completed = finished.filter((run) => run.status === "completed").length;
      const success = finished.length
        ? Math.round((completed / finished.length) * 100)
        : 0;
      return { label, runs: runs.length, completed, success };
    });
  }, [days, history]);

  const labels = buckets.map((bucket) => bucket.label);
  const maxRuns = Math.max(...buckets.map((bucket) => bucket.runs), 1);
  const series = [
    { label: "Success Rate", color: "#a78bfa", values: buckets.map((bucket) => bucket.success) },
    {
      label: "Run Volume",
      color: "#60a5fa",
      values: buckets.map((bucket) => Math.round((bucket.runs / maxRuns) * 100)),
    },
    {
      label: "Tasks Completed",
      color: "#34d399",
      values: buckets.map((bucket) => Math.round((bucket.completed / maxRuns) * 100)),
    },
  ];

  return (
    <section className="rail-card">
      <header>
        <h2>Agent Performance</h2>
        <button className="rail-select" onClick={onChangeDays}>
          Last {days} days
          <ChevronDown size={12} />
        </button>
      </header>
      <div className="perf-line-chart">
        <div className="perf-axis-y" aria-hidden="true">
          <span>100%</span>
          <span>75%</span>
          <span>50%</span>
          <span>25%</span>
          <span>0%</span>
        </div>
        <svg viewBox="0 0 320 155" role="img" aria-label="Agent performance for the last 7 days">
          <defs>
            <linearGradient id="perfGlow" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#67e8f9" stopOpacity="0.16" />
            </linearGradient>
          </defs>
          {[0, 38, 76, 114, 152].map((y) => (
            <line className="perf-grid-line" key={y} x1="0" x2="320" y1={y} y2={y} />
          ))}
          <rect className="perf-chart-fill" x="0" y="0" width="320" height="155" />
          {series.map((item) => (
            <g key={item.label}>
              <polyline points={pointsFor(item.values)} fill="none" stroke={item.color} strokeWidth="2" />
              {item.values.map((value, index) => {
                const x = (index / Math.max(item.values.length - 1, 1)) * 320;
                const y = 152 - (value / 100) * 145;
                return <circle key={`${item.label}-${index}`} cx={x} cy={y} r="3" fill="#08101f" stroke={item.color} strokeWidth="2" />;
              })}
            </g>
          ))}
        </svg>
        <div className="perf-axis-x" aria-hidden="true">
          {labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
      <ul className="perf-legend">
        {series.map((item) => (
          <li key={item.label}>
            <i style={{ background: item.color }} />
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResourcePanel({
  active,
  historyCount,
  readyClis,
  successRate,
  total,
  totalClis,
}: {
  active: number;
  historyCount: number;
  readyClis: number;
  successRate: number;
  total: number;
  totalClis: number;
}) {
  const rings: Array<{ label: string; value: number; color: string; cap?: string }> = [
    { label: "Active Agents", value: Math.round((active / total) * 100), color: "#8b5cf6" },
    { label: "CLI Readiness", value: Math.round((readyClis / Math.max(totalClis, 1)) * 100), color: "#60a5fa" },
    { label: "Run History", value: Math.min(Math.round((historyCount / 50) * 100), 100), color: "#94a3b8" },
    { label: "Success Rate", value: successRate, color: "#34d399" },
  ];

  return (
    <section className="rail-card">
      <header>
        <h2>Resource Usage</h2>
      </header>
      <div className="ring-grid">
        {rings.map((ring) => (
          <div className="ring" key={ring.label}>
            <svg viewBox="0 0 46 46" role="img" aria-label={`${ring.label} ${ring.value}%`}>
              <circle cx="23" cy="23" r="19" className="ring-track" />
              <circle
                cx="23"
                cy="23"
                r="19"
                className="ring-value"
                stroke={ring.color}
                strokeDasharray={`${(ring.value / 100) * 119.4} 119.4`}
              />
              {ring.cap && (
                <circle cx="23" cy="23" r="19" className="ring-cap" stroke={ring.cap} strokeDasharray="8 119.4" />
              )}
            </svg>
            <strong>{ring.value}%</strong>
            <small>{ring.label}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function pointsFor(values: number[]): string {
  if (values.length === 0) return "";
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 320;
      const y = 152 - (Math.max(0, Math.min(value, 100)) / 100) * 145;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function timeAgo(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "now";
  const minutes = Math.max(Math.round(diff / 60_000), 0);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function countForTab(
  key: TabKey,
  profiles: AgentProfile[],
  runtimes: ReturnType<typeof useAgentsStore.getState>["runtimes"],
  sessions: ReturnType<typeof useAgentsStore.getState>["sessions"],
): number {
  if (key === "all") return profiles.length;
  return profiles.filter((profile) => {
    const isLive = sessions.some((session) => session.profileId === profile.id);
    const runtime = runtimes[profile.id];
    const tone = runtime ? statusTone[runtime.status] : "idle";
    if (key === "active") return isLive;
    if (key === "busy") return tone === "busy";
    if (key === "idle") return !isLive && tone !== "busy";
    return !profile.enabled;
  }).length;
}

function workspaceName(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) return "Local Workspace";
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? "Local Workspace";
}

function workspaceInitials(name: string): string {
  return name
    .split(/\s+|[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .padEnd(2, "A");
}

function formatDuration(ms: number): string {
  if (!ms) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
