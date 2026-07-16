import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft as IconBack,
  CheckCircle2 as IconCheckCircle,
  CircleDot as IconReview,
  Columns3 as IconBoard,
  List as IconList,
  MessagesSquare as IconSessions,
  SlidersHorizontal as IconFilter,
} from "lucide-react";
import type { CloudSessionCatalogEntry } from "../../shared/cloud";
import { normalizeSessionTitle, relativeSessionTime, SESSION_TITLE_LIMIT } from "../../shared/project-index";
import type { ProjectSummary } from "../../shared/protocol";
import {
  DEFAULT_SESSION_BOARD_PREFERENCES,
  filterSessionBoard,
  flattenSessionBoard,
  readSessionBoardPreferences,
  sessionBoardKey,
  type SessionBoardItem,
  type SessionBoardPreferences,
  type SessionBoardStatus,
  writeSessionBoardPreferences,
} from "../../shared/session-board";
import {
  IconArchive,
  IconDelete,
  IconMore,
  IconPlus,
  IconRename,
  IconSearch,
} from "../icons";

const STATUS_ORDER: SessionBoardStatus[] = ["active", "review", "done"];
const STATUS_COPY: Record<SessionBoardStatus, { label: string; description: string }> = {
  active: { label: "Active", description: "Work in progress" },
  review: { label: "Review", description: "Ready for your attention" },
  done: { label: "Done", description: "Finished sessions" },
};

function loadPreferences(): SessionBoardPreferences {
  try {
    return readSessionBoardPreferences(window.localStorage);
  } catch {
    return DEFAULT_SESSION_BOARD_PREFERENCES;
  }
}

function StatusIcon({ status }: { status: SessionBoardStatus }) {
  if (status === "review") return <IconReview size={14} strokeWidth={1.5} aria-hidden />;
  if (status === "done") return <IconCheckCircle size={14} strokeWidth={1.5} aria-hidden />;
  return <IconSessions size={14} strokeWidth={1.5} aria-hidden />;
}

function SessionStatusSelect({
  item,
  status,
  disabled,
  onChange,
}: {
  item: SessionBoardItem;
  status: SessionBoardStatus;
  disabled: boolean;
  onChange: (status: SessionBoardStatus) => void;
}) {
  return (
    <label className="session-board-status-control">
      <span className="sr-only">Status for {item.session.title}</span>
      <StatusIcon status={status} />
      <select
        value={status}
        disabled={disabled}
        aria-label={`Status for ${item.session.title}`}
        onChange={(event) => onChange(event.target.value as SessionBoardStatus)}
      >
        {STATUS_ORDER.map((value) => (
          <option key={value} value={value}>{STATUS_COPY[value].label}</option>
        ))}
      </select>
    </label>
  );
}

function SessionActions({
  item,
  disabled,
  onRename,
  onArchive,
  onDelete,
}: {
  item: SessionBoardItem;
  disabled: boolean;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      event.preventDefault();
      detailsRef.current.open = false;
      summaryRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const choose = (action: () => void) => {
    if (detailsRef.current) detailsRef.current.open = false;
    action();
  };
  return (
    <details ref={detailsRef} className="session-board-actions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        ref={summaryRef}
        role="button"
        aria-label={`Actions for ${item.session.title}`}
        title="Session actions"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <IconMore size={14} />
      </summary>
      <div className="session-board-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => choose(onRename)}>
          <IconRename size={14} /> Rename
        </button>
        <button type="button" role="menuitem" onClick={() => choose(onArchive)}>
          <IconArchive size={14} /> Archive
        </button>
        <button type="button" role="menuitem" className="danger" onClick={() => choose(onDelete)}>
          <IconDelete size={14} /> Delete
        </button>
      </div>
    </details>
  );
}

function SessionIdentity({
  item,
  editing,
  renamePending,
  onOpen,
  onCommitRename,
  onCancelRename,
}: {
  item: SessionBoardItem;
  editing: boolean;
  renamePending: boolean;
  onOpen: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
}) {
  const [title, setTitle] = useState(item.session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(item.session.title), [item.session.title]);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <form
        className="session-board-rename"
        onSubmit={(event) => {
          event.preventDefault();
          const clean = normalizeSessionTitle(title);
          if (clean) onCommitRename(clean);
        }}
      >
        <input
          ref={inputRef}
          value={title}
          maxLength={SESSION_TITLE_LIMIT}
          disabled={renamePending}
          aria-label="Rename session"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename();
            }
          }}
        />
        <button type="submit" disabled={renamePending || !title.trim()}>Save</button>
        <button type="button" disabled={renamePending} onClick={onCancelRename}>Cancel</button>
      </form>
    );
  }

  return (
    <button type="button" className="session-board-open" onClick={onOpen}>
      <span className="session-board-project">{item.project}</span>
      <span className="session-board-title">{item.session.title}</span>
    </button>
  );
}

function ConfirmSessionAction({
  item,
  mode,
  pending,
  onCancel,
  onConfirm,
}: {
  item: SessionBoardItem;
  mode: "archive" | "delete";
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  const verb = mode === "delete" ? "Delete" : "Archive";
  return (
    <dialog
      ref={dialogRef}
      className="session-board-confirm"
      aria-labelledby="session-board-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <div className="session-board-confirm-copy">
        <h2 id="session-board-confirm-title">{verb} “{item.session.title}”?</h2>
        <p>
          {mode === "delete"
            ? "This permanently removes the saved session and cannot be undone."
            : "This removes the session from your active history while keeping its project on disk."}
        </p>
      </div>
      <div className="session-board-confirm-actions">
        <button
          type="button"
          // biome-ignore lint/a11y/noAutofocus: destructive dialogs focus the safe action
          autoFocus
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="button" className={mode === "delete" ? "danger" : ""} disabled={pending} onClick={onConfirm}>
          {pending ? `${verb.slice(0, -1)}ing…` : verb}
        </button>
      </div>
    </dialog>
  );
}

export function SessionsWorkspace({
  projects,
  cloudSessions,
  chatsCwd,
  activeCwd,
  activeSessionId,
  busy,
  loading,
  error,
  onRetry,
  onOpen,
  onNewChat,
  onRename,
  onArchive,
  onDelete,
  onClose,
}: {
  projects: ProjectSummary[];
  cloudSessions: Pick<CloudSessionCatalogEntry, "sessionId" | "status">[];
  chatsCwd: string | null;
  activeCwd: string | null;
  activeSessionId: string;
  busy: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (cwd: string, id: string) => void;
  onNewChat: () => void;
  onRename: (cwd: string, id: string, title: string) => Promise<boolean>;
  onArchive: (cwd: string, id: string) => Promise<boolean>;
  onDelete: (cwd: string, id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [confirming, setConfirming] = useState<{ item: SessionBoardItem; mode: "archive" | "delete" } | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    try {
      writeSessionBoardPreferences(window.localStorage, preferences);
    } catch {
      /* Preferences are optional when storage is unavailable. */
    }
  }, [preferences]);

  const items = useMemo(
    () => flattenSessionBoard(projects, chatsCwd, preferences.statuses),
    [projects, chatsCwd, preferences.statuses],
  );
  const cloudRunning = useMemo(
    () => new Set(cloudSessions.filter((entry) => entry.status === "running").map((entry) => entry.sessionId)),
    [cloudSessions],
  );
  const workingKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      if (cloudRunning.has(item.session.id)) keys.add(item.key);
    }
    if (busy && activeCwd && activeSessionId) keys.add(sessionBoardKey(activeCwd, activeSessionId));
    return keys;
  }, [activeCwd, activeSessionId, busy, cloudRunning, items]);
  const visibleItems = useMemo(
    () => filterSessionBoard(items, {
      query,
      status: preferences.status,
      project: preferences.project,
      mode: preferences.mode,
      sort: preferences.sort,
      workingKeys,
    }),
    [items, preferences.mode, preferences.project, preferences.sort, preferences.status, query, workingKeys],
  );
  const projectsForFilter = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) seen.set(item.cwd, item.project);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const activeFilterCount = Number(preferences.status !== "all")
    + Number(preferences.project !== "all")
    + Number(preferences.mode !== "all")
    + Number(preferences.sort !== "updated");

  const updateStatus = (item: SessionBoardItem, status: SessionBoardStatus) => {
    setPreferences((current) => ({
      ...current,
      statuses: { ...current.statuses, [item.key]: status },
    }));
  };

  const commitRename = async (item: SessionBoardItem, title: string) => {
    if (renamePending) return;
    setRenamePending(true);
    try {
      if (await onRename(item.cwd, item.session.id, title)) setEditingKey(null);
    } finally {
      setRenamePending(false);
    }
  };

  const runDestructiveAction = async (item: SessionBoardItem, mode: "archive" | "delete") => {
    if (actionPending) return;
    setActionPending(true);
    const ok = mode === "delete"
      ? await onDelete(item.cwd, item.session.id)
      : await onArchive(item.cwd, item.session.id);
    setActionPending(false);
    if (ok) {
      setPreferences((current) => {
        const statuses = { ...current.statuses };
        delete statuses[item.key];
        return { ...current, statuses };
      });
      setConfirming(null);
    }
  };

  const renderSession = (item: SessionBoardItem, surface: "card" | "row") => {
    const working = workingKeys.has(item.key);
    const cloudWorking = cloudRunning.has(item.session.id);
    const effectiveStatus = working ? "active" : item.status;
    const active = item.cwd === activeCwd && item.session.id === activeSessionId;
    return (
      <article
        key={item.key}
        className={`session-board-${surface}${active ? " is-current" : ""}${working ? " is-working" : ""}`}
        data-status={effectiveStatus}
      >
        <div className="session-board-identity">
          <SessionIdentity
            item={item}
            editing={editingKey === item.key}
            renamePending={renamePending}
            onOpen={() => onOpen(item.cwd, item.session.id)}
            onCommitRename={(title) => void commitRename(item, title)}
            onCancelRename={() => setEditingKey(null)}
          />
        </div>
        <div className="session-board-meta">
          {working ? <span className="session-board-live"><span aria-hidden />{cloudWorking ? "Cloud working" : "Working"}</span> : null}
          {active && !working ? <span>Open</span> : null}
          <span>{item.isChat ? "Chat" : item.session.mode === "plan" ? "Plan" : "Execute"}</span>
          <span className="session-board-model" title={item.session.model}>{item.session.model}</span>
          <time dateTime={new Date(item.session.updatedAt).toISOString()}>
            {relativeSessionTime(item.session.updatedAt)}
          </time>
        </div>
        {surface === "card" && item.session.goal ? (
          <p className="session-board-goal">{item.session.goal}</p>
        ) : null}
        <div className="session-board-controls">
          <SessionStatusSelect
            item={item}
            status={effectiveStatus}
            disabled={working}
            onChange={(status) => updateStatus(item, status)}
          />
          <SessionActions
            item={item}
            disabled={busy && active}
            onRename={() => setEditingKey(item.key)}
            onArchive={() => setConfirming({ item, mode: "archive" })}
            onDelete={() => setConfirming({ item, mode: "delete" })}
          />
        </div>
      </article>
    );
  };

  return (
    <main className="sessions-workspace" id="main-content" aria-labelledby="sessions-title">
      <header className="sessions-header">
        <div className="sessions-heading-shell">
          <button type="button" className="sessions-back" onClick={onClose} aria-label="Back to chat" title="Back to chat">
            <IconBack size={14} strokeWidth={1.5} aria-hidden />
          </button>
          <div className="sessions-heading">
            <p className="sessions-eyebrow">Workspace</p>
            <div className="sessions-title-line">
              <h1 id="sessions-title">Sessions</h1>
              <span>{items.length}</span>
            </div>
            <p>Track work across every project without losing the conversation.</p>
          </div>
        </div>
        <div className="sessions-toolbar" aria-label="Session view controls">
          <div className="sessions-view-toggle" role="group" aria-label="View">
            <button
              type="button"
              className={preferences.view === "board" ? "active" : ""}
              aria-pressed={preferences.view === "board"}
              onClick={() => setPreferences((current) => ({ ...current, view: "board" }))}
            >
              <IconBoard size={14} strokeWidth={1.5} aria-hidden /> Board
            </button>
            <button
              type="button"
              className={preferences.view === "list" ? "active" : ""}
              aria-pressed={preferences.view === "list"}
              onClick={() => setPreferences((current) => ({ ...current, view: "list" }))}
            >
              <IconList size={14} strokeWidth={1.5} aria-hidden /> List
            </button>
          </div>
          <label className="sessions-search">
            <span className="sr-only">Search sessions</span>
            <IconSearch size={14} />
            <input
              type="search"
              value={query}
              placeholder="Search sessions"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={`sessions-filter-toggle${filtersOpen ? " active" : ""}`}
            aria-expanded={filtersOpen}
            aria-controls="sessions-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <IconFilter size={14} strokeWidth={1.5} aria-hidden /> Filters{activeFilterCount ? ` · ${activeFilterCount}` : ""}
          </button>
          <button type="button" className="sessions-new" disabled={busy} onClick={onNewChat}>
            <IconPlus size={14} /> New chat
          </button>
        </div>
      </header>

      {filtersOpen ? (
        <section className="sessions-filters" id="sessions-filters" aria-label="Session filters">
          <label>
            <span>Status</span>
            <select
              value={preferences.status}
              onChange={(event) => setPreferences((current) => ({
                ...current,
                status: event.target.value as SessionBoardPreferences["status"],
              }))}
            >
              <option value="all">All statuses</option>
              {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_COPY[status].label}</option>)}
            </select>
          </label>
          <label>
            <span>Project</span>
            <select
              value={preferences.project}
              onChange={(event) => setPreferences((current) => ({ ...current, project: event.target.value }))}
            >
              <option value="all">All projects</option>
              {projectsForFilter.map(([projectCwd, label]) => <option key={projectCwd} value={projectCwd}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Mode</span>
            <select
              value={preferences.mode}
              onChange={(event) => setPreferences((current) => ({
                ...current,
                mode: event.target.value as SessionBoardPreferences["mode"],
              }))}
            >
              <option value="all">All modes</option>
              <option value="plan">Plan</option>
              <option value="execute">Execute</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select
              value={preferences.sort}
              onChange={(event) => setPreferences((current) => ({
                ...current,
                sort: event.target.value as SessionBoardPreferences["sort"],
              }))}
            >
              <option value="updated">Recently updated</option>
              <option value="oldest">Oldest updated</option>
              <option value="title">Session title</option>
              <option value="project">Project name</option>
            </select>
          </label>
          <button
            type="button"
            disabled={activeFilterCount === 0}
            onClick={() => setPreferences((current) => ({
              ...current,
              status: "all",
              project: "all",
              mode: "all",
              sort: "updated",
            }))}
          >
            Clear filters
          </button>
        </section>
      ) : null}

      <section className="sessions-body" aria-live="polite" aria-busy={loading}>
        {loading && items.length === 0 ? <div className="sessions-state">Loading sessions…</div> : null}
        {error ? (
          <div className="sessions-state is-error" role="status">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <div className="sessions-empty">
            <IconSessions size={24} strokeWidth={1.5} aria-hidden />
            <h2>No sessions yet</h2>
            <p>Start a chat and it will appear here automatically.</p>
            <button type="button" onClick={onNewChat}><IconPlus size={14} /> New chat</button>
          </div>
        ) : null}
        {!error && items.length > 0 && visibleItems.length === 0 ? (
          <div className="sessions-empty">
            <IconSearch size={24} />
            <h2>No matches</h2>
            <p>Try a different search or clear the active filters.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setPreferences((current) => ({ ...current, status: "all", project: "all", mode: "all" }));
              }}
            >
              Clear search
            </button>
          </div>
        ) : null}

        {visibleItems.length > 0 && preferences.view === "board" ? (
          <div className="session-board" aria-label="Sessions board">
            {STATUS_ORDER.map((status) => {
              const columnItems = visibleItems.filter((item) => (workingKeys.has(item.key) ? "active" : item.status) === status);
              if (preferences.status !== "all" && preferences.status !== status) return null;
              return (
                <section className="session-board-column" key={status} data-status={status} aria-labelledby={`sessions-${status}`}>
                  <header>
                    <span className="session-board-column-icon"><StatusIcon status={status} /></span>
                    <div>
                      <h2 id={`sessions-${status}`}>{STATUS_COPY[status].label}</h2>
                      <p>{STATUS_COPY[status].description}</p>
                    </div>
                    <span className="session-board-count">{columnItems.length}</span>
                  </header>
                  <div className="session-board-cards">
                    {columnItems.map((item) => renderSession(item, "card"))}
                    {columnItems.length === 0 ? <p className="session-board-column-empty">No sessions here.</p> : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        {visibleItems.length > 0 && preferences.view === "list" ? (
          <section className="session-board-list" aria-label="Sessions list">
            <div className="session-board-list-head" aria-hidden="true">
              <span>Session</span>
              <span>Activity</span>
              <span>Status</span>
              <span />
            </div>
            {visibleItems.map((item) => renderSession(item, "row"))}
          </section>
        ) : null}
      </section>
      {confirming ? (
        <ConfirmSessionAction
          item={confirming.item}
          mode={confirming.mode}
          pending={actionPending}
          onCancel={() => {
            if (!actionPending) setConfirming(null);
          }}
          onConfirm={() => void runDestructiveAction(confirming.item, confirming.mode)}
        />
      ) : null}
    </main>
  );
}
