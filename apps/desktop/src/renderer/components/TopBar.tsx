import { Bell, ChevronDown, ChevronRight, Layers, RefreshCw, Search } from "lucide-react";
import type { ProjectSummary, SystemDiagnostics } from "@contracts";
import { useMemo, useState } from "react";

const navTargets = ["Overview", "Projects", "Workflows", "Tasks", "Agents", "Settings"];

export function TopBar({
  diagnostics,
  onNavigate,
  project,
  onRefreshDiagnostics,
  onSelectProject,
}: {
  diagnostics: SystemDiagnostics | null;
  onNavigate: (nav: string) => void;
  project: ProjectSummary | null;
  onRefreshDiagnostics: () => void;
  onSelectProject: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const installedCount = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const total = diagnostics?.tools.length ?? 0;
  const missingTools = diagnostics?.tools.filter((tool) => !tool.installed) ?? [];
  const projectName = project?.name ?? "No Project Selected";
  const initials = workspaceInitials(project?.name);
  const toolsSummary = diagnostics ? `${installedCount}/${total} local tools detected` : "Scanning local tools";
  const statusLabel = diagnostics ? `${installedCount}/${total} Tools Ready` : "Diagnostics Pending";
  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return navTargets.filter((target) => !needle || target.toLowerCase().includes(needle));
  }, [search]);

  function openNav(target: string) {
    onNavigate(target);
    setSearch("");
    setSearchOpen(false);
  }

  return (
    <header className="topbar desktop-topbar">
      <div className="system-status" title={toolsSummary}>
        <span className="pulse-dot" />
        <span>
          <small>System Status</small>
          <strong>{statusLabel}</strong>
        </span>
        <ChevronRight size={13} />
      </div>

      <div className="topbar-actions">
        <button className="project-select" onClick={onSelectProject}>
          <Layers size={19} />
          <span>
            <small>Project</small>
            <strong>{projectName}</strong>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className={`search-control ${searchOpen ? "search-open" : ""}`}>
          {searchOpen && (
            <input
              autoFocus
              value={search}
              placeholder="Search workspace"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchResults[0]) openNav(searchResults[0]);
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
          )}
          <button
            aria-label="Search workspace"
            onClick={() => {
              setSearchOpen((open) => !open);
              setNotificationsOpen(false);
              setProfileOpen(false);
            }}
            type="button"
          >
            <Search size={19} />
          </button>
          {searchOpen && (
            <div className="notification-popover search-results-popover">
              <div>
                <strong>Open Workspace Area</strong>
                <small>{project ? project.path : "Select a project to scope project data"}</small>
              </div>
              {searchResults.map((target) => (
                <p key={target} onClick={() => openNav(target)}>
                  <span className="tiny-orb blue" />
                  {target}
                </p>
              ))}
              {searchResults.length === 0 && (
                <p>
                  <span className="tiny-orb amber" />
                  No matching area
                </p>
              )}
            </div>
          )}
        </div>
        <button className="icon-button desktop-only" aria-label="Refresh diagnostics" onClick={onRefreshDiagnostics}>
          <RefreshCw size={19} />
        </button>
        <div className="notification-wrap">
          <button
            className="icon-button"
            aria-label="Notifications"
            onClick={() => {
              setNotificationsOpen((open) => !open);
              setSearchOpen(false);
              setProfileOpen(false);
            }}
            type="button"
          >
            <Bell size={19} />
            {missingTools.length > 0 && <span className="notification-dot" />}
          </button>
          {notificationsOpen && (
            <div className="notification-popover">
              <div>
                <strong>Local Diagnostics</strong>
                <small>{diagnostics ? new Date(diagnostics.checkedAt).toLocaleString() : "Not scanned yet"}</small>
              </div>
              {diagnostics ? (
                missingTools.length > 0 ? (
                  missingTools.slice(0, 4).map((tool) => (
                    <p key={tool.id}>
                      <span className="tiny-orb amber" />
                      {tool.displayName}: {tool.detail}
                    </p>
                  ))
                ) : (
                  <p>
                    <span className="tiny-orb blue" />
                    All detected tools are ready.
                  </p>
                )
              ) : (
                <p>
                  <span className="tiny-orb amber" />
                  Diagnostics have not completed.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="profile-wrap">
          <button
            className="user-profile"
            aria-label="Open workspace profile"
            onClick={() => {
              setProfileOpen((open) => !open);
              setSearchOpen(false);
              setNotificationsOpen(false);
            }}
            type="button"
          >
            <span className="profile-photo">{initials}</span>
            <span className="profile-online" />
            <ChevronRight size={14} />
          </button>
          {profileOpen && (
            <div className="notification-popover profile-popover">
              <div>
                <strong>Local Workspace</strong>
                <small>{project ? project.path : "No project selected"}</small>
              </div>
              <p>
                <span className="tiny-orb blue" />
                {statusLabel}
              </p>
              <p>
                <span className="tiny-orb amber" />
                {missingTools.length} missing local tool{missingTools.length === 1 ? "" : "s"}
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function workspaceInitials(name?: string): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return "AG";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .padEnd(2, "X");
}
