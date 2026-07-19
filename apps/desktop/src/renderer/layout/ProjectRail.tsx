import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type CloudSessionCatalogEntry, isCloudSessionMutationLocked } from "../../shared/cloud";
import {
  chatSessions,
  filterChatSessions,
  filterProjects,
  isChatsCwd,
  limitProjectRailProjects,
  limitProjectRailSessions,
  normalizeCwd,
  normalizeProjectName,
  normalizeSessionTitle,
  PROJECT_NAME_LIMIT,
  partitionProjects,
  projectLabel,
  relativeSessionTime,
  SESSION_TITLE_LIMIT,
} from "../../shared/project-index";
import type { ProjectSessionSummary, ProjectSummary } from "../../shared/protocol";
import { BrandMark } from "../branding/BrandMark";
import {
  IconArchive,
  IconChevron,
  IconCloud,
  IconDelete,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconJobs,
  IconMore,
  IconPlus,
  IconRename,
  IconSearch,
  IconSettings,
  IconSidebar,
} from "../icons";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

type SessionMenu = {
  kind: "session";
  cwd: string;
  session: ProjectSessionSummary;
  x: number;
  y: number;
};

type ProjectMenu = {
  kind: "project";
  cwd: string;
  project: ProjectSummary;
  x: number;
  y: number;
};

type RailMenu = SessionMenu | ProjectMenu;

export function ProjectRail({
  projects,
  cloudSessions,
  chatsCwd,
  activeCwd,
  activeSessionId,
  open,
  closing = false,
  loading,
  error,
  busy,
  navigationDisabled,
  onClose,
  onRetry,
  onOpenProject,
  onNewChat,
  onNewProjectChat,
  onResume,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onRenameSession,
  onDeleteSession,
  onArchiveSession,
  onForkSession,
  onOpenSessions,
  sessionsActive,
  onOpenSettings,
  settingsActive,
}: {
  projects: ProjectSummary[];
  /** Catalog entries used for honest Cloud state and mutation ownership. */
  cloudSessions: Pick<CloudSessionCatalogEntry, "sessionId" | "sourceRoot" | "status">[];
  /** Absolute path of the one-off chats workspace (`~/.vibe/chats`). */
  chatsCwd: string | null;
  activeCwd: string | null;
  activeSessionId: string;
  open: boolean;
  closing?: boolean;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Host/bootstrap or ownership transition in progress. A running turn alone
   * does not disable navigation because its local runtime remains supervised. */
  navigationDisabled: boolean;
  onClose: () => void;
  onRetry: () => void;
  onOpenProject: () => void;
  /** Start a new one-off chat (not a code project). */
  onNewChat: () => void;
  /** Start a fresh session inside an existing code project. */
  onNewProjectChat: (cwd: string) => void;
  onResume: (cwd: string, id: string) => void;
  onRenameProject: (cwd: string, name: string) => Promise<boolean>;
  onArchiveProject: (cwd: string) => Promise<boolean>;
  onDeleteProject: (cwd: string) => Promise<boolean>;
  onRenameSession: (cwd: string, id: string, title: string) => Promise<boolean>;
  onDeleteSession: (cwd: string, id: string) => Promise<boolean>;
  onArchiveSession: (cwd: string, id: string) => Promise<boolean>;
  onForkSession: (cwd: string, id: string, atTurnId?: string) => Promise<boolean>;
  onOpenSessions: () => void;
  sessionsActive: boolean;
  onOpenSettings: () => void;
  settingsActive: boolean;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Section-level collapse (Projects list / Chats list). Search forces open. */
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [menu, setMenu] = useState<RailMenu | null>(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [renamingProject, setRenamingProject] = useState<{ cwd: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ cwd: string; id: string; title: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<"archive" | "delete" | null>(null);
  const [confirmProjectAction, setConfirmProjectAction] = useState<"archive" | "delete" | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [menuActionPending, setMenuActionPending] = useState(false);
  const renamePendingRef = useRef(false);
  const menuActionPendingRef = useRef(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const projectRenameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);

  const partitioned = useMemo(
    () => (chatsCwd ? partitionProjects(projects, chatsCwd) : { chats: null, projects }),
    [projects, chatsCwd],
  );
  const visibleProjects = useMemo(
    () => filterProjects(partitioned.projects, query),
    [partitioned.projects, query],
  );
  const visibleChats = useMemo(
    () => filterChatSessions(chatSessions(partitioned.chats), query),
    [partitioned.chats, query],
  );
  const chatsRoot = partitioned.chats?.cwd ?? chatsCwd;
  const inChats = Boolean(activeCwd && chatsCwd && isChatsCwd(activeCwd, chatsCwd));
  const mountedProjects = useMemo(
    () => limitProjectRailProjects(visibleProjects, activeCwd),
    [visibleProjects, activeCwd],
  );
  const mountedChats = useMemo(
    () => limitProjectRailSessions(visibleChats, inChats ? activeSessionId : null),
    [visibleChats, inChats, activeSessionId],
  );
  const searchIsOpen = searchOpen || query.length > 0;
  const runningCloudSessionIds = useMemo(
    () => new Set(cloudSessions.filter((entry) => entry.status === "running").map((entry) => entry.sessionId)),
    [cloudSessions],
  );
  const remoteOwnedCloudSessions = useMemo(
    () => cloudSessions.filter((entry) => isCloudSessionMutationLocked(entry.status)),
    [cloudSessions],
  );
  const remoteOwnedSessionIds = useMemo(
    () => new Set(remoteOwnedCloudSessions.map((entry) => entry.sessionId)),
    [remoteOwnedCloudSessions],
  );
  const remoteOwnedProjectCwds = useMemo(
    () => new Set(remoteOwnedCloudSessions.map((entry) => normalizeCwd(entry.sourceRoot))),
    [remoteOwnedCloudSessions],
  );
  // While filtering, keep both sections open so matches stay visible.
  const showProjectsBody = projectsOpen || query.length > 0;
  const showChatsBody = chatsOpen || query.length > 0;

  const closeMenu = useCallback((restoreFocus = false) => {
    if (menuActionPendingRef.current) return;
    if (!menu && !menuClosing) return;
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
    }
    setConfirmAction(null);
    setConfirmProjectAction(null);
    setMenuClosing(true);
    menuCloseTimerRef.current = window.setTimeout(() => {
      setMenu(null);
      setMenuClosing(false);
      menuCloseTimerRef.current = null;
      if (restoreFocus) {
        window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
      }
    }, 120);
  }, [menu, menuClosing]);

  useEffect(() => {
    if (!activeCwd) return;
    setExpanded((current) => new Set(current).add(activeCwd));
  }, [activeCwd]);

  useEffect(() => {
    if (!menu) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']");
    // Prefer keyboard focus without scrolling the rail under a pointer click.
    first?.focus({ preventScroll: true });
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      // Let the trigger's click handler toggle closed — don't race mousedown→close
      // against click→reopen (that flicker is what made ⋯ feel glitched).
      if (menuTriggerRef.current?.contains(target)) return;
      closeMenu();
    };
    // The session menu fully owns keyboard interaction while open. The keydown
    // listener lives on document (bubble phase) so it fires before App's
    // window-level Esc stack; stopPropagation then shields App from also
    // clearing the draft / denying a permission / aborting on the same Esc
    // press (I13/I58).
    const onKey = (event: KeyboardEvent) => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? [],
      );
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (items.length === 0) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        items[(current + direction + items.length) % items.length]?.focus({ preventScroll: true });
      } else if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        items[0]?.focus({ preventScroll: true });
      } else if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        items.at(-1)?.focus({ preventScroll: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (menuActionPendingRef.current) return;
        if (confirmAction || confirmProjectAction) {
          setConfirmAction(null);
          setConfirmProjectAction(null);
          return;
        }
        closeMenu(true);
      }
    };
    window.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [closeMenu, menu, confirmAction, confirmProjectAction]);

  useEffect(() => {
    return () => {
      if (menuCloseTimerRef.current !== null) {
        window.clearTimeout(menuCloseTimerRef.current);
      }
    };
  }, []);

  // Clamp after paint so real menu size wins over a fixed estimate.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.min(Math.max(pad, menu.x), Math.max(pad, window.innerWidth - rect.width - pad));
    const y = Math.min(Math.max(pad, menu.y), Math.max(pad, window.innerHeight - rect.height - pad));
    if (Math.abs(x - menu.x) > 0.5 || Math.abs(y - menu.y) > 0.5) {
      setMenu((current) => (current ? { ...current, x, y } : null));
    }
  }, [menu, confirmAction, confirmProjectAction]);

  useEffect(() => {
    if (!renamingProject) return;
    projectRenameRef.current?.focus();
    projectRenameRef.current?.select();
  }, [renamingProject]);

  useEffect(() => {
    if (!renaming) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renaming]);

  const toggleProject = (cwd: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  /** Anchor to the trigger so the menu isn't born under the cursor (avoids the
   *  click/double-click landing on Rename). Flip above when near the bottom. */
  const menuPositionFor = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const estimatedWidth = 176;
    const estimatedHeight = 120;
    const gap = 4;
    const pad = 8;
    const openBelow = rect.bottom + gap + estimatedHeight <= window.innerHeight - pad;
    return {
      x: Math.max(pad, rect.right - estimatedWidth),
      y: openBelow ? rect.bottom + gap : Math.max(pad, rect.top - estimatedHeight - gap),
    };
  };

  const beginMenuOpen = (trigger: HTMLButtonElement) => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
    setMenuClosing(false);
    setConfirmAction(null);
    setConfirmProjectAction(null);
    menuTriggerRef.current = trigger;
  };

  const openMenu = (
    event: React.MouseEvent,
    cwd: string,
    session: ProjectSessionSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (remoteOwnedSessionIds.has(session.id)) return;
    const trigger = event.currentTarget as HTMLButtonElement;
    if (menu?.kind === "session" && menu.session.id === session.id && !menuClosing) {
      closeMenu(true);
      return;
    }
    beginMenuOpen(trigger);
    // Right-click stays at the pointer; the ⋯ control anchors to itself.
    const pos =
      event.type === "contextmenu"
        ? { x: event.clientX, y: event.clientY }
        : menuPositionFor(trigger);
    setMenu({ kind: "session", cwd, session, ...pos });
  };

  const openProjectMenu = (event: React.MouseEvent, project: ProjectSummary) => {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLButtonElement;
    if (menu?.kind === "project" && menu.cwd === project.cwd && !menuClosing) {
      closeMenu(true);
      return;
    }
    beginMenuOpen(trigger);
    const { x, y } = menuPositionFor(trigger);
    setMenu({ kind: "project", cwd: project.cwd, project, x, y });
  };

  const commitRename = async () => {
    if (!renaming || renamePendingRef.current || remoteOwnedSessionIds.has(renaming.id)) return;
    const title = normalizeSessionTitle(renaming.title);
    const { cwd, id } = renaming;
    if (!title) {
      setRenaming(null);
      return;
    }
    renamePendingRef.current = true;
    setRenamePending(true);
    let ok = false;
    try {
      ok = await onRenameSession(cwd, id, title);
    } finally {
      renamePendingRef.current = false;
      setRenamePending(false);
    }
    if (ok) {
      setRenaming(null);
    } else {
      window.requestAnimationFrame(() => renameRef.current?.focus());
    }
  };

  const commitProjectRename = async () => {
    if (!renamingProject || renamePendingRef.current) return;
    const name = normalizeProjectName(renamingProject.name);
    const { cwd } = renamingProject;
    if (!name) {
      setRenamingProject(null);
      return;
    }
    renamePendingRef.current = true;
    setRenamePending(true);
    let ok = false;
    try {
      ok = await onRenameProject(cwd, name);
    } finally {
      renamePendingRef.current = false;
      setRenamePending(false);
    }
    if (ok) {
      setRenamingProject(null);
    } else {
      window.requestAnimationFrame(() => projectRenameRef.current?.focus());
    }
  };

  const runProjectAction = async (cwd: string, mode: "archive" | "delete") => {
    if (menuActionPendingRef.current || remoteOwnedProjectCwds.has(normalizeCwd(cwd))) return;
    menuActionPendingRef.current = true;
    setMenuActionPending(true);
    let ok = false;
    try {
      ok = mode === "delete" ? await onDeleteProject(cwd) : await onArchiveProject(cwd);
    } finally {
      menuActionPendingRef.current = false;
      setMenuActionPending(false);
    }
    if (ok) {
      setMenu(null);
      setConfirmProjectAction(null);
    }
  };

  const runSessionAction = async (
    cwd: string,
    id: string,
    mode: "archive" | "delete",
  ) => {
    if (menuActionPendingRef.current || remoteOwnedSessionIds.has(id)) return;
    menuActionPendingRef.current = true;
    setMenuActionPending(true);
    let ok = false;
    try {
      ok = mode === "delete" ? await onDeleteSession(cwd, id) : await onArchiveSession(cwd, id);
    } finally {
      menuActionPendingRef.current = false;
      setMenuActionPending(false);
    }
    if (ok) {
      setMenu(null);
      setConfirmAction(null);
    }
  };

  const runForkAction = async (cwd: string, id: string, atTurnId?: string) => {
    if (menuActionPendingRef.current) return;
    menuActionPendingRef.current = true;
    setMenuActionPending(true);
    try {
      if (await onForkSession(cwd, id, atTurnId)) setMenu(null);
    } finally {
      menuActionPendingRef.current = false;
      setMenuActionPending(false);
    }
  };

  const busyTitle = "Session actions are unavailable while the foreground turn is running";
  const navigationTitle = "A session transition is already in progress";

  return (
    <aside
      id="project-rail"
      className={`project-rail${open ? " is-open" : ""}${closing ? " is-closing" : ""}`}
      aria-label="Projects and sessions"
      aria-hidden={!open}
      inert={closing}
    >
      <div className="rail-chrome">
        <button type="button" className="icon-button rail-chrome-toggle no-drag" onClick={onClose} aria-label="Hide project rail">
          <IconSidebar size={14} />
        </button>
      </div>

      <div className="rail-title-row">
        <h1 className="rail-product-name">
          <BrandMark />
        </h1>
        <button
          ref={searchTriggerRef}
          type="button"
          className={`icon-button rail-search-toggle${searchIsOpen ? " active" : ""}`}
          onClick={() => {
            if (searchIsOpen) {
              setSearchOpen(false);
              setQuery("");
              searchTriggerRef.current?.focus();
              return;
            }
            setSearchOpen(true);
            window.requestAnimationFrame(() => filterRef.current?.focus());
          }}
          aria-label={searchIsOpen ? "Close project search" : "Search projects"}
          aria-expanded={searchIsOpen}
          aria-controls="project-filter"
          title={searchIsOpen ? "Close project search" : "Search projects"}
        >
          <IconSearch size={14} />
        </button>
      </div>

      <nav className="rail-primary-nav" aria-label="Workspaces">
        <button
          type="button"
          className={`rail-primary-row${sessionsActive ? " active" : ""}`}
          onClick={onOpenSessions}
          aria-pressed={sessionsActive}
        >
          <IconJobs size={14} />
          <span>Sessions</span>
          <span className="rail-primary-count">
            {projects.reduce((total, project) => total + project.sessions.length, 0)}
          </span>
        </button>
      </nav>

      <label id="project-filter" className={`rail-filter${searchIsOpen ? " is-open" : ""}`}>
        <span className="sr-only">Filter chats and projects</span>
        <IconSearch size={14} />
        <input
          ref={filterRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery("");
              else {
                setSearchOpen(false);
                window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
              }
            }
          }}
          placeholder="Search chats & projects"
          type="search"
        />
      </label>

      <div className="project-list" aria-busy={loading}>
        {loading && projects.length === 0 && <div className="rail-state">Loading…</div>}
        {loading && projects.length > 0 && <div className="rail-refresh" role="status">Refreshing…</div>}
        {error && (
          <div className="rail-state error" role="status">
            <span>{error}</span>
            <button type="button" className="rail-retry" onClick={onRetry}>Retry</button>
          </div>
        )}

        {/* ── Projects ─────────────────────────────────────────────────── */}
        <div className="rail-section-head">
          <button
            type="button"
            className="rail-section-toggle"
            id="rail-projects-heading"
            aria-expanded={showProjectsBody}
            aria-controls="rail-projects-body"
            onClick={() => setProjectsOpen((v) => !v)}
          >
            <IconChevron open={showProjectsBody} size={14} />
            <span className="rail-section-label">Projects</span>
          </button>
          <button
            type="button"
            className="rail-section-add"
            onClick={(event) => {
              event.stopPropagation();
              onOpenProject();
            }}
            disabled={navigationDisabled}
            title={navigationDisabled ? navigationTitle : "Add project"}
            aria-label="Add project"
          >
            <IconPlus size={14} />
          </button>
        </div>
        {showProjectsBody && (
        <div className="rail-section-body" id="rail-projects-body" aria-labelledby="rail-projects-heading">
        {!loading && !error && visibleProjects.length === 0 && (
          <div className="rail-state rail-state-quiet">
            {query ? "No matching projects." : "Add a folder to start."}
          </div>
        )}
        {mountedProjects.items.map((project) => {
          const isExpanded = query.length > 0 || expanded.has(project.cwd);
          const isActiveProject = project.cwd === activeCwd;
          const mountedSessions = limitProjectRailSessions(
            project.sessions,
            isActiveProject ? activeSessionId : null,
          );
          return (
            <section className="project-group" key={project.cwd}>
              {renamingProject?.cwd === project.cwd ? (
                <form
                  className="project-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void commitProjectRename();
                  }}
                >
                  <input
                    ref={projectRenameRef}
                    className="project-rename-input"
                    value={renamingProject.name}
                    maxLength={PROJECT_NAME_LIMIT}
                    disabled={renamePending}
                    onChange={(event) => setRenamingProject({ ...renamingProject, name: event.target.value })}
                    onBlur={() => { void commitProjectRename(); }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        if (renamePendingRef.current) return;
                        setRenamingProject(null);
                      }
                    }}
                    aria-label="Rename project"
                  />
                </form>
              ) : (
                <div className="project-heading-row">
                  <button
                    type="button"
                    className={`project-heading${isActiveProject ? " active" : ""}`}
                    onClick={() => toggleProject(project.cwd)}
                    aria-expanded={isExpanded}
                    aria-controls={`project-sessions-${project.cwd.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} sessions for ${projectLabel(project, projects)}`}
                    title={`${project.cwd} · ${isExpanded ? "collapse" : "expand"} sessions`}
                  >
                    <span className="project-folder" aria-hidden>
                      {isExpanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
                    </span>
                    <span className="project-name">{projectLabel(project, projects)}</span>
                    <span className="project-heading-meta">
                      <IconChevron open={isExpanded} size={14} />
                    </span>
                  </button>
                  <div className="project-row-actions">
                    <button
                      type="button"
                      className="project-more"
                      aria-label={`Actions for project ${projectLabel(project, projects)}`}
                      aria-haspopup="menu"
                      aria-expanded={
                        menu?.kind === "project" && menu.cwd === project.cwd && !menuClosing
                      }
                      title="Project actions"
                      onClick={(event) => openProjectMenu(event, project)}
                    >
                      <IconMore size={14} />
                    </button>
                    <button
                      type="button"
                      className="project-new-chat"
                      onClick={() => onNewProjectChat(project.cwd)}
                      disabled={navigationDisabled}
                      title={navigationDisabled ? navigationTitle : `New chat in ${projectLabel(project, projects)}`}
                      aria-label={`New chat in ${projectLabel(project, projects)}`}
                    >
                      <IconPlus size={14} />
                    </button>
                  </div>
                </div>
              )}
              {isExpanded && (
                <div
                  className="session-list"
                  id={`project-sessions-${project.cwd.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
                  role="group"
                  aria-label={`Sessions in ${projectLabel(project, projects)}`}
                >
                  {project.sessions.length === 0 && <div className="session-empty">No saved sessions.</div>}
                  {mountedSessions.items.map((session) => {
                    const isRenaming = renaming?.cwd === project.cwd && renaming.id === session.id;
                    const isActive = session.id === activeSessionId;
                    const isRunningInCloud = runningCloudSessionIds.has(session.id);
                    const isRemoteOwned = remoteOwnedSessionIds.has(session.id);
                    return (
                      <div
                        key={session.id}
                        className={`session-row-wrap${isActive ? " active" : ""}`}
                      >
                        {isRenaming ? (
                          <form
                            className="session-rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void commitRename();
                            }}
                          >
                            <input
                              ref={renameRef}
                              className="session-rename-input"
                              value={renaming.title}
                              maxLength={SESSION_TITLE_LIMIT}
                              disabled={renamePending}
                              onChange={(event) =>
                                setRenaming({ ...renaming, title: event.target.value })
                              }
                              onBlur={() => { void commitRename(); }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  if (renamePendingRef.current) return;
                                  setRenaming(null);
                                }
                              }}
                              aria-label="Rename session"
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            className={`session-row${isActive ? " active" : ""}`}
                            onClick={() => onResume(project.cwd, session.id)}
                            onContextMenu={(event) => openMenu(event, project.cwd, session)}
                            disabled={navigationDisabled}
                            aria-current={isActive ? "true" : undefined}
                            aria-label={
                              isActive && busy
                                ? `${session.title}. AI is working in this session; switching keeps it running.${isRunningInCloud ? " Running in Cloud." : ""}`
                                : isRunningInCloud ? `${session.title}. Running in Cloud.` : undefined
                            }
                            title={navigationDisabled ? navigationTitle : `${session.title}\n${session.model}${isRunningInCloud ? "\nRunning in Cloud" : ""}`}
                          >
                            <span className="session-title">{session.title}</span>
                            <time
                              className="session-time"
                              dateTime={new Date(session.updatedAt).toISOString()}
                            >
                              {relativeSessionTime(session.updatedAt)}
                            </time>
                            {isRunningInCloud ? (
                              <span className="session-cloud-indicator" aria-hidden="true">
                                <IconCloud size={12} />
                              </span>
                            ) : null}
                            {isActive && busy ? (
                              <span
                                className="session-status-indicator is-busy"
                                aria-hidden="true"
                              />
                            ) : null}
                          </button>
                        )}
                        {!isRenaming && (
                          <button
                            type="button"
                            className="session-more"
                            aria-label={
                              busy
                                ? `Session actions for ${session.title}. ${busyTitle}`
                                : `Session actions for ${session.title}`
                            }
                            aria-haspopup="menu"
                            aria-expanded={
                              menu?.kind === "session" &&
                              menu.session.id === session.id &&
                              !menuClosing
                            }
                            disabled={busy || isRemoteOwned}
                            title={isRemoteOwned ? "Return this session to Local to manage it" : busy ? busyTitle : undefined}
                            onClick={(event) => openMenu(event, project.cwd, session)}
                          >
                            <IconMore size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {mountedSessions.omitted > 0 && (
                    <div className="rail-state rail-state-quiet">
                      {mountedSessions.omitted} older session{mountedSessions.omitted === 1 ? "" : "s"} not mounted. Search to narrow the list.
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {mountedProjects.omitted > 0 && (
          <div className="rail-state rail-state-quiet">
            {mountedProjects.omitted} older project{mountedProjects.omitted === 1 ? "" : "s"} not mounted. Search to narrow the list.
          </div>
        )}
        </div>
        )}

        {/* ── Chats (one-off, under projects) ──────────────────────────── */}
        <div className="rail-section-head">
          <button
            type="button"
            className="rail-section-toggle"
            id="rail-chats-heading"
            aria-expanded={showChatsBody}
            aria-controls="rail-chats-body"
            onClick={() => setChatsOpen((v) => !v)}
          >
            <IconChevron open={showChatsBody} size={14} />
            <span className="rail-section-label">Chats</span>
          </button>
          <button
            type="button"
            className="rail-section-add"
            onClick={(event) => {
              event.stopPropagation();
              onNewChat();
            }}
            disabled={navigationDisabled}
            title={navigationDisabled ? navigationTitle : "New chat"}
            aria-label="New chat"
          >
            <IconPlus size={14} />
          </button>
        </div>
        {showChatsBody && (
        <div className="rail-section-body" id="rail-chats-body" aria-labelledby="rail-chats-heading">
          {!loading && !error && visibleChats.length === 0 && (
            <div className="rail-state rail-state-quiet">
              {query ? "No matching chats." : "No chats yet."}
            </div>
          )}
          {visibleChats.length > 0 && chatsRoot && (
            <div className="session-list is-flat" role="group" aria-label="Chats">
              {mountedChats.items.map((session) => {
                const isRenaming = renaming?.cwd === chatsRoot && renaming.id === session.id;
                const isActive = inChats && session.id === activeSessionId;
                const isRunningInCloud = runningCloudSessionIds.has(session.id);
                const isRemoteOwned = remoteOwnedSessionIds.has(session.id);
                return (
                  <div
                    key={session.id}
                    className={`session-row-wrap${isActive ? " active" : ""}`}
                  >
                    {isRenaming ? (
                      <form
                        className="session-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void commitRename();
                        }}
                      >
                        <input
                          ref={renameRef}
                          className="session-rename-input"
                          value={renaming.title}
                          maxLength={SESSION_TITLE_LIMIT}
                          disabled={renamePending}
                          onChange={(event) =>
                            setRenaming({ ...renaming, title: event.target.value })
                          }
                          onBlur={() => { void commitRename(); }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              if (renamePendingRef.current) return;
                              setRenaming(null);
                            }
                          }}
                          aria-label="Rename chat"
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="session-row session-row-flat"
                        disabled={navigationDisabled}
                        onClick={() => onResume(chatsRoot, session.id)}
                        aria-current={isActive ? "true" : undefined}
                        aria-label={
                          isActive && busy
                            ? `${session.title}. AI is working in this session; switching keeps it running.${isRunningInCloud ? " Running in Cloud." : ""}`
                            : `${session.title}${isRunningInCloud ? ". Running in Cloud." : ""}`
                        }
                        title={navigationDisabled ? navigationTitle : `${session.title}\n${session.model}${isRunningInCloud ? "\nRunning in Cloud" : ""}`}
                      >
                        <span className="session-title">{session.title}</span>
                        <time className="session-time" dateTime={new Date(session.updatedAt).toISOString()}>
                          {relativeSessionTime(session.updatedAt)}
                        </time>
                        {isRunningInCloud ? (
                          <span className="session-cloud-indicator" aria-hidden="true">
                            <IconCloud size={12} />
                          </span>
                        ) : null}
                        {isActive && busy ? (
                          <span className="session-status-indicator is-busy" aria-hidden="true" />
                        ) : null}
                      </button>
                    )}
                    {!isRenaming && (
                      <button
                        type="button"
                        className="session-more"
                        aria-label={
                          busy
                            ? `Chat actions for ${session.title}. ${busyTitle}`
                            : `Chat actions for ${session.title}`
                        }
                        aria-haspopup="menu"
                        aria-expanded={
                          menu?.kind === "session" &&
                          menu.session.id === session.id &&
                          !menuClosing
                        }
                        disabled={busy || isRemoteOwned}
                        title={isRemoteOwned ? "Return this session to Local to manage it" : busy ? busyTitle : undefined}
                        onClick={(event) => openMenu(event, chatsRoot, session)}
                      >
                        <IconMore size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
              {mountedChats.omitted > 0 && (
                <div className="rail-state rail-state-quiet">
                  {mountedChats.omitted} older chat{mountedChats.omitted === 1 ? "" : "s"} not mounted. Search to narrow the list.
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      <div className="rail-footer" aria-label="App panels">
        <button
          type="button"
          className={`rail-footer-btn${settingsActive ? " active" : ""}`}
          onClick={onOpenSettings}
          aria-pressed={settingsActive}
          title="Settings"
        >
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>

      {open && (
        <SidebarResizeHandle
          side="start"
          cssVar="--project-rail-w"
          defaultWidth={288}
          min={240}
          max={420}
          storageKey="vibe.project-rail-width"
          label="Resize project sidebar"
        />
      )}

      {menu && createPortal(
        <div
          ref={menuRef}
          className={`session-menu${menuClosing ? " is-closing" : ""}${
            (menu.kind === "project" ? confirmProjectAction : confirmAction) ? " is-confirm" : ""
          }`}
          style={{ left: menu.x, top: menu.y }}
          role={menu.kind === "project" ? (confirmProjectAction ? "alertdialog" : "menu") : (confirmAction ? "alertdialog" : "menu")}
          aria-label={
            menu.kind === "project"
              ? confirmProjectAction
                ? `${confirmProjectAction === "delete" ? "Delete" : "Archive"} ${projectLabel(menu.project, projects)}`
                : `Actions for ${projectLabel(menu.project, projects)}`
              : confirmAction
                ? `${confirmAction === "delete" ? "Delete" : "Archive"} ${menu.session.title}`
                : `Actions for ${menu.session.title}`
          }
        >
          {menu.kind === "project" ? (
            confirmProjectAction ? (
              <div className="session-menu-confirm">
                <p className="session-menu-confirm-msg">
                  <span className="session-menu-confirm-title">
                    {confirmProjectAction === "delete"
                      ? `Delete ${projectLabel(menu.project, projects)}?`
                      : `Archive ${projectLabel(menu.project, projects)}?`}
                  </span>
                  <span className="session-menu-confirm-detail">
                    {confirmProjectAction === "delete"
                      ? "Removes it from project history and deletes its saved sessions."
                      : "Leaves the project list but remains on disk."}
                  </span>
                </p>
                <div className="session-menu-confirm-actions">
                  <button
                    type="button"
                    className="session-menu-confirm-cancel"
                    // biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter cancels, not confirms
                    autoFocus
                    disabled={menuActionPending}
                    onClick={() => setConfirmProjectAction(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`session-menu-confirm-go${confirmProjectAction === "delete" ? " danger" : ""}`}
                    disabled={menuActionPending || remoteOwnedProjectCwds.has(normalizeCwd(menu.cwd))}
                    onClick={() => {
                      const { cwd } = menu;
                      const mode = confirmProjectAction;
                      void runProjectAction(cwd, mode);
                    }}
                  >
                    {menuActionPending
                      ? confirmProjectAction === "delete" ? "Deleting…" : "Archiving…"
                      : confirmProjectAction === "delete" ? "Delete" : "Archive"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRenamingProject({ cwd: menu.cwd, name: menu.project.name });
                    setMenu(null);
                  }}
                >
                  <IconRename size={14} />
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={remoteOwnedProjectCwds.has(normalizeCwd(menu.cwd))}
                  title={remoteOwnedProjectCwds.has(normalizeCwd(menu.cwd)) ? "Return this project’s Cloud sessions to Local first" : undefined}
                  onClick={() => setConfirmProjectAction("archive")}
                >
                  <IconArchive size={14} />
                  Archive
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  disabled={remoteOwnedProjectCwds.has(normalizeCwd(menu.cwd))}
                  title={remoteOwnedProjectCwds.has(normalizeCwd(menu.cwd)) ? "Return this project’s Cloud sessions to Local first" : undefined}
                  onClick={() => setConfirmProjectAction("delete")}
                >
                  <IconDelete size={14} />
                  Delete
                </button>
              </>
            )
          ) : confirmAction ? (
            <div className="session-menu-confirm">
              <p className="session-menu-confirm-msg">
                <span className="session-menu-confirm-title">
                  {confirmAction === "delete"
                    ? `Delete “${menu.session.title}”?`
                    : `Archive “${menu.session.title}”?`}
                </span>
                <span className="session-menu-confirm-detail">
                  {confirmAction === "delete"
                    ? "This cannot be undone."
                    : "Leaves this project’s session list."}
                </span>
              </p>
              <div className="session-menu-confirm-actions">
                <button
                  type="button"
                  className="session-menu-confirm-cancel"
                  // biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter cancels, not confirms
                  autoFocus
                  disabled={menuActionPending}
                  onClick={() => setConfirmAction(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`session-menu-confirm-go${confirmAction === "delete" ? " danger" : ""}`}
                  disabled={menuActionPending || remoteOwnedSessionIds.has(menu.session.id)}
                  onClick={() => {
                    const { cwd, session } = menu;
                    const mode = confirmAction;
                    void runSessionAction(cwd, session.id, mode);
                  }}
                >
                  {menuActionPending
                    ? confirmAction === "delete" ? "Deleting…" : "Archiving…"
                    : confirmAction === "delete" ? "Delete" : "Archive"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={menuActionPending || remoteOwnedSessionIds.has(menu.session.id)}
                title={remoteOwnedSessionIds.has(menu.session.id)
                  ? "Return this session to Local before forking it"
                  : undefined}
                onClick={() => void runForkAction(menu.cwd, menu.session.id, menu.session.latestTurnId)}
              >
                <IconGitBranch size={14} />
                Fork here
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={remoteOwnedSessionIds.has(menu.session.id)}
                onClick={() => {
                  setRenaming({ cwd: menu.cwd, id: menu.session.id, title: menu.session.title });
                  setMenu(null);
                }}
              >
                <IconRename size={14} />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={remoteOwnedSessionIds.has(menu.session.id)}
                onClick={() => setConfirmAction("archive")}
              >
                <IconArchive size={14} />
                Archive
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={remoteOwnedSessionIds.has(menu.session.id)}
                onClick={() => setConfirmAction("delete")}
              >
                <IconDelete size={14} />
                Delete
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </aside>
  );
}
