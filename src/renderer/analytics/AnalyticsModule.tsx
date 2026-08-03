import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Gauge,
  ListChecks,
  PlayCircle,
  Route,
  Timer,
  Workflow,
} from "lucide-react";
import type {
  AgentRunRecord,
  ProjectSummary,
  SystemDiagnostics,
  TaskRecord,
  WorkflowActivityEntry,
  WorkflowDefinition,
  WorkflowMetrics,
} from "@contracts";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { cliLabels, formatRelative } from "../workflows/workflow-ui";
import { workspaceNavigation, type WorkspaceNavKey } from "../workspace-navigation";
import "./analytics.css";

type AnalyticsModuleProps = {
  diagnostics: SystemDiagnostics | null;
  history: AgentRunRecord[];
  project: ProjectSummary | null;
  onNavigate: (nav: WorkspaceNavKey) => void;
};

type TrendPoint = {
  label: string;
  runs: number;
  success: number;
};

export function AnalyticsModule({ diagnostics, history, project, onNavigate }: AnalyticsModuleProps) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowMetrics, setWorkflowMetrics] = useState<WorkflowMetrics | null>(null);
  const [workflowActivity, setWorkflowActivity] = useState<WorkflowActivityEntry[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextWorkflows, nextMetrics, nextActivity, nextTasks] = await Promise.all([
        window.agentic.workflows.list(),
        window.agentic.workflows.metrics(),
        window.agentic.workflows.activity(8),
        window.agentic.tasks.list(project?.path ?? null),
      ]);
      setWorkflows(nextWorkflows);
      setWorkflowMetrics(nextMetrics);
      setWorkflowActivity(nextActivity);
      setTasks(nextTasks);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const unsubscribeWorkflow = window.agentic.events.subscribeWorkflow((event) => {
      if (event.type === "workflow:log") return;
      void refresh();
    });
    const unsubscribeTask = window.agentic.events.subscribeTask(() => {
      void refresh();
    });
    return () => {
      unsubscribeWorkflow();
      unsubscribeTask();
    };
    // `refresh` intentionally captures the current project path.
  }, [project?.path]);

  const trend = useMemo(() => buildTrend(history, 14), [history]);
  const totalRuns = history.length;
  const completedRuns = history.filter((run) => run.status === "completed").length;
  const failedRuns = history.filter((run) => run.status === "failed").length;
  const activeRuns = history.filter((run) => run.status === "queued" || run.status === "planning" || run.status === "coding" || run.status === "testing" || run.status === "reviewing" || run.status === "waiting-approval").length;
  const finishedRuns = history.filter((run) => run.status === "completed" || run.status === "failed" || run.status === "stopped");
  const successRate = finishedRuns.length ? Math.round((completedRuns / finishedRuns.length) * 1000) / 10 : 0;
  const avgDuration = averageDuration(history);
  const installedTools = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const totalTools = diagnostics?.tools.length ?? 0;
  const doneTasks = tasks.filter((task) => task.status === "done").length;
  const blockedTasks = tasks.filter((task) => task.status === "blocked").length;
  const dueTasks = tasks.filter((task) => task.dueAt && Date.parse(task.dueAt) <= Date.now()).length;
  const openTasks = tasks.filter((task) => task.status === "open" || task.status === "investigating").length;

  const topCli = useMemo(() => rankCli(history), [history]);
  const topProjects = useMemo(() => rankProjects(history), [history]);
  const topWorkflows = useMemo(() => [...workflows].sort((a, b) => b.stats.runs - a.stats.runs).slice(0, 5), [workflows]);
  const statusRing = useMemo(() => buildStatusRing(history), [history]);

  return (
    <div className="analytics-page">
      <section className="analytics-hero">
        <div>
          <span className="analytics-eyebrow">
            <Gauge size={13} />
            Analytics
          </span>
          <h1>Execution Intelligence</h1>
          <p>Runs, throughput, task flow, and workflow health sourced from the same workspace state.</p>
        </div>
        <div className="analytics-actions">
          <button className="analytics-ghost" onClick={() => onNavigate("Overview")} type="button">
            Overview
          </button>
          <button className="analytics-ghost" onClick={() => onNavigate("Workflows")} type="button">
            Workflows
          </button>
          <button className="analytics-primary" onClick={() => onNavigate("Tasks")} type="button">
            Mission Board
          </button>
        </div>
      </section>

      {error && (
        <p className="analytics-banner error">
          <AlertTriangle size={14} />
          {error}
        </p>
      )}

      <section className="analytics-stat-grid" aria-label="Workspace analytics summary">
        <MetricCard icon={<PlayCircle size={16} />} label="Total Runs" value={totalRuns} tone="blue" />
        <MetricCard icon={<CheckCircle2 size={16} />} label="Success Rate" value={`${successRate}%`} tone="green" />
        <MetricCard icon={<Workflow size={16} />} label="Active Workflows" value={workflowMetrics?.activeWorkflows ?? 0} tone="purple" />
        <MetricCard icon={<ListChecks size={16} />} label="Done Tasks" value={doneTasks} tone="cyan" />
        <MetricCard icon={<Clock3 size={16} />} label="Avg Duration" value={avgDuration} tone="amber" />
        <MetricCard icon={<Bot size={16} />} label="Tools Ready" value={totalTools ? `${installedTools}/${totalTools}` : "Pending"} tone="orange" />
      </section>

      <div className="analytics-layout">
        <main className="analytics-main">
          <section className="analytics-panel analytics-chart-panel">
            <header>
              <div>
                <h2>Run Trend</h2>
                <p>Daily runs and success rate across the last 14 days</p>
              </div>
              <span className="analytics-live">
                <span />
                Live workspace
              </span>
            </header>
            <div className="analytics-chart">
              <div className="analytics-axis-y">
                <span>100%</span>
                <span>75%</span>
                <span>50%</span>
                <span>25%</span>
                <span>0%</span>
              </div>
              <svg viewBox="0 0 360 180" role="img" aria-label="Workspace run trend over the last 14 days">
                <defs>
                  <linearGradient id="analyticsRunsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity=".28" />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <rect x="0" y="0" width="360" height="180" fill="transparent" />
                {[0, 45, 90, 135, 180].map((y) => (
                  <line key={y} x1="0" x2="360" y1={y} y2={y} className="analytics-grid-line" />
                ))}
                <path d={areaPath(trend.map((point) => point.runs), 360, 180)} fill="url(#analyticsRunsFill)" />
                <path d={seriesPath(trend.map((point) => point.runs), 360, 180)} className="analytics-series runs" />
                <path d={seriesPath(trend.map((point) => point.success), 360, 180)} className="analytics-series success" />
                {trend.map((point, index) => {
                  const x = trend.length <= 1 ? 0 : (index / (trend.length - 1)) * 360;
                  const runY = 180 - (point.runs / Math.max(...trend.map((entry) => entry.runs), 1)) * 160 - 10;
                  const successY = 180 - (point.success / 100) * 160 - 10;
                  return (
                    <g key={point.label}>
                      <circle cx={x} cy={runY} r="2.8" className="analytics-point runs" />
                      <circle cx={x} cy={successY} r="2.8" className="analytics-point success" />
                    </g>
                  );
                })}
              </svg>
              <div className="analytics-axis-x">
                {trend.map((point) => (
                  <span key={point.label}>{point.label}</span>
                ))}
              </div>
            </div>
          </section>

          <div className="analytics-grid">
            <section className="analytics-panel">
              <header>
                <div>
                  <h2>Execution Status</h2>
                  <p>Current run mix across the workspace</p>
                </div>
              </header>
              <div className="analytics-donut">
                <div className="analytics-ring" style={{ background: statusRing.background }} />
                <div className="analytics-ring-copy">
                  <strong>{totalRuns}</strong>
                  <small>Total runs</small>
                </div>
              </div>
              <ul className="analytics-list compact">
                {statusRing.rows.map((row) => (
                  <li key={row.label}>
                    <span>
                      <i className={`tone-${row.tone}`} />
                      {row.label}
                    </span>
                    <strong>{row.value}</strong>
                  </li>
                ))}
              </ul>
            </section>

            <section className="analytics-panel">
              <header>
                <div>
                  <h2>Top Workflows</h2>
                  <p>{workflowMetrics ? `${workflowMetrics.automatedRuns} automated runs` : "Workflow health loading"}</p>
                </div>
                <button className="analytics-page-link" onClick={() => onNavigate("Workflows")} type="button">
                  View all
                </button>
              </header>
              <ul className="analytics-rank-list">
                {topWorkflows.map((workflow, index) => (
                  <li key={workflow.id}>
                    <span className="rank">{index + 1}</span>
                    <div>
                      <strong>{workflow.name}</strong>
                      <small>{workflow.description}</small>
                    </div>
                    <em>{workflow.stats.runs}</em>
                  </li>
                ))}
                {topWorkflows.length === 0 && <p className="analytics-empty">No workflows yet.</p>}
              </ul>
            </section>

            <section className="analytics-panel">
              <header>
                <div>
                  <h2>Top Agents</h2>
                  <p>Most-used CLIs from recent runs</p>
                </div>
                <button className="analytics-page-link" onClick={() => onNavigate("Agents")} type="button">
                  Fleet
                </button>
              </header>
              <ul className="analytics-rank-list">
                {topCli.map((item, index) => (
                  <li key={item.name}>
                    <span className="rank">{index + 1}</span>
                    <div>
                      <strong>{cliLabels[item.name]}</strong>
                      <small>{item.runs} runs · {item.percent}% share</small>
                    </div>
                    <em>{item.duration}</em>
                  </li>
                ))}
                {topCli.length === 0 && <p className="analytics-empty">No agent runs recorded.</p>}
              </ul>
            </section>

            <section className="analytics-panel">
              <header>
                <div>
                  <h2>Top Projects</h2>
                  <p>Recent run history grouped by workspace</p>
                </div>
                <button className="analytics-page-link" onClick={() => onNavigate("Projects")} type="button">
                  Projects
                </button>
              </header>
              <ul className="analytics-rank-list">
                {topProjects.map((item, index) => (
                  <li key={item.label}>
                    <span className="rank">{index + 1}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.runs} runs · {item.completed} completed</small>
                    </div>
                    <em>{item.share}%</em>
                  </li>
                ))}
                {topProjects.length === 0 && <p className="analytics-empty">No project history yet.</p>}
              </ul>
            </section>
          </div>

          <section className="analytics-panel analytics-activity-panel">
            <header>
              <div>
                <h2>Recent Workflow Activity</h2>
                <p>Live events from the workflow engine</p>
              </div>
              <button className="analytics-page-link" onClick={() => onNavigate("Workflows")} type="button">
                Open engine
              </button>
            </header>
            <div className="analytics-activity-list">
              {workflowActivity.map((entry) => (
                <article key={entry.id}>
                  <span className={`activity-badge tone-${activityTone(entry.kind)}`}>
                    {activityIcon(entry.kind)}
                  </span>
                  <div>
                    <strong>{entry.workflowName}</strong>
                    <small>{entry.headline}</small>
                  </div>
                  <em>{formatRelative(entry.at)}</em>
                </article>
              ))}
              {workflowActivity.length === 0 && <p className="analytics-empty">No workflow activity yet.</p>}
            </div>
          </section>
        </main>

        <aside className="analytics-page-rail">
          <section className="analytics-panel analytics-insight-panel">
            <header>
              <div>
                <h2>Workspace Summary</h2>
                <p>{project ? project.name : "No project selected"}</p>
              </div>
            </header>
            <p className="analytics-summary-copy">
              {project
                ? `This project is producing ${totalRuns} recorded runs with ${openTasks} open tasks and ${blockedTasks} blocked items.`
                : "Select a project to correlate analytics with task and knowledge data."}
            </p>
            <div className="analytics-mini-grid">
              <span>
                <strong>{activeRuns}</strong>
                <small>Active Runs</small>
              </span>
              <span>
                <strong>{dueTasks}</strong>
                <small>Due Tasks</small>
              </span>
              <span>
                <strong>{failedRuns}</strong>
                <small>Failed</small>
              </span>
              <span>
                <strong>{workflowMetrics?.successRate ?? successRate}%</strong>
                <small>Workflow Success</small>
              </span>
            </div>
          </section>

          <section className="analytics-panel analytics-insight-panel">
            <header>
              <div>
                <h2>Alerts</h2>
                <p>Things worth checking next</p>
              </div>
            </header>
            <ul className="analytics-alert-list">
              {totalTools === 0 ? (
                <li>
                  <AlertTriangle size={14} />
                  Diagnostics not loaded yet.
                </li>
              ) : installedTools < totalTools ? (
                <li>
                  <AlertTriangle size={14} />
                  {totalTools - installedTools} local tools are missing.
                </li>
              ) : (
                <li>
                  <CheckCircle2 size={14} />
                  All detected tools are ready.
                </li>
              )}
              {blockedTasks > 0 && (
                <li>
                  <Route size={14} />
                  {blockedTasks} blocked tasks need review.
                </li>
              )}
              {workflowMetrics && workflowMetrics.activeWorkflows === 0 && (
                <li>
                  <Workflow size={14} />
                  No workflows are active right now.
                </li>
              )}
            </ul>
          </section>

          <section className="analytics-panel analytics-insight-panel">
            <header>
              <div>
                <h2>Module Links</h2>
                <p>Move into the linked workspace areas</p>
              </div>
            </header>
            <div className="analytics-link-grid">
              {workspaceNavigation
                .filter((item) => item.key !== "Overview")
                .map((item) => (
                  <button key={item.key} className="analytics-link-card" onClick={() => onNavigate(item.key)} type="button">
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

      {loading && <p className="analytics-loading">Refreshing analytics...</p>}
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
  tone: "blue" | "green" | "purple" | "cyan" | "amber" | "orange";
  value: number | string;
}) {
  return (
    <article className={`analytics-stat tone-${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  );
}

function buildTrend(history: AgentRunRecord[], days: number): TrendPoint[] {
  const now = Date.now();
  return Array.from({ length: days }, (_, index) => {
    const dayStart = now - (days - 1 - index) * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const runs = history.filter((run) => {
      const started = Date.parse(run.startedAt);
      return Number.isFinite(started) && started >= dayStart && started < dayEnd;
    });
    const finished = runs.filter((run) => run.status === "completed" || run.status === "failed" || run.status === "stopped");
    const completed = finished.filter((run) => run.status === "completed").length;
    const success = finished.length ? Math.round((completed / finished.length) * 100) : 0;
    return {
      label: new Date(dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      runs: runs.length,
      success,
    };
  });
}

function seriesPath(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - (value / max) * (height - 20) - 10;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function areaPath(values: number[], width: number, height: number): string {
  const path = seriesPath(values, width, height);
  return `${path} L${width},${height} L0,${height} Z`;
}

function averageDuration(history: AgentRunRecord[]): string {
  const total = history.reduce((sum, run) => {
    if (!run.endedAt) return sum;
    const started = Date.parse(run.startedAt);
    const ended = Date.parse(run.endedAt);
    return Number.isFinite(started) && Number.isFinite(ended) ? sum + Math.max(0, ended - started) : sum;
  }, 0);
  const count = history.filter((run) => run.endedAt).length;
  if (count === 0) return "—";
  const average = total / count;
  if (average < 1_000) return `${Math.round(average)}ms`;
  if (average < 60_000) return `${(average / 1000).toFixed(1)}s`;
  return `${Math.round(average / 60_000)}m`;
}

function rankCli(history: AgentRunRecord[]): Array<{ name: keyof typeof cliLabels; runs: number; duration: string; percent: number }> {
  const counts = new Map<keyof typeof cliLabels, number>();
  const totals = new Map<keyof typeof cliLabels, number>();

  for (const run of history) {
    counts.set(run.cliId as keyof typeof cliLabels, (counts.get(run.cliId as keyof typeof cliLabels) ?? 0) + 1);
    if (run.endedAt) {
      const started = Date.parse(run.startedAt);
      const ended = Date.parse(run.endedAt);
      if (Number.isFinite(started) && Number.isFinite(ended)) {
        totals.set(run.cliId as keyof typeof cliLabels, (totals.get(run.cliId as keyof typeof cliLabels) ?? 0) + Math.max(0, ended - started));
      }
    }
  }

  const totalRuns = history.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, runs]) => ({
      name,
      runs,
      duration: formatDuration(totals.get(name) ?? 0),
      percent: Math.round((runs / totalRuns) * 100),
    }));
}

function rankProjects(history: AgentRunRecord[]): Array<{ completed: number; label: string; runs: number; share: number }> {
  const counts = new Map<string, number>();
  const completed = new Map<string, number>();

  for (const run of history) {
    const label = basename(run.cwd);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (run.status === "completed") {
      completed.set(label, (completed.get(label) ?? 0) + 1);
    }
  }

  const totalRuns = history.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, runs]) => ({
      label,
      runs,
      completed: completed.get(label) ?? 0,
      share: Math.round((runs / totalRuns) * 100),
    }));
}

function buildStatusRing(history: AgentRunRecord[]): {
  background: string;
  rows: Array<{ label: string; tone: "green" | "red" | "amber" | "purple"; value: number }>;
} {
  const completed = history.filter((run) => run.status === "completed").length;
  const failed = history.filter((run) => run.status === "failed").length;
  const stopped = history.filter((run) => run.status === "stopped").length;
  const running = history.filter((run) => run.status === "queued" || run.status === "planning" || run.status === "coding" || run.status === "testing" || run.status === "reviewing" || run.status === "waiting-approval").length;
  const total = Math.max(completed + failed + stopped + running, 1);
  const completedPct = (completed / total) * 100;
  const failedPct = (failed / total) * 100;
  const stoppedPct = (stopped / total) * 100;

  return {
    background: `radial-gradient(circle at center, rgba(7, 8, 21, .96) 48%, transparent 49%), conic-gradient(#86efac 0 ${completedPct}%, #fdba9b ${completedPct}% ${completedPct + failedPct}%, #fbbf24 ${completedPct + failedPct}% ${completedPct + failedPct + stoppedPct}%, #a78bfa ${completedPct + failedPct + stoppedPct}% 100%)`,
    rows: [
      { label: "Completed", tone: "green", value: completed },
      { label: "Failed", tone: "red", value: failed },
      { label: "Stopped", tone: "amber", value: stopped },
      { label: "In Flight", tone: "purple", value: running },
    ],
  };
}

function activityTone(kind: WorkflowActivityEntry["kind"]): "green" | "red" | "amber" | "blue" {
  if (kind === "completed") return "green";
  if (kind === "failed") return "red";
  if (kind === "paused") return "amber";
  return "blue";
}

function activityIcon(kind: WorkflowActivityEntry["kind"]): ReactElement {
  if (kind === "completed") return <CheckCircle2 size={13} />;
  if (kind === "failed") return <AlertTriangle size={13} />;
  if (kind === "paused") return <Timer size={13} />;
  return <Route size={13} />;
}

function basename(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? (input || "Workspace");
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
