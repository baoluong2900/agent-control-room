import {
  Archive,
  Check,
  CloudDownload,
  CloudUpload,
  FileDiff,
  GitBranch,
  GitCommit,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  GitBlameResult,
  GitBranchSummary,
  GitDiffSummary,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitPushPlan,
  GitStashDetail,
  GitStashEntry,
  GitTrackingStatus,
  ProjectSummary,
} from "@contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

type PanelView = "files" | "patch" | "blame" | "stat" | "log" | "branches" | "stashes" | "remote";

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
  const [tracking, setTracking] = useState<GitTrackingStatus | null>(null);
  const [pushPlan, setPushPlan] = useState<GitPushPlan | null>(null);
  const [selectedRemote, setSelectedRemote] = useState("");
  const [allowProtectedPush, setAllowProtectedPush] = useState(false);
  const [blame, setBlame] = useState<GitBlameResult | null>(null);
  const [loadingBlame, setLoadingBlame] = useState(false);

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

  /**
   * Tracking status and the push plan are read together, and always from the main
   * process. The plan is what the confirmation renders, so recomputing any part of
   * it here would let the dialog describe a push different from the one that runs.
   */
  const loadRemoteState = useCallback(async () => {
    if (!project) return;
    const [nextTracking, nextPlan] = await Promise.all([
      window.agentic.git.tracking(project.path),
      window.agentic.git.pushPlan(project.path, selectedRemote || undefined),
    ]);
    setTracking(nextTracking);
    setPushPlan(nextPlan);
  }, [project, selectedRemote]);

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
      setBlame(null);
      if (view === "patch" || view === "blame") setView("files");
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
    if (view === "remote") void loadRemoteState();
  }, [loadBranches, loadRemoteState, loadStashes, view]);

  useEffect(() => {
    if (!project || !selected || view !== "blame") return;
    let cancelled = false;
    setLoadingBlame(true);
    window.agentic.git.blame(project.path, selected.path)
      .then((next) => {
        if (!cancelled) setBlame(next);
      })
      .catch((error: Error) => {
        if (!cancelled) setBlame({ cwd: project.path, path: selected.path, lines: [], error: error.message });
      })
      .finally(() => {
        if (!cancelled) setLoadingBlame(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, selected, view]);

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
      // Remote state is refreshed too: a fetch changes ahead/behind, a pull changes
      // the file list, and a push changes whether an upstream now exists. Leaving
      // any of those stale is how a panel shows a push that has already happened.
      await Promise.all([onRefresh(), loadBranches(), loadStashes(), loadRemoteState()]);
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
            <ViewButton active={view === "blame"} disabled={!selected} label="Blame" onClick={() => setView("blame")} />
            <ViewButton active={view === "stat"} label="Stat" onClick={() => setView("stat")} />
            <ViewButton active={view === "log"} label="Log" onClick={() => setView("log")} />
            <ViewButton active={view === "branches"} label="Branches" onClick={() => setView("branches")} />
            <ViewButton active={view === "stashes"} label="Stashes" onClick={() => setView("stashes")} />
            <ViewButton active={view === "remote"} label="Remote" onClick={() => setView("remote")} />
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
        ) : view === "blame" ? (
          <BlameView blame={blame} loading={loadingBlame} selected={selected} />
        ) : view === "log" ? (
          <LogView entries={logEntries} />
        ) : view === "remote" ? (
          <RemoteView
            allowProtected={allowProtectedPush}
            busy={busy}
            dirty={diff.unstagedCount + diff.stagedCount > 0}
            onAllowProtectedChange={setAllowProtectedPush}
            onFetch={() => void runGitAction(() => window.agentic.git.fetch(project!.path, selectedRemote || undefined))}
            onPull={() => void runGitAction(() => window.agentic.git.pull(project!.path, selectedRemote || undefined))}
            onPush={() => {
              if (!pushPlan?.pushable) return;
              // Push is the only action here that sends code off the machine, so the
              // confirmation names the exact remote, branch and commit count from the
              // plan the main process resolved — not a generic "are you sure".
              const published = pushPlan.ahead ?? 0;
              const noun = published === 1 ? "commit" : "commits";
              const lines = [
                `Push ${published} ${noun} to ${pushPlan.remote}/${pushPlan.branch}?`,
                "",
                `Remote: ${pushPlan.remotes.find((entry) => entry.name === pushPlan.remote)?.fetchUrl ?? pushPlan.remote}`,
                pushPlan.createsUpstream
                  ? `This creates ${pushPlan.remote}/${pushPlan.branch} and sets it as upstream.`
                  : `Upstream: ${pushPlan.upstream ?? `${pushPlan.remote}/${pushPlan.branch}`}`,
              ];
              if (pushPlan.protectedBranch) lines.push("", `${pushPlan.branch} is a protected branch.`);
              if ((pushPlan.behind ?? 0) > 0) {
                lines.push("", `${pushPlan.remote} is ${pushPlan.behind} ahead — this push will be rejected. Pull first.`);
              }
              if (window.confirm(lines.join("\n"))) {
                void runGitAction(() =>
                  window.agentic.git.push(project!.path, {
                    remote: selectedRemote || undefined,
                    allowProtected: allowProtectedPush,
                    // HEAD can move between rendering this dialog and clicking it;
                    // the backend refuses rather than pushing an unmentioned branch.
                    expectedBranch: pushPlan.branch,
                  }),
                );
              }
            }}
            onRemoteChange={setSelectedRemote}
            plan={pushPlan}
            selectedRemote={selectedRemote}
            tracking={tracking}
          />
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
            onApply={(entry, keep) =>
              void runGitAction(() => window.agentic.git.stashApply(project!.path, entry.ref, entry.oid, keep))
            }
            onDrop={(entry) => {
              // Drop has no ordinary undo. Name the exact stack ref and message in
              // the confirmation, then send that message to the backend as a
              // second stack-shift guard before git is allowed to delete it.
              const confirmed = window.confirm(`Drop ${entry.ref}?\n\n${entry.message}\n\nThis cannot be undone.`);
              if (confirmed) {
                void runGitAction(() => window.agentic.git.stashDrop(project!.path, entry.ref, entry.oid));
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

function BlameView({
  blame,
  loading,
  selected,
}: {
  blame: GitBlameResult | null;
  loading: boolean;
  selected: GitFileChange | null;
}) {
  if (!selected) return <p className="git-empty">Select a file to see who last touched each line.</p>;
  if (loading) return <p className="git-empty">Reading blame…</p>;
  if (blame?.error) return <p className="git-empty">{blame.error}</p>;
  if (!blame || blame.lines.length === 0) return <p className="git-empty">No blame data for this file.</p>;

  return (
    <div className="git-blame-list">
      {blame.lines.map((line) => (
        <div className="git-blame-row" key={`${line.line}-${line.hash}`} title={`${line.shortHash} · ${line.summary}`}>
          <em className="git-blame-meta">
            {line.shortHash} {line.author}
          </em>
          <span className="git-blame-line">{line.line}</span>
          <code>{line.content || " "}</code>
        </div>
      ))}
    </div>
  );
}

/**
 * Fetch, pull and push.
 *
 * Ordered by how much they can cost you: fetch changes nothing local, pull only
 * fast-forwards, push is the one that publishes. Every number shown here comes from
 * the plan the main process resolved, so the panel cannot promise a push that
 * differs from the one the backend performs.
 */
function RemoteView({
  allowProtected,
  busy,
  dirty,
  onAllowProtectedChange,
  onFetch,
  onPull,
  onPush,
  onRemoteChange,
  plan,
  selectedRemote,
  tracking,
}: {
  allowProtected: boolean;
  busy: boolean;
  dirty: boolean;
  onAllowProtectedChange: (value: boolean) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRemoteChange: (value: string) => void;
  plan: GitPushPlan | null;
  selectedRemote: string;
  tracking: GitTrackingStatus | null;
}) {
  const remotes = plan?.remotes ?? [];
  const behind = tracking?.behind ?? 0;
  const ahead = plan?.ahead ?? tracking?.ahead ?? 0;
  const protectedBlocked = Boolean(plan?.protectedBranch) && !allowProtected;

  if (remotes.length === 0) {
    return (
      <div className="git-workspace-view">
        <div className="git-file-scroll">
          <p className="git-empty">
            No remote is configured for this repository. Add one with <code>git remote add origin …</code> to fetch or push
            from here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="git-workspace-view">
      <div className="git-file-scroll">
        <div className="git-file-group">
          <h3>
            <CloudDownload size={12} />
            Tracking
          </h3>
          <div className="git-remote-status">
            <p>
              <strong>{tracking?.branch ?? plan?.branch ?? "—"}</strong>
              {tracking?.upstream ? (
                <em>tracking {tracking.upstream}</em>
              ) : (
                <em>no upstream yet</em>
              )}
            </p>
            <p className="git-remote-counts">
              {ahead} ahead · {behind} behind
            </p>
            {/* Said plainly because it is the single most misread number here: git
                cannot know it is behind until the remote-tracking ref is updated. */}
            <p className="git-remote-hint">Counts reflect the last fetch. Fetch to refresh them.</p>
          </div>
        </div>

        {dirty && (
          <p className="git-warning">Uncommitted changes present. Pull is blocked until they are committed or stashed.</p>
        )}
        {behind > 0 && ahead > 0 && (
          <p className="git-warning">
            This branch and its upstream have diverged. Push will be rejected, and this app only fast-forwards — resolve it
            with git directly.
          </p>
        )}
        {plan && !plan.pushable && plan.reason && <p className="git-warning">{plan.reason}</p>}

        <div className="git-remote-actions">
          <button className="git-row-action" disabled={busy} onClick={onFetch} type="button">
            <CloudDownload size={12} />
            Fetch
          </button>
          <button
            className="git-row-action"
            disabled={busy || dirty || behind === 0 || !tracking?.upstream}
            onClick={onPull}
            type="button"
          >
            <RotateCcw size={12} />
            Pull (fast-forward)
          </button>
          <button
            className="git-row-action"
            disabled={busy || !plan?.pushable || protectedBlocked || (ahead === 0 && !plan?.createsUpstream)}
            onClick={onPush}
            type="button"
          >
            <CloudUpload size={12} />
            {plan?.createsUpstream ? "Publish branch" : "Push"}
          </button>
        </div>
      </div>

      <div className="git-commit-box">
        <label htmlFor="git-remote-select">Remote</label>
        <select
          className="git-inline-input"
          id="git-remote-select"
          onChange={(event) => onRemoteChange(event.target.value)}
          value={selectedRemote || plan?.remote || ""}
        >
          {remotes.map((remote) => (
            <option key={remote.name} value={remote.name}>
              {remote.name}
              {remote.fetchUrl ? ` — ${remote.fetchUrl}` : ""}
            </option>
          ))}
        </select>
        {plan?.protectedBranch && (
          <label className="git-checkbox" htmlFor="git-allow-protected">
            <input
              checked={allowProtected}
              id="git-allow-protected"
              onChange={(event) => onAllowProtectedChange(event.target.checked)}
              type="checkbox"
            />
            Allow pushing to {plan.branch} (protected)
          </label>
        )}
        <p className="git-remote-hint">Force push is never available here.</p>
      </div>
    </div>
  );
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
