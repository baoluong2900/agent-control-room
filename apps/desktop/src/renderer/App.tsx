import {
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
  AgentStatus,
  SystemDiagnostics,
  WorkflowActivityEntry,
} from "@contracts";
import { useEffect, useMemo, useState } from "react";
import { AgentsPage } from "./agents/AgentsPage";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { WorkspaceMap3D } from "./map/WorkspaceMap3D";
import { ProjectsModule } from "./projects/ProjectsModule";
import { SettingsModule } from "./settings/SettingsModule";
import { TasksModule } from "./tasks/TasksModule";
import { WorkflowsModule } from "./workflows/WorkflowsModule";
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

const usageColors = ["#4fc3ff", "#ffd15a", "#62dfa1", "#4f8cff", "#a36bff"];

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
              <stop offset="0%" stopColor="#3ca7ff" stopOpacity=".28" />
              <stop offset="100%" stopColor="#3ca7ff" stopOpacity="0" />
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

function ModelUsage({ history, onOpenAgents }: { history: AgentRunRecord[]; onOpenAgents: () => void }) {
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
      <button className="analytics-link" onClick={onOpenAgents}>
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

const overviewAgentByCli: Partial<Record<AgentCliId, { agentName: string; mission: string; mode: string }>> = {
  kiro: {
    agentName: "Kiro Architect",
    mission: "Plans developer work and keeps contracts aligned.",
    mode: "Developer",
  },
  agy: {
    agentName: "Agy Operator",
    mission: "Runs fast automation passes and test drills.",
    mode: "Automation",
  },
  claude: {
    agentName: "Claude Scribe",
    mission: "Reviews code and writes architecture context.",
    mode: "Review",
  },
  codex: {
    agentName: "Codex Forge",
    mission: "Implements coding tasks inside the local repo.",
    mode: "Coding",
  },
  gemini: {
    agentName: "Gemini Scout",
    mission: "Handles long-context reading and research lanes.",
    mode: "Knowledge",
  },
  shell: {
    agentName: "Shell Deployer",
    mission: "Runs package, build, and verification commands.",
    mode: "Deployment",
  },
};

const overviewCliOrder: AgentCliId[] = ["kiro", "agy", "claude", "codex", "gemini", "shell"];

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

  const defaults = catalog
    .filter((entry) => entry.id !== "custom")
    .slice()
    .sort((a, b) => {
      const aIndex = overviewCliOrder.indexOf(a.id);
      const bIndex = overviewCliOrder.indexOf(b.id);
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
    })
    .slice(0, 5)
    .map((entry, index) => {
      const model = entry.models.find((item) => item.recommended) ?? entry.models[0];
      const agent = overviewAgentByCli[entry.id] ?? {
        agentName: `${entry.displayName} Agent`,
        mission: entry.description,
        mode: entry.vendor,
      };
      return {
        ...agent,
        cliName: entry.displayName,
        modelId: model?.id ?? "default",
        modelLabel: model?.label ?? entry.displayName,
        modelNote: model?.note ?? entry.vendor,
        accent: ["green", "orange", "blue", "cyan", "purple"][index % 5] as Accent,
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
              <span className={`model-icon accent-${model.accent}`}>
                <Bot size={15} />
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
  return catalog
    .filter((entry) => entry.id !== "custom")
    .slice()
    .sort((a, b) => {
      const aIndex = overviewCliOrder.indexOf(a.id);
      const bIndex = overviewCliOrder.indexOf(b.id);
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
    })
    .slice(0, 5)
    .map((entry, index) => {
      const model = entry.models.find((item) => item.recommended) ?? entry.models[0];
      const agent = overviewAgentByCli[entry.id] ?? { mode: entry.vendor };
      return {
        barWidth: 76,
        color: usageColors[index % usageColors.length],
        detail: shortCliLabel(entry.displayName),
        meta: shortModeLabel(agent.mode),
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

function shortModeLabel(mode: string): string {
  const map: Record<string, string> = {
    Automation: "Auto",
    Coding: "Code",
    Deployment: "Ship",
    Developer: "Dev",
    Knowledge: "Docs",
    Review: "Rev",
  };
  return map[mode] ?? mode.slice(0, 4);
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
  onOpenAgents,
  onSelectZone,
}: {
  activeStatus: AgentStatus;
  activeRunId: string | null;
  diagnostics: SystemDiagnostics | null;
  history: AgentRunRecord[];
  selectedZone: string;
  onOpenAgents: () => void;
  onSelectZone: (zone: string) => void;
}) {
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
          <WorkspaceMap3D
            activeStatus={activeStatus}
            history={history}
            selectedZone={selectedZone}
            onSelectZone={onSelectZone}
          />
        </div>
        <aside className="analytics-rail overview-analytics-rail" aria-label="System analytics">
          <SystemOverview activeRunId={activeRunId} activeStatus={activeStatus} diagnostics={diagnostics} history={history} />
          <TaskThroughput history={history} />
          <ModelUsage history={history} onOpenAgents={onOpenAgents} />
        </aside>
      </div>

      <div className="bottom-grid">
        <WorkflowActivity />
        <ModelSelection />
      </div>
    </>
  );
}

export default function App() {
  const [activeNav, setActiveNav] = useState("Overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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

  useEffect(() => {
    void loadInitialState();
    const unsubscribe = window.agentic.events.subscribe((event) => {
      ingestEvent(event);
      const nextZone = event.status ? statusToZone[event.status] : null;
      if (nextZone) {
        setSelectedZone(nextZone);
      }
      if (event.type === "run:exit" || event.type === "run:error") {
        void refreshHistory();
      }
    });

    return unsubscribe;
  }, [ingestEvent, setSelectedZone]);

  async function loadInitialState() {
    await Promise.all([refreshDiagnostics(), refreshHistory(), refreshProjects()]);
  }

  async function refreshDiagnostics() {
    const nextDiagnostics = await window.agentic.system.diagnostics();
    setDiagnostics(nextDiagnostics);
  }

  async function refreshProjects() {
    const projects = await window.agentic.projects.listRecent();
    setRecentProjects(projects);
    if (!project && projects[0]) {
      setProject(projects[0]);
      await refreshGitDiff(projects[0].path);
    }
  }

  async function refreshHistory() {
    const runs = await window.agentic.agents.history();
    setHistory(runs);
  }

  async function refreshGitDiff(cwd = project?.path) {
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
    await Promise.all([refreshProjects(), refreshGitDiff(nextProject.path)]);
  }

  async function selectRecentProject(nextProject: NonNullable<typeof project>) {
    setProject(nextProject);
    await refreshGitDiff(nextProject.path);
  }

  /** Opens the native folder dialog and returns the picked path. */
  async function pickFolder(): Promise<string | null> {
    const nextProject = await window.agentic.projects.selectFolder();
    if (!nextProject) return null;
    setProject(nextProject);
    await Promise.all([refreshProjects(), refreshGitDiff(nextProject.path)]);
    return nextProject.path;
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

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        activeNav={activeNav}
        collapsed={sidebarCollapsed}
        onNavigate={setActiveNav}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <div className="dashboard">
        <TopBar
          diagnostics={diagnostics}
          onNavigate={setActiveNav}
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
            onOpenAgents={() => setActiveNav("Agents")}
            onSelectZone={setSelectedZone}
          />
        ) : activeNav === "Agents" ? (
          <AgentsPage projectPath={project?.path ?? ""} onPickFolder={pickFolder} />
        ) : activeNav === "Projects" ? (
          <ProjectsModule
            diagnostics={diagnostics}
            gitDiff={gitDiff}
            history={history}
            onPickFolder={pickFolder}
            onRefreshGitDiff={() => refreshGitDiff()}
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
        ) : activeNav === "Settings" ? (
          <SettingsModule />
        ) : (
          <OverviewDashboard
            activeRunId={activeRunId}
            activeStatus={activeStatus}
            diagnostics={diagnostics}
            history={history}
            selectedZone={selectedZone}
            onOpenAgents={() => setActiveNav("Agents")}
            onSelectZone={setSelectedZone}
          />
        )}
      </div>
    </main>
  );
}
