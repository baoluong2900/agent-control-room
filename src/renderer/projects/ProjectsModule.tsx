import { Clock3, FolderOpen, GitBranch, History, RefreshCw, Terminal, X } from "lucide-react";
import type { GitDiffSummary, ProjectSummary, SystemDiagnostics, AgentRunRecord } from "@contracts";
import type { ReactNode } from "react";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { HistoryPanel } from "../components/HistoryPanel";
import "./projects.css";

export function ProjectsModule({
  diagnostics,
  gitDiff,
  history,
  onPickFolder,
  onRefreshGitDiff,
  onRemoveRecent,
  onSelectRecent,
  project,
  recentProjects,
}: {
  diagnostics: SystemDiagnostics | null;
  gitDiff: GitDiffSummary | null;
  history: AgentRunRecord[];
  onPickFolder: () => Promise<string | null>;
  onRefreshGitDiff: () => Promise<void>;
  onRemoveRecent: (projectPath: string) => Promise<void>;
  onSelectRecent: (project: ProjectSummary) => Promise<void>;
  project: ProjectSummary | null;
  recentProjects: ProjectSummary[];
}) {
  const installedTools = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const totalTools = diagnostics?.tools.length ?? 0;
  const projectRuns = project ? history.filter((run) => run.cwd === project.path).length : 0;

  return (
    <div className="projects-page">
      <section className="projects-hero">
        <div>
          <span className="projects-eyebrow">
            <FolderOpen size={13} />
            Local project workspace
          </span>
          <h1>Projects</h1>
          <p>{project ? project.path : "Pick a project folder to enable agent runs, Git diff, and task routing."}</p>
        </div>
        <div className="projects-actions">
          <button className="ghost-button" onClick={() => void onRefreshGitDiff()} disabled={!project}>
            <RefreshCw size={14} />
            Refresh Git
          </button>
          <button className="primary-action" onClick={() => void onPickFolder()}>
            <FolderOpen size={15} />
            Pick Folder
          </button>
        </div>
      </section>

      <section className="projects-stat-grid">
        <ProjectStat icon={<FolderOpen size={15} />} label="Recent Projects" value={recentProjects.length} />
        <ProjectStat icon={<Terminal size={15} />} label="Runs Here" value={projectRuns} />
        <ProjectStat icon={<GitBranch size={15} />} label="Git Branch" value={gitDiff?.branch ?? "—"} />
        <ProjectStat icon={<Clock3 size={15} />} label="Tools Ready" value={`${installedTools}/${totalTools || "—"}`} />
      </section>

      <div className="projects-layout">
        <section className="projects-list-panel">
          <header>
            <div>
              <h2>Recent Projects</h2>
              <p>Loaded from the local SQLite project history.</p>
            </div>
            <History size={15} />
          </header>
          <div className="projects-list">
            {recentProjects.map((item) => (
              <div className={`projects-list-row ${project?.path === item.path ? "selected" : ""}`} key={item.path}>
                <button className="projects-list-open" onClick={() => void onSelectRecent(item)}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.path}</small>
                  </span>
                  <em>{formatRelative(item.lastOpenedAt)}</em>
                </button>
                <button
                  aria-label={`Remove ${item.name} from recent projects`}
                  className="projects-list-remove"
                  onClick={() => void onRemoveRecent(item.path)}
                  title="Forget this project"
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {recentProjects.length === 0 && <p>No recent projects yet.</p>}
          </div>
        </section>

        <aside className="projects-side">
          <DiagnosticsPanel diagnostics={diagnostics} />
          <GitDiffPanel diff={gitDiff} project={project} onRefresh={onRefreshGitDiff} />
        </aside>
      </div>

      <HistoryPanel history={history.filter((run) => (project ? run.cwd === project.path : true))} />
    </div>
  );
}

function ProjectStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <article className="project-stat">
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}
