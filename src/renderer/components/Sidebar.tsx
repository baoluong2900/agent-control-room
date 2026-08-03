import { Bot, ChevronRight } from "lucide-react";
import { statusLabel, useAgentsStore } from "../stores/agents-store";
import { workspaceNavigation, type WorkspaceNavKey } from "../workspace-navigation";

export function Sidebar({
  activeNav,
  collapsed,
  onNavigate,
  onToggleCollapsed,
}: {
  activeNav: WorkspaceNavKey;
  collapsed: boolean;
  onNavigate: (nav: WorkspaceNavKey) => void;
  onToggleCollapsed: () => void;
}) {
  const profiles = useAgentsStore((state) => state.profiles);
  const runtimes = useAgentsStore((state) => state.runtimes);
  const sessions = useAgentsStore((state) => state.sessions);
  const liveProfiles = profiles.filter((profile) => sessions.some((session) => session.profileId === profile.id));

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <span className="logo-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="brand-name">AgenticOS</span>
      </div>

      <nav className="primary-nav" aria-label="Primary navigation">
        {workspaceNavigation.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={activeNav === key ? "active" : ""}
            onClick={() => onNavigate(key)}
            title={collapsed ? label : undefined}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span>{label}</span>
            {activeNav === key && <ChevronRight size={14} className="nav-chevron" />}
          </button>
        ))}
      </nav>

      <section className="active-agents-card">
        <header>
          <span>Active Agents</span>
          <small>
            {liveProfiles.length} / {profiles.length}
          </small>
        </header>
        <div className="agent-list">
          {profiles.length > 0 ? (
            profiles.slice(0, 6).map((profile) => {
              const runtime = runtimes[profile.id];
              const isLive = sessions.some((session) => session.profileId === profile.id);
              return (
                <button className="agent-row" key={profile.id} onClick={() => onNavigate("Agents")}>
                  <span className="agent-avatar" style={{ background: profile.accent }}>
                    <Bot size={16} strokeWidth={2} />
                    {isLive && <span className="agent-online" />}
                  </span>
                  <span className="agent-copy">
                    <strong>{profile.name}</strong>
                    <small>
                      <i className="status-dot dot-purple" />
                      {profile.model}
                    </small>
                  </span>
                  <em className={isLive ? "text-green" : "text-cyan"}>
                    {isLive ? "Running" : runtime ? statusLabel[runtime.status] : "Idle"}
                  </em>
                </button>
              );
            })
          ) : (
            <button className="agent-row" onClick={() => onNavigate("Agents")}>
              <span className="agent-avatar accent-blue">
                <Bot size={16} strokeWidth={2} />
              </span>
              <span className="agent-copy">
                <strong>No saved agents</strong>
                <small>
                  <i className="status-dot dot-blue" />
                  Create one from a detected CLI
                </small>
              </span>
              <em className="text-cyan">Idle</em>
            </button>
          )}
        </div>
        <button className="text-link" onClick={() => onNavigate("Agents")}>
          View all agents <ChevronRight size={13} />
        </button>
      </section>

      <button
        className="collapse-nav"
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        onClick={onToggleCollapsed}
        type="button"
      >
        <ChevronRight size={16} />
      </button>
    </aside>
  );
}
