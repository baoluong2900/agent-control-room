import { Bell, ChevronDown, ChevronRight, FileCode2, Layers, LogOut, RefreshCw, Search, Settings2 } from "lucide-react";
import type { AppIdentity, KnowledgeSearchResult, ProjectSummary, SystemDiagnostics } from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceNavKey } from "../workspace-navigation";
import {
  chooseEnterTarget,
  describeHit,
  matchNavigationAreas,
  sourceSearchMessage,
  summarizeSourceSearch,
} from "./topbar-search";

export function TopBar({
  diagnostics,
  identity,
  onNavigate,
  onOpenSourceFile,
  onSignOut,
  project,
  onRefreshDiagnostics,
  onSelectProject,
}: {
  diagnostics: SystemDiagnostics | null;
  identity: AppIdentity | null;
  onNavigate: (nav: WorkspaceNavKey) => void;
  /** Opens a source file from a search hit, in whichever module renders it. */
  onOpenSourceFile: (path: string) => void;
  onSignOut: () => Promise<void>;
  project: ProjectSummary | null;
  onRefreshDiagnostics: () => void;
  onSelectProject: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [sourceResult, setSourceResult] = useState<KnowledgeSearchResult | null>(null);
  // A request that resolves after the popover closes must not push state back in.
  const mounted = useRef(true);

  const installedCount = diagnostics?.tools.filter((tool) => tool.installed).length ?? 0;
  const total = diagnostics?.tools.length ?? 0;
  const missingTools = diagnostics?.tools.filter((tool) => !tool.installed) ?? [];
  const projectName = project?.name ?? "No Project Selected";
  const initials = workspaceInitials(identity?.displayName ?? project?.name);
  const toolsSummary = diagnostics ? `${installedCount}/${total} local tools detected` : "Scanning local tools";
  const statusLabel = diagnostics ? `${installedCount}/${total} Tools Ready` : "Diagnostics Pending";

  const searchResults = useMemo(() => matchNavigationAreas(search), [search]);
  const sourceState = useMemo(
    () => summarizeSourceSearch({ query: search, hasProject: Boolean(project), result: sourceResult }),
    [project, search, sourceResult],
  );
  const sourceMessage = sourceSearchMessage(sourceState);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Ranked source search reuses `knowledge:search`, the same scorer the Knowledge
  // module uses. Nothing is queried until the box is open and a project is picked,
  // so the top bar costs nothing while idle.
  useEffect(() => {
    const query = search.trim();
    if (!searchOpen || !project || !query) {
      setSourceResult(null);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      void window.agentic.knowledge
        .search({ projectPath: project.path, query, limit: 12 })
        .then((result) => {
          if (live && mounted.current) setSourceResult(result);
        })
        .catch(() => {
          if (live && mounted.current) setSourceResult(null);
        });
    }, 140);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project, search, searchOpen]);

  function closeSearch() {
    setSearch("");
    setSearchOpen(false);
    setSourceResult(null);
  }

  function openNav(target: WorkspaceNavKey) {
    onNavigate(target);
    closeSearch();
    setProfileOpen(false);
  }

  function openFile(path: string) {
    onOpenSourceFile(path);
    closeSearch();
    setProfileOpen(false);
  }

  function submitSearch() {
    const target = chooseEnterTarget(search, searchResults, sourceState);
    if (!target) return;
    if (target.kind === "area") openNav(target.key);
    else openFile(target.path);
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
      setProfileOpen(false);
    }
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
              placeholder="Search areas and source"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
                if (event.key === "Escape") closeSearch();
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
                <strong>Workspace Search</strong>
                <small>{project ? project.path : "Select a project to search source"}</small>
              </div>
              {searchResults.map((target) => (
                <p key={target.key} onClick={() => openNav(target.key)}>
                  <span className="tiny-orb blue" />
                  {target.label}
                </p>
              ))}
              {searchResults.length === 0 && (
                <p>
                  <span className="tiny-orb amber" />
                  No matching area
                </p>
              )}

              {sourceState.kind !== "idle" && (
                <div className="search-source-group">
                  <strong>Source</strong>
                  <small>
                    {sourceState.kind === "hits"
                      ? `${sourceState.hits.length} of ${sourceState.scanned} indexed files`
                      : "CodeGraph snapshot"}
                  </small>
                </div>
              )}
              {sourceMessage && (
                <p>
                  <span className="tiny-orb amber" />
                  {sourceMessage}
                </p>
              )}
              {sourceState.kind === "hits" &&
                sourceState.hits.map((hit) => (
                  <p className="search-source-hit" key={hit.path} onClick={() => openFile(hit.path)}>
                    <FileCode2 size={12} />
                    <span>
                      <strong>{hit.path}</strong>
                      <small>{describeHit(hit)}</small>
                    </span>
                  </p>
                ))}
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
                <strong>{identity?.displayName || "Local Workspace"}</strong>
                <small>{identity?.email || "No local account loaded"}</small>
              </div>
              <p>
                <span className="tiny-orb blue" />
                Signed in with {identity?.loginMethod ?? "local"}
              </p>
              <p>
                <span className="tiny-orb amber" />
                {project ? project.path : "No project selected"}
              </p>
              <button className="profile-menu-button" onClick={() => openNav("Settings")} type="button">
                <Settings2 size={13} />
                Account settings
              </button>
              <button className="profile-menu-button danger" onClick={() => void signOut()} disabled={signingOut} type="button">
                <LogOut size={13} />
                {signingOut ? "Signing out..." : "Sign out"}
              </button>
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
