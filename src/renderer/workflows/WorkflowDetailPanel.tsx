import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plug,
  Power,
  ShieldQuestion,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunRecord,
  WorkflowStatus,
} from "@contracts";
import {
  formatDate,
  formatDuration,
  formatRelative,
  runStatusMeta,
  stepKindMeta,
  triggerMeta,
} from "./workflow-ui";

type Tab = "overview" | "runs" | "steps" | "logs";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
  { id: "steps", label: "Steps" },
  { id: "logs", label: "Logs" },
];

export function WorkflowDetailPanel({
  workflow,
  runs,
  logs,
  running,
  canCancel,
  awaitingApproval,
  onClose,
  onEdit,
  onRun,
  onCancel,
  onApprove,
  onReject,
  onToggleFavorite,
  onDuplicate,
  onExport,
  onDelete,
  onSetStatus,
}: {
  workflow: WorkflowDefinition;
  runs: WorkflowRunRecord[];
  logs: WorkflowEvent[];
  running: boolean;
  canCancel: boolean;
  /** Set while the latest run sits on an approval gate. */
  awaitingApproval: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onCancel: () => void;
  onApprove: () => void;
  onReject: () => void;
  onToggleFavorite: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onSetStatus: (status: WorkflowStatus) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tab === "logs" && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, tab]);

  const avgDuration = useMemo(() => formatDuration(workflow.stats.avgDurationMs), [workflow.stats.avgDurationMs]);
  const paused = workflow.status === "paused";
  const approvalStepName = useMemo(
    () => runs.find((run) => run.status === "waiting-approval")?.steps.find((step) => step.status === "waiting-approval")?.name ?? null,
    [runs],
  );

  return (
    <aside className="wf-detail" aria-label={`${workflow.name} details`}>
      <header className="wf-detail-head">
        <span className="wf-detail-icon accent-blue">
          <Plug size={16} />
        </span>
        <h2>{workflow.name}</h2>
        <button
          className={`wf-star ${workflow.favorite ? "on" : ""}`}
          aria-label="Toggle favorite"
          onClick={onToggleFavorite}
        >
          <Star size={15} fill={workflow.favorite ? "currentColor" : "none"} />
        </button>
        <div className="wf-menu-wrap">
          <button
            className="wf-icon-btn"
            aria-label="More actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <>
              <div className="wf-menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="wf-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSetStatus(paused ? "active" : "paused");
                  }}
                >
                  {paused ? <Power size={14} /> : <Pause size={14} />}
                  {paused ? "Activate" : "Pause"}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate();
                  }}
                >
                  <Copy size={14} /> Duplicate
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onExport();
                  }}
                >
                  <Download size={14} /> Export JSON
                </button>
                <button
                  role="menuitem"
                  className="wf-menu-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </>
          )}
        </div>
        <button className="wf-icon-btn" aria-label="Close details" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      {awaitingApproval && (
        <div className="wf-approval-bar" role="status">
          <ShieldQuestion size={15} />
          <div>
            <strong>Waiting for approval</strong>
            <small>{approvalStepName ?? "A step"} must be signed off before the run continues.</small>
          </div>
          <button className="wf-primary-btn" onClick={onApprove}>
            <CheckCircle2 size={14} /> Approve
          </button>
          <button className="wf-danger-btn" onClick={onReject}>
            <X size={14} /> Reject
          </button>
        </div>
      )}

      <div className="wf-detail-actions">
        {running ? (
          <button className="wf-danger-btn" disabled={!canCancel} onClick={onCancel}>
            <Square size={13} /> Cancel run
          </button>
        ) : (
          <button className="wf-primary-btn" onClick={onRun}>
            <Play size={14} /> Run now
          </button>
        )}
        <button className="wf-ghost-btn" onClick={onEdit}>
          <Pencil size={14} /> Edit
        </button>
      </div>

      <nav className="wf-tabs" aria-label="Workflow sections">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={tab === entry.id ? "active" : ""}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="wf-detail-body">
        {tab === "overview" && (
          <OverviewTab workflow={workflow} runs={runs} avgDuration={avgDuration} />
        )}
        {tab === "runs" && <RunsTab runs={runs} />}
        {tab === "steps" && <StepsTab workflow={workflow} />}
        {tab === "logs" && <LogsTab logs={logs} logRef={logRef} />}
      </div>

      <footer className="wf-detail-foot">
        <span>
          Owner <strong>{workflow.owner}</strong>
        </span>
        <span>
          Created {formatDate(workflow.createdAt)} · Updated {formatDate(workflow.updatedAt)}
        </span>
      </footer>
    </aside>
  );
}

function OverviewTab({
  workflow,
  runs,
  avgDuration,
}: {
  workflow: WorkflowDefinition;
  runs: WorkflowRunRecord[];
  avgDuration: string;
}) {
  const TriggerIcon = triggerMeta[workflow.trigger.type].icon;

  return (
    <>
      <section className="wf-diagram-card">
        <h3>Workflow Diagram</h3>
        <div className="wf-diagram">
          {workflow.steps.map((step, index) => {
            const meta = stepKindMeta[step.kind];
            const Icon = meta.icon;
            return (
              <Fragment key={step.id}>
                <div className={`wf-node accent-${meta.accent} ${step.enabled ? "" : "muted"}`}>
                  <Icon size={17} />
                  <span>{step.name}</span>
                </div>
                {index < workflow.steps.length - 1 && <ArrowRight className="wf-node-arrow" size={14} />}
              </Fragment>
            );
          })}
        </div>
      </section>

      <section className="wf-breakdown-card">
        <div className="wf-breakdown-head">
          <h3>Step Breakdown</h3>
          <span>Avg. Duration: {avgDuration}</span>
        </div>
        <ol className="wf-breakdown-list">
          {workflow.steps.map((step, index) => {
            const meta = stepKindMeta[step.kind];
            const Icon = meta.icon;
            return (
              <li key={step.id}>
                <span className="wf-breakdown-index">{index + 1}</span>
                <span className={`wf-breakdown-icon accent-${meta.accent}`}>
                  <Icon size={14} />
                </span>
                <span className="wf-breakdown-copy">
                  <strong>{step.name}</strong>
                  <small>{step.summary || meta.label}</small>
                </span>
                <span className="wf-breakdown-dur">{formatDuration(step.timeoutSeconds * 1000)}</span>
                <CheckCircle2 className="wf-breakdown-check" size={15} />
              </li>
            );
          })}
        </ol>
      </section>

      <section className="wf-runs-card">
        <div className="wf-runs-head">
          <h3>Recent Runs</h3>
          <span className="wf-trigger-pill">
            <TriggerIcon size={12} /> {triggerMeta[workflow.trigger.type].label}
            {workflow.trigger.schedule ? ` • ${workflow.trigger.schedule}` : ""}
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="wf-empty">No runs yet. Press “Run now” to start one.</p>
        ) : (
          <ul className="wf-run-list">
            {runs.slice(0, 5).map((run) => {
              const status = runStatusMeta[run.status];
              const StatusIcon = status.icon;
              return (
                <li key={run.id}>
                  <span className={`wf-run-status accent-${status.accent}`}>
                    <StatusIcon size={14} />
                  </span>
                  <span className="wf-run-time">{formatRelative(run.startedAt)}</span>
                  <span className={`wf-run-badge accent-${status.accent}`}>{status.label}</span>
                  <span className="wf-run-dur">{formatDuration(run.durationMs)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="wf-integrations-card">
        <div className="wf-runs-head">
          <h3>Linked Agents &amp; Integrations</h3>
        </div>
        {workflow.integrations.length === 0 ? (
          <p className="wf-empty">No integrations linked.</p>
        ) : (
          <div className="wf-integration-grid">
            {workflow.integrations.map((name) => (
              <span className="wf-integration" key={name}>
                <i>{name.slice(0, 1)}</i>
                <small>{name}</small>
              </span>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function RunsTab({ runs }: { runs: WorkflowRunRecord[] }) {
  if (runs.length === 0) {
    return <p className="wf-empty">No runs recorded yet.</p>;
  }

  return (
    <ul className="wf-run-list detailed">
      {runs.map((run) => {
        const status = runStatusMeta[run.status];
        const StatusIcon = status.icon;
        const done = run.steps.filter((step) => step.status === "success").length;
        return (
          <li key={run.id}>
            <span className={`wf-run-status accent-${status.accent}`}>
              <StatusIcon size={14} />
            </span>
            <span className="wf-run-copy">
              <strong>{formatRelative(run.startedAt)}</strong>
              <small>
                {done}/{run.steps.length} steps • triggered by {run.triggeredBy}
              </small>
            </span>
            <span className={`wf-run-badge accent-${status.accent}`}>{status.label}</span>
            <span className="wf-run-dur">{formatDuration(run.durationMs)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StepsTab({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <ul className="wf-steps-tab">
      {workflow.steps.map((step, index) => {
        const meta = stepKindMeta[step.kind];
        const Icon = meta.icon;
        return (
          <li key={step.id} className={step.enabled ? "" : "muted"}>
            <div className="wf-steps-tab-head">
              <span className="wf-breakdown-index">{index + 1}</span>
              <span className={`wf-breakdown-icon accent-${meta.accent}`}>
                <Icon size={14} />
              </span>
              <strong>{step.name}</strong>
              <span className={`wf-kind-tag accent-${meta.accent}`}>{meta.label}</span>
            </div>
            <p className="wf-steps-tab-instruction">{step.instruction}</p>
            <div className="wf-steps-tab-meta">
              <span>{step.cliId}</span>
              {step.model && <span>{step.model}</span>}
              <span>{formatDuration(step.timeoutSeconds * 1000)} timeout</span>
              {step.requiresApproval && <span className="accent-amber">approval</span>}
              {step.continueOnError && <span className="accent-blue">continue on error</span>}
              {!step.enabled && <span className="accent-red">disabled</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LogsTab({
  logs,
  logRef,
}: {
  logs: WorkflowEvent[];
  logRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="wf-logs" ref={logRef}>
      {logs.length === 0 ? (
        <p className="wf-empty">Logs stream here while the workflow runs.</p>
      ) : (
        logs.map((entry, index) => (
          <div className={`wf-log-line ${entry.status === "failed" ? "error" : ""}`} key={`${entry.timestamp}-${index}`}>
            <span className="wf-log-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span className="wf-log-msg">
              {entry.stepName ? `[${entry.stepName}] ` : ""}
              {entry.message ?? entry.type}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
