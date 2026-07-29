import { GitBranch, RefreshCw } from "lucide-react";
import type { GitDiffSummary, ProjectSummary } from "@contracts";

export function GitDiffPanel({
  diff,
  project,
  onRefresh,
}: {
  diff: GitDiffSummary | null;
  project: ProjectSummary | null;
  onRefresh: () => void;
}) {
  return (
    <section className="bottom-card git-card">
      <header>
        <div>
          <h2>Git Diff Viewer</h2>
          <p>{project ? project.path : "Select a project to inspect changes"}</p>
        </div>
        <button className="ghost-button" disabled={!project} onClick={onRefresh}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </header>
      <div className="git-summary">
        <span>
          <GitBranch size={14} />
          {diff?.branch ?? "No project"}
        </span>
        <pre>{diff ? `${diff.status}\n\n${diff.diffStat}` : "No git data loaded."}</pre>
      </div>
    </section>
  );
}

