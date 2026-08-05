import { Check, FileDiff, GitBranch, GitCommit, RefreshCw, RotateCcw } from "lucide-react";
import type { GitDiffSummary, GitFileChange, GitFileChangeKind, GitFileDiff, ProjectSummary } from "@contracts";
import { useEffect, useMemo, useState } from "react";

type PanelView = "files" | "patch" | "stat" | "log";

const kindLabels: Record<GitFileChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "!",
};

export function GitDiffPanel({
  diff,
  project,
  onRefresh,
}: {
  diff: GitDiffSummary | null;
  project: ProjectSummary | null;
  onRefresh: () => Promise<void>;
}) {
  const [view, setView] = useState<PanelView>("files");
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [logEntries, setLogEntries] = useState<Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>>([]);

  const staged = diff?.files.filter((file) => file.staged) ?? [];
  const unstaged = diff?.files.filter((file) => !file.staged) ?? [];
  const selectableKey = selected ? keyFor(selected) : null;
  const selectedStillExists = useMemo(
    () => (selectableKey ? (diff?.files ?? []).some((file) => keyFor(file) === selectableKey) : false),
    [diff?.files, selectableKey],
  );

  useEffect(() => {
    if (!selectedStillExists) {
      setSelected(null);
      setFileDiff(null);
      if (view === "patch") setView("files");
    }
  }, [selectedStillExists, view]);

  useEffect(() => {
    if (!project || !selected || view !== "patch") return;
    let cancelled = false;
    setLoadingPatch(true);
    window.agentic.git
      .fileDiff(project.path, selected.path, selected.staged)
      .then((next) => {
        if (!cancelled) setFileDiff(next);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setFileDiff({
            cwd: project.path,
            path: selected.path,
            staged: selected.staged,
            patch: "",
            isRepository: true,
            error: error.message,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPatch(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, selected, view]);

  useEffect(() => {
    if (!project || view !== "log") return;
    let cancelled = false;
    window.agentic.git.log(project.path, 12).then((entries) => {
      if (!cancelled) setLogEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [project, view]);

  async function stage(file: GitFileChange) {
    if (!project) return;
    const result = await window.agentic.git.stage(project.path, file.path);
    setOperationMessage(result.message);
    await onRefresh();
    if (result.summary) {
      setSelected(result.summary.files.find((next) => next.path === file.path) ?? null);
    }
  }

  async function unstage(file: GitFileChange) {
    if (!project) return;
    const result = await window.agentic.git.unstage(project.path, file.path);
    setOperationMessage(result.message);
    await onRefresh();
    if (result.summary) {
      setSelected(result.summary.files.find((next) => next.path === file.path) ?? null);
    }
  }

  async function commit() {
    if (!project || !commitMessage.trim()) return;
    setCommitting(true);
    try {
      const result = await window.agentic.git.commit(project.path, commitMessage);
      setOperationMessage(result.message);
      if (result.ok) setCommitMessage("");
      await onRefresh();
      if (view === "log") {
        setLogEntries(await window.agentic.git.log(project.path, 12));
      }
    } finally {
      setCommitting(false);
    }
  }

  return (
    <section className="bottom-card git-card">
      <header>
        <div>
          <h2>Git Workspace</h2>
          <p>{project ? project.path : "Select a project to inspect changes"}</p>
        </div>
        <div className="git-header-actions">
          <div className="git-view-toggle" role="tablist" aria-label="Git panel view">
            <ViewButton active={view === "files"} label="Files" onClick={() => setView("files")} />
            <ViewButton active={view === "patch"} disabled={!selected} label="Patch" onClick={() => setView("patch")} />
            <ViewButton active={view === "stat"} label="Stat" onClick={() => setView("stat")} />
            <ViewButton active={view === "log"} label="Log" onClick={() => setView("log")} />
          </div>
          <button className="ghost-button" disabled={!project} onClick={() => void onRefresh()}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="git-summary">
        <span>
          <GitBranch size={14} />
          {diff?.branch ?? "No project"}
          {diff?.isRepository && (
            <em className="git-counts">
              {diff.stagedCount} staged · {diff.unstagedCount} unstaged · {diff.untrackedCount} untracked
            </em>
          )}
        </span>

        {operationMessage && <p className="git-operation-message">{operationMessage}</p>}

        {!diff ? (
          <p className="git-empty">No git data loaded.</p>
        ) : !diff.isRepository ? (
          <p className="git-empty">This folder is not a git repository.</p>
        ) : view === "stat" ? (
          <pre>{diff.diffStat}</pre>
        ) : view === "patch" ? (
          <PatchView fileDiff={fileDiff} loading={loadingPatch} selected={selected} />
        ) : view === "log" ? (
          <LogView entries={logEntries} />
        ) : diff.files.length === 0 ? (
          <p className="git-empty">Clean working tree — nothing to review.</p>
        ) : (
          <div className="git-workspace-view">
            <div className="git-file-scroll">
              <FileGroup
                label="Staged"
                files={staged}
                onSelect={(file) => {
                  setSelected(file);
                  setView("patch");
                }}
                selected={selected}
                actionLabel="Unstage"
                onAction={(file) => void unstage(file)}
              />
              <FileGroup
                label="Working tree"
                files={unstaged}
                onSelect={(file) => {
                  setSelected(file);
                  setView("patch");
                }}
                selected={selected}
                actionLabel="Stage"
                onAction={(file) => void stage(file)}
              />
            </div>
            <form
              className="git-commit-box"
              onSubmit={(event) => {
                event.preventDefault();
                void commit();
              }}
            >
              <label htmlFor="git-commit-message">Commit staged changes</label>
              <textarea
                id="git-commit-message"
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                rows={2}
                value={commitMessage}
              />
              <button className="primary-action" disabled={diff.stagedCount === 0 || !commitMessage.trim() || committing} type="submit">
                <GitCommit size={13} />
                {committing ? "Committing…" : "Commit"}
              </button>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

function ViewButton({ active, disabled, label, onClick }: { active: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      aria-selected={active}
      className={active ? "active" : ""}
      disabled={disabled}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

function FileGroup({
  actionLabel,
  files,
  label,
  onAction,
  onSelect,
  selected,
}: {
  actionLabel: string;
  files: GitFileChange[];
  label: string;
  onAction: (file: GitFileChange) => void;
  onSelect: (file: GitFileChange) => void;
  selected: GitFileChange | null;
}) {
  if (files.length === 0) return null;

  return (
    <div className="git-file-group">
      <h3>
        <FileDiff size={12} />
        {label} <span>{files.length}</span>
      </h3>
      <ul>
        {files.map((file) => {
          const active = selected ? keyFor(selected) === keyFor(file) : false;
          return (
            <li className={active ? "selected" : ""} key={`${label}-${file.path}-${file.code}`} title={`${file.code} ${file.path}`}>
              <button className="git-file-button" onClick={() => onSelect(file)} type="button">
                <i className={`git-kind git-kind-${file.kind}`}>{kindLabels[file.kind]}</i>
                <span>{file.path}</span>
              </button>
              <button className="git-row-action" onClick={() => onAction(file)} type="button">
                {actionLabel === "Stage" ? <Check size={12} /> : <RotateCcw size={12} />}
                {actionLabel}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PatchView({
  fileDiff,
  loading,
  selected,
}: {
  fileDiff: GitFileDiff | null;
  loading: boolean;
  selected: GitFileChange | null;
}) {
  if (!selected) return <p className="git-empty">Select a file to inspect its patch.</p>;
  if (loading) return <p className="git-empty">Loading patch…</p>;
  if (fileDiff?.error) return <pre>{fileDiff.error}</pre>;
  return <pre>{fileDiff?.patch || "No patch for this file."}</pre>;
}

function LogView({ entries }: { entries: Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }> }) {
  if (entries.length === 0) return <p className="git-empty">No commits to show.</p>;

  return (
    <div className="git-log-list">
      {entries.map((entry) => (
        <article key={entry.hash}>
          <strong>{entry.subject}</strong>
          <span>
            {entry.shortHash} · {entry.author} · {formatDate(entry.date)}
          </span>
        </article>
      ))}
    </div>
  );
}

function keyFor(file: GitFileChange): string {
  return `${file.path}:${file.staged ? "staged" : "worktree"}:${file.code}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
