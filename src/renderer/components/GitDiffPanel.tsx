import { FileDiff, GitBranch, RefreshCw } from "lucide-react";
import type { GitDiffSummary, GitFileChange, GitFileChangeKind, ProjectSummary } from "@contracts";
import { useState } from "react";

type PanelView = "files" | "stat";

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
  onRefresh: () => void;
}) {
  const [view, setView] = useState<PanelView>("files");

  const staged = diff?.files.filter((file) => file.staged) ?? [];
  const unstaged = diff?.files.filter((file) => !file.staged) ?? [];

  return (
    <section className="bottom-card git-card">
      <header>
        <div>
          <h2>Git Diff Viewer</h2>
          <p>{project ? project.path : "Select a project to inspect changes"}</p>
        </div>
        <div className="git-header-actions">
          <div className="git-view-toggle" role="tablist" aria-label="Git panel view">
            <button
              aria-selected={view === "files"}
              className={view === "files" ? "active" : ""}
              onClick={() => setView("files")}
              role="tab"
              type="button"
            >
              Files
            </button>
            <button
              aria-selected={view === "stat"}
              className={view === "stat" ? "active" : ""}
              onClick={() => setView("stat")}
              role="tab"
              type="button"
            >
              Stat
            </button>
          </div>
          <button className="ghost-button" disabled={!project} onClick={onRefresh}>
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

        {!diff ? (
          <p className="git-empty">No git data loaded.</p>
        ) : !diff.isRepository ? (
          <p className="git-empty">This folder is not a git repository.</p>
        ) : view === "stat" ? (
          <pre>{diff.diffStat}</pre>
        ) : diff.files.length === 0 ? (
          <p className="git-empty">Clean working tree — nothing to review.</p>
        ) : (
          <div className="git-file-scroll">
            <FileGroup label="Staged" files={staged} />
            <FileGroup label="Working tree" files={unstaged} />
          </div>
        )}
      </div>
    </section>
  );
}

function FileGroup({ label, files }: { label: string; files: GitFileChange[] }) {
  if (files.length === 0) return null;

  return (
    <div className="git-file-group">
      <h3>
        <FileDiff size={12} />
        {label} <span>{files.length}</span>
      </h3>
      <ul>
        {files.map((file) => (
          <li key={`${label}-${file.path}-${file.code}`} title={`${file.code} ${file.path}`}>
            <i className={`git-kind git-kind-${file.kind}`}>{kindLabels[file.kind]}</i>
            <span>{file.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
