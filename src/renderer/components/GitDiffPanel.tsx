import { Archive, Check, FileDiff, GitBranch, GitCommit, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import type {
  GitBranchSummary,
  GitDiffSummary,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitStashDetail,
  GitStashEntry,
  ProjectSummary,
} from "@contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

type PanelView = "files" | "patch" | "stat" | "log" | "branches" | "stashes";

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
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [stashDetail, setStashDetail] = useState<GitStashDetail | null>(null);
  const [busy, setBusy] = useState(false);

  // Branch and stash lists are read on demand rather than pushed with the diff:
  // both cost their own git invocation, and neither changes while the user is
  // looking at the file list.
  const loadBranches = useCallback(async () => {
    if (!project) return;
    setBranches(await window.agentic.git.branches(project.path));
  }, [project]);

  const loadStashes = useCallback(async () => {
    if (!project) return;
    setStashes(await window.agentic.git.stashes(project.path));
  }, [project]);

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

  useEffect(() => {
    if (view === "branches") void loadBranches();
    if (view === "stashes") void loadStashes();
  }, [loadBranches, loadStashes, view]);

  // A stale detail panel would describe a stash the user is no longer looking at,
  // and after a drop the ref it names may belong to a different entry entirely.
  useEffect(() => {
    setStashDetail(null);
  }, [project, stashes]);

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

  /**
   * Every branch/stash mutation goes through here so the panel cannot drift from
   * git: one call, then re-read the diff *and* both lists, because a checkout
   * changes the branch list and a stash push changes the file list too.
   */
  async function runGitAction(action: () => Promise<{ ok: boolean; message: string }>) {
    if (!project || busy) return;
    setBusy(true);
    try {
      const result = await action();
      setOperationMessage(result.message);
      await Promise.all([onRefresh(), loadBranches(), loadStashes()]);
      return result;
    } finally {
      setBusy(false);
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
            <ViewButton active={view === "branches"} label="Branches" onClick={() => setView("branches")} />
            <ViewButton active={view === "stashes"} label="Stashes" onClick={() => setView("stashes")} />
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
        ) : view === "branches" ? (
          <BranchView
            branches={branches}
            busy={busy}
            dirty={diff.unstagedCount + diff.stagedCount > 0}
            newBranch={newBranch}
            onCheckout={(name) => void runGitAction(() => window.agentic.git.checkout(project!.path, name))}
            onCreate={() =>
              void runGitAction(() => window.agentic.git.checkout(project!.path, newBranch, true)).then((result) => {
                if (result?.ok) setNewBranch("");
              })
            }
            onNewBranchChange={setNewBranch}
          />
        ) : view === "stashes" ? (
          <StashView
            busy={busy}
            detail={stashDetail}
            entries={stashes}
            includeUntracked={includeUntracked}
            message={stashMessage}
            onApply={(entry, keep) => void runGitAction(() => window.agentic.git.stashApply(project!.path, entry.ref, keep))}
            onDrop={(entry) => {
              // Drop has no ordinary undo. Name the exact stack ref and message in
              // the confirmation, then send that message to the backend as a
              // second stack-shift guard before git is allowed to delete it.
              const confirmed = window.confirm(`Drop ${entry.ref}?\n\n${entry.message}\n\nThis cannot be undone.`);
              if (confirmed) {
                void runGitAction(() => window.agentic.git.stashDrop(project!.path, entry.ref, entry.message));
              }
            }}
            onIncludeUntrackedChange={setIncludeUntracked}
            onInspect={async (entry) => {
              setStashDetail(await window.agentic.git.stashDetail(project!.path, entry.ref));
            }}
            onMessageChange={setStashMessage}
            onPush={() =>
              void runGitAction(() =>
                window.agentic.git.stashPush(project!.path, stashMessage, includeUntracked),
              ).then((result) => {
                if (result?.ok) setStashMessage("");
              })
            }
          />
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

function BranchView({
  branches,
  busy,
  dirty,
  newBranch,
  onCheckout,
  onCreate,
  onNewBranchChange,
}: {
  branches: GitBranchSummary[];
  busy: boolean;
  dirty: boolean;
  newBranch: string;
  onCheckout: (name: string) => void;
  onCreate: () => void;
  onNewBranchChange: (value: string) => void;
}) {
  return (
    <div className="git-workspace-view">
      <div className="git-file-scroll">
        {dirty && (
          <p className="git-warning">
            Uncommitted changes present. Switching branches is blocked until they are committed or stashed.
          </p>
        )}
        {branches.length === 0 ? (
          <p className="git-empty">No local branches found.</p>
        ) : (
          <div className="git-file-group">
            <h3>
              <GitBranch size={12} />
              Local branches <span>{branches.length}</span>
            </h3>
            <ul>
              {branches.map((branch) => (
                <li className={branch.current ? "selected" : ""} key={branch.name} title={branch.subject ?? branch.name}>
                  <span className="git-branch-row">
                    <i className={`git-kind ${branch.current ? "git-kind-added" : "git-kind-modified"}`}>
                      {branch.current ? "●" : "○"}
                    </i>
                    <span>{branch.name}</span>
                    {branch.upstream && <em className="git-branch-upstream">{branch.upstream}</em>}
                  </span>
                  {branch.current ? (
                    <em className="git-branch-current">current</em>
                  ) : (
                    <button
                      className="git-row-action"
                      disabled={busy || dirty}
                      onClick={() => onCheckout(branch.name)}
                      type="button"
                    >
                      <Check size={12} />
                      Switch
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <form
        className="git-commit-box"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <label htmlFor="git-new-branch">Create branch from HEAD</label>
        <input
          className="git-inline-input"
          id="git-new-branch"
          onChange={(event) => onNewBranchChange(event.target.value)}
          placeholder="feature/short-description"
          value={newBranch}
        />
        <button className="primary-action" disabled={busy || dirty || !newBranch.trim()} type="submit">
          <Plus size={13} />
          Create and switch
        </button>
      </form>
    </div>
  );
}

function StashView({
  busy,
  detail,
  entries,
  includeUntracked,
  message,
  onApply,
  onDrop,
  onIncludeUntrackedChange,
  onInspect,
  onMessageChange,
  onPush,
}: {
  busy: boolean;
  detail: GitStashDetail | null;
  entries: GitStashEntry[];
  includeUntracked: boolean;
  message: string;
  onApply: (entry: GitStashEntry, keep: boolean) => void;
  onDrop: (entry: GitStashEntry) => void;
  onIncludeUntrackedChange: (value: boolean) => void;
  onInspect: (entry: GitStashEntry) => void;
  onMessageChange: (value: string) => void;
  onPush: () => void;
}) {
  return (
    <div className="git-workspace-view">
      <div className="git-file-scroll">
        {entries.length === 0 ? (
          <p className="git-empty">No stash entries.</p>
        ) : (
          <div className="git-file-group">
            <h3>
              <Archive size={12} />
              Stash stack <span>{entries.length}</span>
            </h3>
            <ul>
              {entries.map((entry) => (
                <li key={entry.ref} title={`${entry.ref} · ${entry.message}`}>
                  <button className="git-file-button" onClick={() => onInspect(entry)} type="button">
                    <i className="git-kind git-kind-modified">{entry.index}</i>
                    <span>{entry.message}</span>
                  </button>
                  <span className="git-stash-actions">
                    {/* Apply keeps the entry, pop consumes it: both are offered
                        because "restore and keep a copy" is the safer default and
                        "restore and clean up" is what the user usually wants next. */}
                    <button className="git-row-action" disabled={busy} onClick={() => onApply(entry, true)} type="button">
                      <RotateCcw size={12} />
                      Apply
                    </button>
                    <button className="git-row-action" disabled={busy} onClick={() => onApply(entry, false)} type="button">
                      <Check size={12} />
                      Pop
                    </button>
                    <button className="git-row-action" disabled={busy} onClick={() => onDrop(entry)} type="button">
                      <Trash2 size={12} />
                      Drop
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {detail && (
          <div className="git-stash-detail">
            <h3>
              {detail.ref}
              {detail.files.length > 0 && <span>{detail.files.length} files</span>}
            </h3>
            <pre>{detail.error ?? detail.patch ?? "No patch for this stash."}</pre>
          </div>
        )}
      </div>
      <form
        className="git-commit-box"
        onSubmit={(event) => {
          event.preventDefault();
          onPush();
        }}
      >
        <label htmlFor="git-stash-message">Stash current changes</label>
        <input
          className="git-inline-input"
          id="git-stash-message"
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder="Optional description"
          value={message}
        />
        <label className="git-checkbox" htmlFor="git-stash-untracked">
          <input
            checked={includeUntracked}
            id="git-stash-untracked"
            onChange={(event) => onIncludeUntrackedChange(event.target.checked)}
            type="checkbox"
          />
          Include untracked files
        </label>
        <button className="primary-action" disabled={busy} type="submit">
          <Archive size={13} />
          Stash
        </button>
      </form>
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
