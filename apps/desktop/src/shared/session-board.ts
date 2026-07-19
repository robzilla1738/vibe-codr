import type { ProjectSessionSummary, ProjectSummary } from "./protocol";
import type { CloudSessionStatus } from "./cloud";
import { isChatsCwd, projectLabel } from "./project-index";
import {
  SESSION_BOARD_STORAGE_KEY,
  canonicalSessionBoardStatuses,
  sessionBoardKey,
  type SessionBoardStatus,
} from "./session-board-persistence";

export {
  SESSION_BOARD_STORAGE_KEY,
  canonicalSessionBoardCwd,
  canonicalSessionBoardStatuses,
  sessionBoardKey,
  type SessionBoardStatus,
} from "./session-board-persistence";

export type SessionBoardView = "board" | "list";
export type SessionBoardSort = "updated" | "oldest" | "title" | "project";

export interface SessionBoardItem {
  key: string;
  cwd: string;
  project: string;
  isChat: boolean;
  session: ProjectSessionSummary;
  status: SessionBoardStatus;
}

export interface SessionBoardPreferences {
  view: SessionBoardView;
  status: "all" | SessionBoardStatus;
  project: string;
  mode: "all" | ProjectSessionSummary["mode"];
  sort: SessionBoardSort;
  statuses: Record<string, SessionBoardStatus>;
}

export const DEFAULT_SESSION_BOARD_PREFERENCES: SessionBoardPreferences = {
  view: "board",
  status: "all",
  project: "all",
  mode: "all",
  sort: "updated",
  statuses: {},
};

export type AutomaticSessionState = "working" | "needs-input" | "review" | "done" | null;

/** Sandbox ownership is not model activity: a healthy `running` sandbox can be
 * waiting quietly for hours. Only handoff transitions and actionable failures
 * imply a board state on their own. */
export function cloudAutomaticSessionState(status: CloudSessionStatus): AutomaticSessionState {
  if (status === "preparing" || status === "transferring" || status === "starting" || status === "syncing-back") {
    return "working";
  }
  if (
    status === "needs-local"
    || status === "cleanup-pending"
    || status === "handoff-interrupted"
    || status === "lost"
    || status === "recoverable-error"
  ) {
    return "needs-input";
  }
  return null;
}

export function automaticSessionBoardStatus(state: AutomaticSessionState): SessionBoardStatus | null {
  if (state === "working") return "active";
  if (state === "needs-input" || state === "review") return "review";
  if (state === "done") return "done";
  return null;
}

const STATUS_VALUES = new Set<SessionBoardStatus>(["active", "review", "done"]);
const VIEW_VALUES = new Set<SessionBoardView>(["board", "list"]);
const SORT_VALUES = new Set<SessionBoardSort>(["updated", "oldest", "title", "project"]);

export function readSessionBoardPreferences(
  storage: Pick<Storage, "getItem">,
): SessionBoardPreferences {
  try {
    const raw = storage.getItem(SESSION_BOARD_STORAGE_KEY);
    if (!raw) return DEFAULT_SESSION_BOARD_PREFERENCES;
    const value = JSON.parse(raw) as Partial<SessionBoardPreferences>;
    const statuses = canonicalSessionBoardStatuses(value.statuses);
    return {
      view: VIEW_VALUES.has(value.view as SessionBoardView) ? value.view as SessionBoardView : "board",
      status: value.status === "all" || STATUS_VALUES.has(value.status as SessionBoardStatus)
        ? value.status as SessionBoardPreferences["status"]
        : "all",
      project: typeof value.project === "string" && value.project ? value.project : "all",
      mode: value.mode === "plan" || value.mode === "execute" ? value.mode : "all",
      sort: SORT_VALUES.has(value.sort as SessionBoardSort) ? value.sort as SessionBoardSort : "updated",
      statuses,
    };
  } catch {
    return DEFAULT_SESSION_BOARD_PREFERENCES;
  }
}

export function writeSessionBoardPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: SessionBoardPreferences,
): void {
  storage.setItem(SESSION_BOARD_STORAGE_KEY, JSON.stringify(preferences));
}

export function flattenSessionBoard(
  projects: readonly ProjectSummary[],
  chatsCwd: string | null,
  statuses: Readonly<Record<string, SessionBoardStatus>>,
): SessionBoardItem[] {
  return projects.flatMap((project) => {
    const isChat = Boolean(chatsCwd && isChatsCwd(project.cwd, chatsCwd));
    const label = isChat ? "Chats" : projectLabel(project, projects);
    return project.sessions.map((session) => {
      const key = sessionBoardKey(project.cwd, session.id);
      return {
        key,
        cwd: project.cwd,
        project: label,
        isChat,
        session,
        status: statuses[key] ?? "active",
      };
    });
  });
}

export function filterSessionBoard(
  items: readonly SessionBoardItem[],
  options: {
    query: string;
    status: SessionBoardPreferences["status"];
    project: string;
    mode: SessionBoardPreferences["mode"];
    sort: SessionBoardSort;
    workingKeys?: ReadonlySet<string>;
    automaticStatuses?: ReadonlyMap<string, SessionBoardStatus>;
  },
): SessionBoardItem[] {
  const query = options.query.trim().toLocaleLowerCase();
  const workingKeys = options.workingKeys ?? new Set<string>();
  const filtered = items.filter((item) => {
    const effectiveStatus = options.automaticStatuses?.get(item.key)
      ?? (workingKeys.has(item.key) ? "active" : item.status);
    if (options.status !== "all" && effectiveStatus !== options.status) return false;
    if (options.project !== "all" && item.cwd !== options.project) return false;
    if (options.mode !== "all" && item.session.mode !== options.mode) return false;
    if (!query) return true;
    return `${item.session.title} ${item.session.goal ?? ""} ${item.session.model} ${item.project} ${item.cwd}`
      .toLocaleLowerCase()
      .includes(query);
  });

  return [...filtered].sort((a, b) => {
    if (options.sort === "oldest") return a.session.updatedAt - b.session.updatedAt;
    if (options.sort === "title") return a.session.title.localeCompare(b.session.title);
    if (options.sort === "project") {
      return a.project.localeCompare(b.project) || b.session.updatedAt - a.session.updatedAt;
    }
    return b.session.updatedAt - a.session.updatedAt;
  });
}
