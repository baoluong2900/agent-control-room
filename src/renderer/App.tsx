import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  ChevronRight,
  Code2,
  Cpu,
} from "lucide-react";
import type {
  AgentCliDescriptor,
  AgentCliId,
  AgentRunInput,
  AgentRunRecord,
  AppIdentity,
  AgentStatus,
  DiagnosticAction,
  SystemDiagnostics,
  WorkflowActivityEntry,
} from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentFace } from "./agents/AgentFace";
import { AgentsPage } from "./agents/AgentsPage";
import { resolveModuleSeed, sortAgentCatalog } from "./agents/agent-modules";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { AnalyticsModule } from "./analytics/AnalyticsModule";
import { IntegrationsModule } from "./integrations/IntegrationsModule";
import { KnowledgeModule } from "./knowledge/KnowledgeModule";
import { WorkspaceMap3D } from "./map/WorkspaceMap3D";
import { ProjectsModule } from "./projects/ProjectsModule";
import { SettingsModule } from "./settings/SettingsModule";
import { TasksModule } from "./tasks/TasksModule";
import { WorkflowsModule } from "./workflows/WorkflowsModule";
import { navForOverviewZone, isWorkspaceNavKey, type WorkspaceNavKey } from "./workspace-navigation";
import { useWorkspaceStore } from "./stores/workspace-store";

type Accent = "blue" | "cyan" | "purple" | "amber" | "green" | "orange";

const statusToZone: Partial<Record<AgentStatus, string>> = {
  planning: "planning",
  reading: "documents",
  coding: "code",
  testing: "testing",
  reviewing: "code",
  completed: "deployment",
  failed: "monitoring",
  stopped: "monitoring",
};

const activeRunStatuses = new Set<AgentStatus>([
  "queued",
  "planning",
  "moving",
  "reading",
  "coding",
  "testing",
  "reviewing",
  "waiting-approval",
]);

const usageColors = ["#67e8f9", "#fbbf24", "#86efac", "#60a5fa", "#a78bfa"];

type ModelUsageItem = {
  barWidth: number;
  color: string;
  detail: string;
  meta: string;
  name: string;
  percent: number;
  runs: number;
};

function SystemOverview({
  activeRunId,
  activeStatus,
  diagnostics,
  history,
}: {
  activeRunId: string | null;
  activeStatus: AgentStatus;
  diagnostics: SystemDiagnostics | null;
  history: AgentRunRecord[];
}) {
  const counts = new Map<AgentStatus, number>();
  for (const run of history) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  }
  if (activeRunId && !history.some((run) => run.id === activeRunId)) {
    counts.set(activeStatus, (counts.get(activeStatus) ?? 0) + 1);
  }

  const activeAgents = [...activeRunStatuses].reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  const readyTools = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const totalTools = diagnostics?.tools.length ?? 0;
  const rows = [
    {
      label: "Planning",
      value: (counts.get("queued") ?? 0) + (counts.get("planning") ?? 0) + (counts.get("waiting-approval") ?? 0),
      legend: "legend-blue",
    },
    {
      label: "Coding",
      value: (counts.get("coding") ?? 0) + (counts.get("reviewing") ?? 0),
      legend: "legend-green",
    },
    { label: "Testing", value: counts.get("testing") ?? 0, legend: "legend-purple" },
    { label: "Deploying", value: counts.get("completed") ?? 0, legend: "legend-amber" },
    { label: "Monitoring", value: (counts.get("failed") ?? 0) + (counts.get("stopped") ?? 0), legend: "legend-orange" },
  ];

  return (
    <section className="analytics-card system-overview">
      <header>
        <div>
          <h2>System Overview</h2>
          <p>{totalTools ? `${readyTools}/${totalTools} tools ready` : "Diagnostics pending"}</p>
        </div>
      </header>
      <div className="overview-body">
        <div className="donut-chart">
          <span>
            <strong>{activeAgents}</strong>
            <small>Active Agents</small>
          </span>
        </div>
        <ul>
          {rows.map((row) => (
            <li key={row.label}>
              <i className={row.legend} />
              {row.label} <strong>{row.value}</strong>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function TaskThroughput({ history }: { history: AgentRunRecord[] }) {
  const now = Date.now();
  const current = countRunsBetween(history, now - 86_400_000, now);
  const previous = countRunsBetween(history, now - 172_800_000, now - 86_400_000);
  const delta = previous === 0 ? (current > 0 ? 100 : 0) : ((current - previous) / previous) * 100;
  const buckets = bucketRuns(history, 12, 24);
  const line = sparklinePath(buckets, 230, 76);
  const area = `${line} L230,76 L0,76 Z`;
  const lastPoint = sparklineLastPoint(buckets, 230, 76);

  return (
    <section className="analytics-card throughput-card">
      <header>
        <div>
          <h2>Task Throughput</h2>
          <p>Last 24 hours</p>
        </div>
        <span className="live-badge">LIVE</span>
      </header>
      <div className="throughput-number">
        <strong>{current}</strong>
        <span>{delta >= 0 ? "+" : ""}{delta.toFixed(1)}%</span>
      </div>
      <div className="line-chart">
        <i className="grid-line one" />
        <i className="grid-line two" />
        <i className="grid-line three" />
        <svg viewBox="0 0 230 76" preserveAspectRatio="none" role="img" aria-label="Agent run throughput over the last 24 hours">
          <defs>
            <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity=".28" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="area" d={area} />
          <path className="line" d={line} />
          <circle cx={lastPoint.x} cy={lastPoint.y} r="3.5" />
        </svg>
      </div>
      <div className="chart-axis">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
      </div>
    </section>
  );
}

function ModelUsage({ history, onOpenAnalytics }: { history: AgentRunRecord[]; onOpenAnalytics: () => void }) {
  const [catalog, setCatalog] = useState<AgentCliDescriptor[]>([]);

  useEffect(() => {
    let mounted = true;
    window.agentic.agents.catalog().then((items) => {
      if (mounted) setCatalog(items);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const hasHistory = history.length > 0;
  const usage = useMemo(
    () => (hasHistory ? modelUsageFromHistory(history) : modelDefaultsFromCatalog(catalog)),
    [catalog, hasHistory, history],
  );

  return (
    <section className="analytics-card model-usage">
      <header>
        <div>
          <h2>{hasHistory ? "Model Usage" : "Working Models"}</h2>
          <p>{hasHistory ? "By Runs" : "Catalog loadouts"}</p>
        </div>
      </header>
      <div className="usage-list">
        {usage.map((model) => (
          <div className="usage-row" key={model.name}>
            <div>
              <span>{model.name}</span>
              <span>{model.detail}</span>
              <span>{model.meta}</span>
            </div>
            <i>
              <b style={{ width: `${model.barWidth}%`, background: model.color }} />
            </i>
          </div>
        ))}
        {usage.length === 0 && <p>{hasHistory ? "No agent runs recorded yet." : "CLI catalog loading…"}</p>}
      </div>
      <button className="analytics-link" onClick={onOpenAnalytics}>
        View full analytics <ChevronRight size={13} />
      </button>
    </section>
  );
}

function WorkflowActivity() {
  const [activity, setActivity] = useState<WorkflowActivityEntry[]>([]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const next = await window.agentic.workflows.activity(5);
      if (mounted) setActivity(next);
    };
    void load();
    const unsubscribe = window.agentic.events.subscribeWorkflow(() => {
      void load();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <section className="bottom-card workflow-activity">
      <header>
        <h2>Workflow Activity</h2>
        <span>
          <i />
          Real-time
        </span>
      </header>
      <div className="timeline">
        {activity.map((item, index) => {
          const Icon = item.kind === "failed" ? Code2 : BrainCircuit;
          return (
            <div className="timeline-event" key={item.id}>
              <span className={`timeline-icon accent-${activityAccent(item.kind)}`}>
                <Icon size={17} />
              </span>
              <span className="timeline-copy">
                <strong>{item.workflowName}</strong>
                <small>{item.headline}</small>
                <em>{relativeTime(item.at)}</em>
              </span>
              {index < activity.length - 1 && <ChevronRight className="timeline-arrow" size={14} />}
            </div>
          );
        })}
        {activity.length === 0 && <p>No workflow runs recorded yet.</p>}
      </div>
      <div className="timeline-track">
        {activity.map((item) => (
          <i key={item.id} className={`dot-${activityAccent(item.kind)}`} />
        ))}
      </div>
    </section>
  );
}

function ModelSelection() {
  const [catalog, setCatalog] = useState<AgentCliDescriptor[]>([]);

  useEffect(() => {
    let mounted = true;
    window.agentic.agents.catalog().then((items) => {
      if (mounted) setCatalog(items);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const defaults = sortAgentCatalog(catalog.filter((entry) => entry.id !== "custom"))
    .slice(0, 5)
    .map((entry, index) => {
      const model = entry.models.find((item) => item.recommended) ?? entry.models[0];
      const agent = resolveModuleSeed({ cliId: entry.id });
      return {
        agentName: agent.name,
        cliId: entry.id,
        cliName: entry.displayName,
        mission: agent.summary,
        mode: agent.mode,
        modelId: model?.id ?? "default",
        modelLabel: model?.label ?? entry.displayName,
        modelNote: model?.note ?? entry.vendor,
        accent: entry.accent,
        tone: ["green", "orange", "blue", "cyan", "purple"][index % 5] as Accent,
      };
    });

  return (
    <section className="bottom-card model-selection">
      <header>
        <div>
          <h2>Working Model Roster</h2>
          <p>Agent names, missions, CLI loadouts</p>
        </div>
        <Cpu size={16} />
      </header>
      <div className="model-options">
        {defaults.map((model) => {
          return (
            <article key={`${model.cliName}-${model.modelId}`} className="overview-model-card">
              <span className={`model-icon accent-${model.tone}`}>
                <AgentFace
                  accent={model.accent}
                  cliId={model.cliId}
                  size="sm"
                  title={`${model.cliName} agent face`}
                />
              </span>
              <strong>{model.agentName}</strong>
              <small>{model.cliName} · {model.modelLabel}</small>
              <em>{model.mode}</em>
              <p>{model.mission}</p>
            </article>
          );
        })}
        {defaults.length === 0 && <p>CLI catalog loading…</p>}
      </div>
    </section>
  );
}

function countRunsBetween(history: AgentRunRecord[], start: number, end: number): number {
  return history.filter((run) => {
    const started = Date.parse(run.startedAt);
    return Number.isFinite(started) && started >= start && started < end;
  }).length;
}

function bucketRuns(history: AgentRunRecord[], bucketCount: number, hours: number): number[] {
  const now = Date.now();
  const windowMs = hours * 3_600_000;
  const bucketMs = windowMs / bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => {
    const start = now - windowMs + index * bucketMs;
    return countRunsBetween(history, start, start + bucketMs);
  });
}

function sparklinePath(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - (value / max) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function sparklineLastPoint(values: number[], width: number, height: number): { x: number; y: number } {
  const max = Math.max(...values, 1);
  const index = Math.max(values.length - 1, 0);
  return {
    x: values.length <= 1 ? 0 : width,
    y: height - ((values[index] ?? 0) / max) * (height - 6) - 3,
  };
}

function modelUsageFromHistory(history: AgentRunRecord[]): ModelUsageItem[] {
  const counts = new Map<string, number>();
  for (const run of history) {
    const key = run.model?.trim() || run.cliId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = history.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, runs], index) => ({
      barWidth: Math.min(100, Math.max(8, Number((((runs / total) * 100) * 2.2).toFixed(1)))),
      name,
      runs,
      percent: Number(((runs / total) * 100).toFixed(1)),
      detail: `${Number(((runs / total) * 100).toFixed(1))}%`,
      meta: `${runs} run${runs === 1 ? "" : "s"}`,
      color: usageColors[index % usageColors.length],
    }));
}

function modelDefaultsFromCatalog(catalog: AgentCliDescriptor[]): ModelUsageItem[] {
  return sortAgentCatalog(catalog.filter((entry) => entry.id !== "custom"))
    .slice(0, 5)
    .map((entry, index) => {
      const model = entry.models.find((item) => item.recommended) ?? entry.models[0];
      const agent = resolveModuleSeed({ cliId: entry.id });
      return {
        barWidth: 76,
        color: usageColors[index % usageColors.length],
        detail: shortCliLabel(entry.displayName),
        meta: agent.mode,
        name: model?.label ?? entry.displayName,
        percent: 0,
        runs: 0,
      };
    });
}

function shortCliLabel(displayName: string): string {
  return displayName
    .replace(/\sCLI$/i, "")
    .replace(/\sCode$/i, "")
    .replace(/\sBuild$/i, "")
    .replace(/\sDeveloper$/i, "")
    .split(/\s+/)[0]
    .slice(0, 8);
}

function activityAccent(kind: WorkflowActivityEntry["kind"]): Accent {
  if (kind === "failed") return "orange";
  if (kind === "completed") return "green";
  if (kind === "paused") return "amber";
  if (kind === "processed") return "cyan";
  return "blue";
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function OverviewDashboard({
  activeStatus,
  activeRunId,
  diagnostics,
  history,
  selectedZone,
  onNavigate,
  onOpenAgents,
  onOpenAnalytics,
  onSelectZone,
}: {
  activeStatus: AgentStatus;
  activeRunId: string | null;
  diagnostics: SystemDiagnostics | null;
  history: AgentRunRecord[];
  selectedZone: string;
  onNavigate: (nav: WorkspaceNavKey) => void;
  onOpenAgents: () => void;
  onOpenAnalytics: () => void;
  onSelectZone: (zone: string) => void;
}) {
  const selectedModule = navForOverviewZone(selectedZone);

  return (
    <>
      <div className="content-grid desktop-content-grid overview-content-grid">
        <div className="workspace-column overview-workspace-column">
          <section className="hero-heading overview-hero">
            <div>
              <h1>AI Agent Workspace</h1>
              <p>Coordinate your agents. Ship better software.</p>
            </div>
          </section>
          <section className="overview-sync-strip">
            <div>
              <span>Selected Zone</span>
              <strong>{selectedModule.label}</strong>
              <small>{selectedModule.summary}</small>
            </div>
            <div className="overview-sync-actions">
              <button className="ghost-button" onClick={onOpenAgents} type="button">
                Open Agents
              </button>
              <button className="primary-action" onClick={() => onNavigate(selectedModule.key)} type="button">
                Open {selectedModule.label}
              </button>
            </div>
          </section>
          <WorkspaceMap3D
            activeStatus={activeStatus}
            history={history}
            selectedZone={selectedZone}
            onOpenZone={(zone) => {
              onSelectZone(zone);
              onNavigate(navForOverviewZone(zone).key);
            }}
            onSelectZone={onSelectZone}
          />
        </div>
        <aside className="analytics-rail overview-analytics-rail" aria-label="System analytics">
          <SystemOverview activeRunId={activeRunId} activeStatus={activeStatus} diagnostics={diagnostics} history={history} />
          <TaskThroughput history={history} />
          <ModelUsage history={history} onOpenAnalytics={onOpenAnalytics} />
        </aside>
      </div>

      <div className="bottom-grid">
        <WorkflowActivity />
        <ModelSelection />
      </div>
    </>
  );
}

function BootErrorScreen({ message }: { message: string }) {
  return (
    <main className="boot-error-screen">
      <section className="boot-error-panel">
        <span>
          <AlertTriangle size={18} />
        </span>
        <div>
          <h1>AgenticOS could not start</h1>
          <p>{message}</p>
        </div>
      </section>
    </main>
  );
}

function formatBootError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [activeNav, setActiveNav] = useState<WorkspaceNavKey>("Overview");
  const [bootError, setBootError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [identity, setIdentity] = useState<AppIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const previousIdentityStatus = useRef<AppIdentity["status"] | null>(null);
  const {
    activeRunId,
    activeStatus,
    clearTerminal,
    diagnostics,
    gitDiff,
    history,
    ingestEvent,
    project,
    recentProjects,
    selectedZone,
    setActiveRun,
    setDiagnostics,
    setGitDiff,
    setHistory,
    setProject,
    setRecentProjects,
    setSelectedZone,
    terminalLines,
  } = useWorkspaceStore();
  const bridgeAvailable =
    typeof window !== "undefined" && Boolean((window as Window & { agentic?: unknown }).agentic);
  const bridgeErrorMessage = "Electron preload bridge is not available. Start the desktop app with npm run dev or the packaged app binary.";

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      setBootError(event.error instanceof Error ? event.error.message : event.message);
      setIdentityLoading(false);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      setBootError(formatBootError(event.reason));
      setIdentityLoading(false);
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    if (!bridgeAvailable) {
      setBootError(bridgeErrorMessage);
      setIdentityLoading(false);
      return () => {
        window.removeEventListener("error", handleWindowError);
        window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      };
    }

    void loadInitialState();
    let unsubscribe = () => {};
    try {
      unsubscribe = window.agentic.events.subscribe((event) => {
        ingestEvent(event);
        const nextZone = event.status ? statusToZone[event.status] : null;
        if (nextZone) {
          setSelectedZone(nextZone);
        }
        if (event.type === "run:exit" || event.type === "run:error") {
          void refreshHistory();
        }
      });
    } catch (error) {
      setBootError(formatBootError(error));
      setIdentityLoading(false);
    }

    return () => {
      unsubscribe();
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [bridgeAvailable, ingestEvent, setSelectedZone]);

  useEffect(() => {
    const nextStatus = identity?.status ?? null;
    if (previousIdentityStatus.current === "signed-out" && nextStatus === "signed-in") {
      setActiveNav("Overview");
    }
    previousIdentityStatus.current = nextStatus;
  }, [identity?.status]);

  const navigate = useMemo(
    () => (nav: WorkspaceNavKey | string) => {
      setActiveNav(isWorkspaceNavKey(nav) ? nav : "Overview");
    },
    [],
  );

  async function loadInitialState() {
    try {
      const nextIdentity = await refreshIdentity();
      await Promise.all([refreshDiagnostics(project?.path), refreshHistory(), refreshProjects()]);
      return nextIdentity;
    } catch (error) {
      setBootError(formatBootError(error));
      return null;
    } finally {
      setIdentityLoading(false);
    }
  }

  async function refreshIdentity() {
    const nextIdentity = await window.agentic.settings.getIdentity();
    setIdentity(nextIdentity);
    return nextIdentity;
  }

  async function refreshDiagnostics(projectPath: string | null | undefined = project?.path) {
    const nextDiagnostics = await window.agentic.system.diagnostics(projectPath);
    setDiagnostics(nextDiagnostics);
  }

  async function refreshProjects() {
    const projects = await window.agentic.projects.listRecent();
    setRecentProjects(projects);
    if (!project && projects[0]) {
      setProject(projects[0]);
      await Promise.all([refreshGitDiff(projects[0].path), refreshDiagnostics(projects[0].path)]);
      void ensureKnowledgeSnapshot(projects[0].path);
    }
  }

  async function refreshHistory() {
    const runs = await window.agentic.agents.history();
    setHistory(runs);
  }

  async function refreshGitDiff(cwd: string | null | undefined = project?.path) {
    if (!cwd) {
      setGitDiff(null);
      return;
    }
    const diff = await window.agentic.git.diff(cwd);
    setGitDiff(diff);
  }

  async function selectProject() {
    const nextProject = await window.agentic.projects.selectFolder();
    if (!nextProject) return;
    setProject(nextProject);
    await Promise.all([refreshProjects(), refreshGitDiff(nextProject.path), refreshDiagnostics(nextProject.path)]);
    void ensureKnowledgeSnapshot(nextProject.path);
  }

  async function selectRecentProject(nextProject: NonNullable<typeof project>) {
    setProject(nextProject);
    await Promise.all([refreshGitDiff(nextProject.path), refreshDiagnostics(nextProject.path)]);
  }

  /** Forgets a folder from the recent list, clearing selection if it was active. */
  async function removeRecentProject(projectPath: string) {
    const remaining = await window.agentic.projects.remove(projectPath);
    setRecentProjects(remaining);
    if (project?.path !== projectPath) return;

    const next = remaining[0] ?? null;
    setProject(next);
    // Pass null explicitly: the default parameter would fall back to the
    // now-removed project path still held in state.
    await Promise.all([refreshGitDiff(next?.path ?? null), refreshDiagnostics(next?.path ?? null)]);
  }

  /** Opens the native folder dialog and returns the picked path. */
  async function pickFolder(): Promise<string | null> {
    const nextProject = await window.agentic.projects.selectFolder();
    if (!nextProject) return null;
    setProject(nextProject);
    await Promise.all([refreshProjects(), refreshGitDiff(nextProject.path), refreshDiagnostics(nextProject.path)]);
    void ensureKnowledgeSnapshot(nextProject.path);
    return nextProject.path;
  }

  async function ensureKnowledgeSnapshot(projectPath: string) {
    try {
      const existing = await window.agentic.knowledge.get(projectPath);
      if (!existing) {
        await window.agentic.knowledge.scan({ projectPath, maxFiles: 800, maxFileBytes: 200_000 });
      }
    } catch {
      // Knowledge indexing is opportunistic and should not block workspace use.
    }
  }

  async function startAgent(input: { cliId: AgentCliId; model: string; prompt: string; shellCommand?: string; taskId?: string }) {
    if (!project) return;

    clearTerminal();
    const runInput: AgentRunInput = {
      cliId: input.cliId,
      cwd: project.path,
      model: input.model,
      prompt: input.prompt,
      shellCommand: input.shellCommand,
      taskId: input.taskId,
    };
    const process = await window.agentic.agents.start(runInput);
    setActiveRun(process.runId, process.status);
    await refreshHistory();
  }

  async function stopAgent(runId: string) {
    await window.agentic.agents.stop(runId);
    setActiveRun(runId, "stopped");
    await refreshHistory();
  }

  async function signOut() {
    const currentIdentity = identity ?? (await refreshIdentity());
    const signedOut = await window.agentic.settings.saveIdentity({
      displayName: currentIdentity.displayName,
      email: currentIdentity.email,
      loginMethod: currentIdentity.loginMethod,
      status: "signed-out",
    });
    setIdentity(signedOut);
  }

  function handleDiagnosticAction(action: DiagnosticAction) {
    if (action.target === "settings") {
      navigate("Settings");
      return;
    }
    if (action.target === "project") {
      void pickFolder();
      return;
    }
    // Install/docs actions lead to the integrations surface, where each CLI and
    // provider exposes its concrete documentation and connection controls.
    navigate("Integrations");
  }

  if (!bridgeAvailable) {
    return <BootErrorScreen message={bridgeErrorMessage} />;
  }

  if (bootError) {
    return <BootErrorScreen message={bootError} />;
  }

  if (identityLoading) {
    return (
      <main className="settings-page auth-loading-screen">
        <section className="settings-panel auth-loading-panel">
          <p>Loading workspace account...</p>
        </section>
      </main>
    );
  }

  if (identity?.status !== "signed-in") {
    return <SettingsModule authOnly onIdentityChange={setIdentity} />;
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        activeNav={activeNav}
        collapsed={sidebarCollapsed}
        onNavigate={navigate}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <div className="dashboard">
        <TopBar
          diagnostics={diagnostics}
          identity={identity}
          onNavigate={navigate}
          onSignOut={signOut}
          project={project}
          onRefreshDiagnostics={refreshDiagnostics}
          onSelectProject={selectProject}
        />

        {activeNav === "Overview" ? (
          <OverviewDashboard
            activeRunId={activeRunId}
            activeStatus={activeStatus}
            diagnostics={diagnostics}
            history={history}
            selectedZone={selectedZone}
            onNavigate={navigate}
            onOpenAgents={() => navigate("Agents")}
            onOpenAnalytics={() => navigate("Analytics")}
            onSelectZone={setSelectedZone}
          />
        ) : activeNav === "Agents" ? (
          <AgentsPage projectPath={project?.path ?? ""} onPickFolder={pickFolder} />
        ) : activeNav === "Projects" ? (
          <ProjectsModule
            diagnostics={diagnostics}
            gitDiff={gitDiff}
            history={history}
            onDiagnosticAction={handleDiagnosticAction}
            onPickFolder={pickFolder}
            onRefreshGitDiff={() => refreshGitDiff()}
            onRemoveRecent={removeRecentProject}
            onSelectRecent={selectRecentProject}
            project={project}
            recentProjects={recentProjects}
          />
        ) : activeNav === "Workflows" ? (
          <WorkflowsModule />
        ) : activeNav === "Tasks" ? (
          <TasksModule
            activeRunId={activeRunId}
            activeStatus={activeStatus}
            clearTerminal={clearTerminal}
            diagnostics={diagnostics}
            history={history}
            onPickFolder={pickFolder}
            project={project}
            startAgent={startAgent}
            stopAgent={stopAgent}
            terminalLines={terminalLines}
          />
        ) : activeNav === "Knowledge" ? (
          <KnowledgeModule project={project} onPickFolder={pickFolder} />
        ) : activeNav === "Integrations" ? (
          <IntegrationsModule
            diagnostics={diagnostics}
            onNavigate={navigate}
            onRefreshDiagnostics={refreshDiagnostics}
            project={project}
          />
        ) : activeNav === "Analytics" ? (
          <AnalyticsModule diagnostics={diagnostics} history={history} onNavigate={navigate} project={project} />
        ) : activeNav === "Settings" ? (
          <SettingsModule onIdentityChange={setIdentity} />
        ) : (
          <OverviewDashboard
            activeRunId={activeRunId}
            activeStatus={activeStatus}
            diagnostics={diagnostics}
            history={history}
            selectedZone={selectedZone}
            onNavigate={navigate}
            onOpenAgents={() => navigate("Agents")}
            onOpenAnalytics={() => navigate("Analytics")}
            onSelectZone={setSelectedZone}
          />
        )}
      </div>
    </main>
  );
}
