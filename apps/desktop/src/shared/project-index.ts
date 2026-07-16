import type { ProjectSessionSummary, ProjectSummary } from "./protocol";

/** Relative path segments under the home dir for one-off chats (not a real repo). */
export const CHATS_DIR_SEGMENTS = [".vibe", "chats"] as const;
export const PROJECT_NAME_LIMIT = 80;
export const SESSION_TITLE_LIMIT = 72;
export const MAX_PROJECT_RAIL_PROJECT_ROWS = 200;
export const MAX_PROJECT_RAIL_SESSION_ROWS = 200;

export interface LimitedRailItems<T> {
  items: T[];
  omitted: number;
}

function limitRecentWithPinned<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pinnedKey: string | null,
  maxItems: number,
): LimitedRailItems<T> {
  const limit = Math.max(1, Math.floor(maxItems));
  if (items.length <= limit) return { items: [...items], omitted: 0 };
  const visible = items.slice(0, limit);
  if (pinnedKey && !visible.some((item) => keyOf(item) === pinnedKey)) {
    const pinned = items.find((item) => keyOf(item) === pinnedKey);
    if (pinned) visible[visible.length - 1] = pinned;
  }
  return { items: visible, omitted: items.length - visible.length };
}

/** Bound mounted project headings while preserving the active workspace. */
export function limitProjectRailProjects(
  projects: readonly ProjectSummary[],
  activeCwd: string | null,
  maxItems = MAX_PROJECT_RAIL_PROJECT_ROWS,
): LimitedRailItems<ProjectSummary> {
  return limitRecentWithPinned(projects, (project) => project.cwd, activeCwd, maxItems);
}

/** Bound mounted session rows while preserving the active session when it is
 * part of the filtered result. The full index remains available to search. */
export function limitProjectRailSessions(
  sessions: readonly ProjectSessionSummary[],
  activeSessionId: string | null,
  maxItems = MAX_PROJECT_RAIL_SESSION_ROWS,
): LimitedRailItems<ProjectSessionSummary> {
  return limitRecentWithPinned(
    sessions,
    (session) => session.id,
    activeSessionId,
    maxItems,
  );
}

function clippedLabel(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** Match the engine project index so a successful rename does not change again on refresh. */
export function normalizeProjectName(value: string): string {
  return clippedLabel(value, PROJECT_NAME_LIMIT);
}

/** Match the engine's project-summary title projection. */
export function normalizeSessionTitle(value: string): string {
  return clippedLabel(value, SESSION_TITLE_LIMIT);
}

/**
 * Resolve the dedicated chats workspace path under a home directory.
 * Sessions here are one-off conversations — not tied to a code project.
 */
export function chatsCwdFromHome(home: string): string {
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const base = home.replace(/[/\\]+$/, "");
  return `${base}${sep}${CHATS_DIR_SEGMENTS.join(sep)}`;
}

/** Normalize path separators for equality checks (macOS/Linux + Windows). */
export function normalizeCwd(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/**
 * Order safe, host-authorized workspaces for automatic launch. The last
 * successful workspace wins when it still exists; otherwise the host's
 * newest-first recent order is preserved.
 */
export function startupProjectCandidates(
  projects: readonly ProjectSummary[],
  lastCwd: string | null,
): ProjectSummary[] {
  if (!lastCwd) return [...projects];
  const normalizedLast = normalizeCwd(lastCwd);
  const lastProject = projects.find(
    (project) => normalizeCwd(project.cwd) === normalizedLast,
  );
  if (!lastProject) return [...projects];
  return [
    lastProject,
    ...projects.filter((project) => project !== lastProject),
  ];
}

export function isChatsCwd(cwd: string, chatsRoot: string): boolean {
  return normalizeCwd(cwd) === normalizeCwd(chatsRoot);
}

/**
 * Resolve the shell directory without leaking the internal Chats session store
 * into the terminal. Project terminals stay rooted at their project; one-off
 * Chats open at the user's home directory.
 */
export function terminalCwdForWorkspace(
  cwd: string,
  chatsRoot: string | null,
  home: string | null,
): string | null {
  if (!chatsRoot || !home) return null;
  return isChatsCwd(cwd, chatsRoot) ? home : cwd;
}

export function isChatsProject(project: ProjectSummary, chatsRoot: string): boolean {
  return isChatsCwd(project.cwd, chatsRoot);
}

/**
 * Split the host project index into one-off chats vs real code projects.
 * Chats may not appear until the first chat is started (empty → null).
 */
export function partitionProjects(
  projects: readonly ProjectSummary[],
  chatsRoot: string,
): { chats: ProjectSummary | null; projects: ProjectSummary[] } {
  let chats: ProjectSummary | null = null;
  const rest: ProjectSummary[] = [];
  for (const project of projects) {
    if (isChatsProject(project, chatsRoot)) chats = project;
    else rest.push(project);
  }
  return { chats, projects: rest };
}

/** Flat chat sessions for the Chats rail section (newest first — host already sorts). */
export function chatSessions(chats: ProjectSummary | null): ProjectSessionSummary[] {
  return chats?.sessions ?? [];
}

export function filterProjects(
  projects: readonly ProjectSummary[],
  rawQuery: string,
): ProjectSummary[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [...projects];
  return projects.flatMap((project) => {
    const projectMatch = `${project.name} ${project.cwd}`.toLocaleLowerCase().includes(query);
    const sessions = projectMatch
      ? project.sessions
      : project.sessions.filter((session) =>
          `${session.title} ${session.model} ${session.goal ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
        );
    return projectMatch || sessions.length ? [{ ...project, sessions }] : [];
  });
}

/** Filter a flat chat session list by title/model/goal. */
export function filterChatSessions(
  sessions: readonly ProjectSessionSummary[],
  rawQuery: string,
): ProjectSessionSummary[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [...sessions];
  return sessions.filter((session) =>
    `${session.title} ${session.model} ${session.goal ?? ""}`.toLocaleLowerCase().includes(query),
  );
}

export function projectLabel(project: ProjectSummary, projects: readonly ProjectSummary[]): string {
  const duplicate = projects.some(
    (candidate) => candidate.cwd !== project.cwd && candidate.name === project.name,
  );
  if (!duplicate) return project.name;
  const parent = project.cwd.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0];
  return parent ? `${project.name} — ${parent}` : project.name;
}

export function relativeSessionTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
