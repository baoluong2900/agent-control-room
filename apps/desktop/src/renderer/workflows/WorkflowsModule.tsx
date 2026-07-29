import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  Filter,
  Gauge,
  LayoutGrid,
  List,
  PlayCircle,
  Plus,
  Search,
  Star,
  Timer,
  Upload,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type {
  AgentCliId,
  WorkflowActivityEntry,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowMetrics,
  WorkflowRunRecord,
  WorkflowSaveInput,
  WorkflowStatus,
} from "@contracts";
import { WorkflowDetailPanel } from "./WorkflowDetailPanel";
import { WorkflowEditorDrawer } from "./WorkflowEditorDrawer";
import {
  type Accent,
  cliLabels,
  formatRelative,
  runStatusMeta,
  statusMeta,
  stepKindMeta,
  triggerMeta,
} from "./workflow-ui";

type SortKey = "recent" | "runs" | "success" | "name";
type ViewMode = "list" | "grid";
type EditorState = { open: boolean; workflow: WorkflowDefinition | null };

const PAGE_SIZE = 5;

const activityAccent: Record<WorkflowActivityEntry["kind"], string> = {
  completed: "green",
  triggered: "blue",
  paused: "amber",
  processed: "cyan",
  failed: "red",
};

export function WorkflowsModule() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [metrics, setMetrics] = useState<WorkflowMetrics | null>(null);
  const [activity, setActivity] = useState<WorkflowActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | WorkflowStatus>("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [view, setView] = useState<ViewMode>("list");
  const [page, setPage] = useState(1);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [logsByWorkflow, setLogsByWorkflow] = useState<Record<string, WorkflowEvent[]>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [activeRunIdByWorkflow, setActiveRunIdByWorkflow] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<EditorState>({ open: false, workflow: null });

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [list, nextMetrics, nextActivity] = await Promise.all([
        window.agentic.workflows.list(),
        window.agentic.workflows.metrics(),
        window.agentic.workflows.activity(6),
      ]);
      setWorkflows(list);
      setMetrics(nextMetrics);
      setActivity(nextActivity);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const loadRuns = useCallback(async (workflowId: string) => {
    const nextRuns = await window.agentic.workflows.runs(workflowId, 20);
    setRuns(nextRuns);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadRuns(selectedId);
  }, [selectedId, loadRuns]);

  // Stream live workflow logs into the detail panel.
  useEffect(() => {
    const unsubscribe = window.agentic.events.subscribeWorkflow((event) => {
      setLogsByWorkflow((prev) => {
        const existing = prev[event.workflowId] ?? [];
        return { ...prev, [event.workflowId]: [...existing, event].slice(-400) };
      });
      if (event.type === "workflow:run-started" && event.workflowRunId) {
        setActiveRunIdByWorkflow((prev) => ({ ...prev, [event.workflowId]: event.workflowRunId }));
      }
      if (event.type === "workflow:run-finished") {
        setRunningId((current) => (current === event.workflowId ? null : current));
        setActiveRunIdByWorkflow((prev) => {
          const next = { ...prev };
          delete next[event.workflowId];
          return next;
        });
        void refreshAll();
        if (event.workflowId === selectedId) void loadRuns(event.workflowId);
      }
    });
    return unsubscribe;
  }, [refreshAll, loadRuns, selectedId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    let result = workflows.filter((workflow) => {
      const matchesQuery =
        !query ||
        workflow.name.toLowerCase().includes(query) ||
        workflow.description.toLowerCase().includes(query) ||
        workflow.owner.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "all" || workflow.status === statusFilter;
      return matchesQuery && matchesStatus;
    });

    result = [...result].sort((a, b) => {
      switch (sortKey) {
        case "runs":
          return b.stats.runs - a.stats.runs;
        case "success":
          return b.stats.successRate - a.stats.successRate;
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      }
    });

    return result;
  }, [workflows, search, statusFilter, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  async function handleSave(input: WorkflowSaveInput) {
    const saved = await window.agentic.workflows.save(input);
    setEditor({ open: false, workflow: null });
    await refreshAll();
    setSelectedId(saved.id);
  }

  async function handleRun(workflowId: string) {
    setRunningId(workflowId);
    setLogsByWorkflow((prev) => ({ ...prev, [workflowId]: [] }));
    setSelectedId(workflowId);
    try {
      await window.agentic.workflows.run({ workflowId, triggeredBy: "manual" });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      setRunningId(null);
    }
  }

  async function handleToggleFavorite(workflowId: string) {
    await window.agentic.workflows.toggleFavorite(workflowId);
    await refreshAll();
  }

  async function handleStatusChange(workflowId: string, status: WorkflowStatus) {
    await window.agentic.workflows.setStatus(workflowId, status);
    await refreshAll();
  }

  async function handleDuplicate(workflowId: string) {
    const copy = await window.agentic.workflows.duplicate(workflowId);
    await refreshAll();
    setSelectedId(copy.id);
  }

  async function handleExport(workflowId: string) {
    try {
      await window.agentic.workflows.exportDefinition(workflowId);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function handleDelete(workflowId: string) {
    const target = workflows.find((workflow) => workflow.id === workflowId);
    const label = target ? `"${target.name}"` : "this workflow";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    await window.agentic.workflows.remove(workflowId);
    if (selectedId === workflowId) setSelectedId(null);
    await refreshAll();
  }

  async function handleCancel(workflowId: string) {
    const runId = activeRunIdByWorkflow[workflowId];
    if (!runId) return;
    await window.agentic.workflows.cancel(runId);
  }

  async function handleImport() {
    const imported = await window.agentic.workflows.importDefinition();
    if (imported) {
      await refreshAll();
      setSelectedId(imported.id);
    }
  }

  return (
    <div className="wf-page">
      <section className="wf-hero">
        <div>
          <h1>Workflows</h1>
          <p>Design, automate, and manage AI workflows across your organization.</p>
        </div>
        <div className="wf-hero-actions">
          <div className="wf-search">
            <Search size={15} />
            <input
              value={search}
              placeholder="Search workflows…"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <button className="wf-ghost-btn" onClick={handleImport}>
            <Upload size={14} /> Import
          </button>
          <button className="wf-primary-btn" onClick={() => setEditor({ open: true, workflow: null })}>
            <Plus size={15} /> New Workflow
          </button>
        </div>
      </section>

      {error && <div className="wf-banner-error">{error}</div>}

      <div className={`wf-layout ${selected ? "with-detail" : ""}`}>
        <div className="wf-main">
          <WorkflowStats metrics={metrics} />

          <div className="wf-toolbar">
            <div className="wf-filters">
              <select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as "all" | WorkflowStatus);
                  setPage(1);
                }}
              >
                <option value="all">All Statuses</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="draft">Draft</option>
                <option value="error">Error</option>
              </select>
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                <option value="recent">Sort: Recent</option>
                <option value="runs">Sort: Runs</option>
                <option value="success">Sort: Success rate</option>
                <option value="name">Sort: Name</option>
              </select>
              <span className="wf-filter-hint">
                <Filter size={13} /> {filtered.length} workflow{filtered.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="wf-view-toggle">
              <button className={view === "list" ? "active" : ""} aria-label="List view" onClick={() => setView("list")}>
                <List size={15} />
              </button>
              <button className={view === "grid" ? "active" : ""} aria-label="Grid view" onClick={() => setView("grid")}>
                <LayoutGrid size={15} />
              </button>
            </div>
          </div>

          {loading ? (
            <div className="wf-loading">Loading workflows…</div>
          ) : view === "list" ? (
            <WorkflowTable
              items={pageItems}
              selectedId={selectedId}
              runningId={runningId}
              onSelect={setSelectedId}
              onRun={handleRun}
              onFavorite={handleToggleFavorite}
            />
          ) : (
            <WorkflowGrid
              items={pageItems}
              selectedId={selectedId}
              runningId={runningId}
              onSelect={setSelectedId}
              onRun={handleRun}
            />
          )}

          {!loading && filtered.length > 0 && (
            <div className="wf-pagination">
              <span>
                Showing {(currentPage - 1) * PAGE_SIZE + 1} to{" "}
                {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} workflows
              </span>
              <div className="wf-page-buttons">
                <button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
                  ‹
                </button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                  <button
                    key={pageNumber}
                    className={pageNumber === currentPage ? "active" : ""}
                    onClick={() => setPage(pageNumber)}
                  >
                    {pageNumber}
                  </button>
                ))}
                <button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
                  ›
                </button>
              </div>
            </div>
          )}

          <WorkflowActivityFeed activity={activity} onSelect={setSelectedId} />
        </div>

        {selected && (
          <WorkflowDetailPanel
            workflow={selected}
            runs={runs}
            logs={logsByWorkflow[selected.id] ?? []}
            running={runningId === selected.id}
            canCancel={Boolean(activeRunIdByWorkflow[selected.id])}
            onClose={() => setSelectedId(null)}
            onEdit={() => setEditor({ open: true, workflow: selected })}
            onRun={() => handleRun(selected.id)}
            onCancel={() => handleCancel(selected.id)}
            onToggleFavorite={() => handleToggleFavorite(selected.id)}
            onDuplicate={() => handleDuplicate(selected.id)}
            onExport={() => handleExport(selected.id)}
            onDelete={() => handleDelete(selected.id)}
            onSetStatus={(status) => handleStatusChange(selected.id, status)}
          />
        )}
      </div>

      {editor.open && (
        <WorkflowEditorDrawer
          workflow={editor.workflow}
          onClose={() => setEditor({ open: false, workflow: null })}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function WorkflowStats({ metrics }: { metrics: WorkflowMetrics | null }) {
  const cards = [
    {
      label: "Total Workflows",
      value: metrics ? String(metrics.totalWorkflows) : "—",
      delta: metrics?.totalDeltaPercent,
      icon: WorkflowIcon,
      accent: "purple",
    },
    {
      label: "Active Workflows",
      value: metrics ? String(metrics.activeWorkflows) : "—",
      delta: metrics?.activeDeltaPercent,
      icon: PlayCircle,
      accent: "green",
    },
    {
      label: "Automated Runs",
      value: metrics ? metrics.automatedRuns.toLocaleString() : "—",
      delta: metrics?.runsDeltaPercent,
      icon: Timer,
      accent: "blue",
    },
    {
      label: "Success Rate",
      value: metrics ? `${metrics.successRate}%` : "—",
      delta: metrics?.successDeltaPercent,
      icon: Gauge,
      accent: "cyan",
    },
  ];

  return (
    <div className="wf-stat-grid">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <section className={`wf-stat-card accent-${card.accent}`} key={card.label}>
            <span className="wf-stat-icon">
              <Icon size={18} />
            </span>
            <div className="wf-stat-copy">
              <small>{card.label}</small>
              <strong>{card.value}</strong>
              {card.delta !== undefined && <em className="wf-stat-delta">▲ {card.delta}% from last month</em>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StageChips({ workflow }: { workflow: WorkflowDefinition }) {
  const shown = workflow.steps.slice(0, 5);
  const extra = workflow.steps.length - shown.length;
  return (
    <div className="wf-stage-chips">
      {shown.map((step, index) => {
        const meta = stepKindMeta[step.kind];
        const Icon = meta.icon;
        return (
          <span className="wf-stage-chip-wrap" key={step.id}>
            <span className={`wf-stage-chip accent-${meta.accent}`} title={`${step.name} · ${step.cliId}`}>
              <Icon size={13} />
            </span>
            {index < shown.length - 1 && <i className="wf-stage-sep" />}
          </span>
        );
      })}
      {extra > 0 && <span className="wf-stage-extra">+{extra}</span>}
    </div>
  );
}

const agentAccentMap: Partial<Record<AgentCliId, Accent>> = {
  claude: "purple",
  kiro: "cyan",
  codex: "green",
  gemini: "blue",
  amazonq: "orange",
  copilot: "blue",
  cursor: "purple",
  aider: "amber",
  ollama: "green",
  qwen: "cyan",
  shell: "amber",
};

function agentAccent(cliId: AgentCliId): Accent {
  return agentAccentMap[cliId] ?? "blue";
}

function WorkflowAgents({ workflow }: { workflow: WorkflowDefinition }) {
  const agents = Array.from(new Set(workflow.steps.map((step) => step.cliId)));
  const shown = agents.slice(0, 3);
  const extra = agents.length - shown.length;
  return (
    <span className="wf-agents" title={`Owner: ${workflow.owner} · Agents: ${agents.map((a) => cliLabels[a]).join(", ")}`}>
      <span className="wf-agent-stack">
        {shown.map((cli, index) => (
          <i key={cli} className={`wf-agent-avatar accent-${agentAccent(cli)}`} style={{ zIndex: shown.length - index }}>
            {cliLabels[cli].slice(0, 1)}
          </i>
        ))}
        {extra > 0 && <i className="wf-agent-avatar wf-agent-extra-av">+{extra}</i>}
      </span>
      <small className="wf-agent-owner">{workflow.owner}</small>
    </span>
  );
}

function SuccessBar({ value }: { value: number }) {
  return (
    <div className="wf-success">
      <span>{value.toFixed(1)}%</span>
      <i>
        <b style={{ width: `${Math.min(100, value)}%` }} />
      </i>
    </div>
  );
}

function WorkflowTable({
  items,
  selectedId,
  runningId,
  onSelect,
  onRun,
  onFavorite,
}: {
  items: WorkflowDefinition[];
  selectedId: string | null;
  runningId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onFavorite: (id: string) => void;
}) {
  if (items.length === 0) {
    return <div className="wf-loading">No workflows match your filters.</div>;
  }

  return (
    <div className="wf-table" role="table">
      <div className="wf-table-head" role="row">
        <span>Workflow</span>
        <span>Trigger</span>
        <span>Stages</span>
        <span>Owner / Agents</span>
        <span>Runs</span>
        <span>Success Rate</span>
        <span>Status</span>
        <span>Last Run</span>
      </div>
      {items.map((workflow) => {
        const status = statusMeta[workflow.status];
        const TriggerIcon = triggerMeta[workflow.trigger.type].icon;
        const lastStatus = workflow.stats.lastRunStatus ? runStatusMeta[workflow.stats.lastRunStatus] : null;
        return (
          <div
            key={workflow.id}
            className={`wf-table-row ${selectedId === workflow.id ? "selected" : ""}`}
            role="row"
            tabIndex={0}
            onClick={() => onSelect(workflow.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(workflow.id);
              }
            }}
          >
            <span className="wf-cell-name">
              <span className="wf-row-icon accent-blue">
                <WorkflowIcon size={16} />
              </span>
              <span className="wf-cell-name-copy">
                <strong>
                  {workflow.name}
                  {workflow.favorite && <Star size={11} className="wf-inline-star" fill="currentColor" />}
                </strong>
                <small>{workflow.description}</small>
              </span>
            </span>
            <span className="wf-cell-trigger">
              <TriggerIcon size={13} />
              <span>
                {triggerMeta[workflow.trigger.type].label}
                {workflow.trigger.schedule ? <em>{workflow.trigger.schedule}</em> : null}
              </span>
            </span>
            <span>
              <StageChips workflow={workflow} />
            </span>
            <span>
              <WorkflowAgents workflow={workflow} />
            </span>
            <span className="wf-cell-runs">{workflow.stats.runs.toLocaleString()}</span>
            <span>
              <SuccessBar value={workflow.stats.successRate} />
            </span>
            <span>
              <em className={`wf-badge accent-${status.accent}`}>{status.label}</em>
            </span>
            <span className="wf-cell-last">
              <span>{formatRelative(workflow.stats.lastRunAt)}</span>
              <i className={`wf-last-dot accent-${lastStatus?.accent ?? "blue"}`} />
              <button
                className="wf-row-run"
                aria-label="Run workflow"
                disabled={runningId === workflow.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onRun(workflow.id);
                }}
              >
                <PlayCircle size={16} />
              </button>
              <button
                className="wf-row-fav"
                aria-label="Toggle favorite"
                onClick={(event) => {
                  event.stopPropagation();
                  onFavorite(workflow.id);
                }}
              >
                <Star size={14} fill={workflow.favorite ? "currentColor" : "none"} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WorkflowGrid({
  items,
  selectedId,
  runningId,
  onSelect,
  onRun,
}: {
  items: WorkflowDefinition[];
  selectedId: string | null;
  runningId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
}) {
  if (items.length === 0) {
    return <div className="wf-loading">No workflows match your filters.</div>;
  }

  return (
    <div className="wf-grid">
      {items.map((workflow) => {
        const status = statusMeta[workflow.status];
        return (
          <div
            key={workflow.id}
            className={`wf-grid-card ${selectedId === workflow.id ? "selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(workflow.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(workflow.id);
              }
            }}
          >
            <div className="wf-grid-card-head">
              <span className="wf-row-icon accent-blue">
                <WorkflowIcon size={16} />
              </span>
              <em className={`wf-badge accent-${status.accent}`}>{status.label}</em>
            </div>
            <strong>{workflow.name}</strong>
            <small>{workflow.description}</small>
            <StageChips workflow={workflow} />
            <div className="wf-grid-card-foot">
              <SuccessBar value={workflow.stats.successRate} />
              <button
                className="wf-row-run"
                aria-label="Run workflow"
                disabled={runningId === workflow.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onRun(workflow.id);
                }}
              >
                <PlayCircle size={16} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkflowActivityFeed({
  activity,
  onSelect,
}: {
  activity: WorkflowActivityEntry[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="wf-activity-card">
      <header>
        <h2>Recent Workflow Activity</h2>
        <span className="wf-live">
          <i /> Real-time
        </span>
      </header>
      {activity.length === 0 ? (
        <p className="wf-empty">Activity from your workflow runs will appear here.</p>
      ) : (
        <ul className="wf-activity-list">
          {activity.map((entry) => {
            const accent = activityAccent[entry.kind];
            const Icon = entry.kind === "failed" ? Search : CheckCircle2;
            return (
              <li key={entry.id}>
                <button onClick={() => onSelect(entry.workflowId)}>
                  <span className={`wf-activity-icon accent-${accent}`}>
                    <Icon size={15} />
                  </span>
                  <span className="wf-activity-copy">
                    <strong>
                      {entry.workflowName} <em>{entry.headline}</em>
                    </strong>
                    <small>{entry.detail}</small>
                  </span>
                  <span className="wf-activity-time">{formatRelative(entry.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
