export type SessionBoardStatus = "active" | "review" | "done";

export const SESSION_BOARD_STORAGE_KEY = "vibe.session-board.v1";

export function sessionBoardKey(cwd: string, sessionId: string): string {
  return `${canonicalSessionBoardCwd(cwd)}\u0000${sessionId}`;
}

/** Match the main-process runtime key on every platform. Project discovery can
 * retain Windows' original spelling while runtime status uses normalized
 * slashes and case, so canonicalize Windows-looking paths independent of the
 * platform running the renderer tests. */
export function canonicalSessionBoardCwd(cwd: string): string {
  const slashed = cwd.replaceAll("\\", "/");
  const withoutTrailingSlash = slashed.replace(/\/+$/, "");
  const normalized = withoutTrailingSlash || "/";
  const withDriveRoot = /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized;
  return /^[A-Za-z]:\//.test(withDriveRoot) || withDriveRoot.startsWith("//")
    ? withDriveRoot.toLocaleLowerCase()
    : withDriveRoot;
}

export function canonicalSessionBoardStatuses(
  value: unknown,
): Record<string, SessionBoardStatus> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(
    (entry): entry is [string, SessionBoardStatus] => (
      entry[1] === "active" || entry[1] === "review" || entry[1] === "done"
    ),
  );
  const statuses: Record<string, SessionBoardStatus> = {};
  for (const [key, status] of entries) statuses[canonicalSessionBoardStatusKey(key)] = status;
  // If an installation already wrote both forms, the canonical entry is the
  // newer authoritative value regardless of object insertion order.
  for (const [key, status] of entries) {
    if (key === canonicalSessionBoardStatusKey(key)) statuses[key] = status;
  }
  return statuses;
}

function canonicalSessionBoardStatusKey(key: string): string {
  const separator = key.indexOf("\u0000");
  if (separator <= 0 || separator === key.length - 1) return key;
  return sessionBoardKey(key.slice(0, separator), key.slice(separator + 1));
}

/** Update one status without importing the complete, lazy Sessions projection
 * into the chat startup bundle. */
export function persistSessionBoardStatus(
  storage: Pick<Storage, "getItem" | "setItem">,
  cwd: string,
  sessionId: string,
  status: SessionBoardStatus,
): void {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage.getItem(SESSION_BOARD_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    /* A corrupt optional preference is replaced with the current status. */
  }
  const statuses = canonicalSessionBoardStatuses(saved.statuses);
  storage.setItem(SESSION_BOARD_STORAGE_KEY, JSON.stringify({
    ...saved,
    statuses: { ...statuses, [sessionBoardKey(cwd, sessionId)]: status },
  }));
}
