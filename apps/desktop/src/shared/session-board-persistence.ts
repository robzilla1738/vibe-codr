export type SessionBoardStatus = "active" | "review" | "done";

export const SESSION_BOARD_STORAGE_KEY = "vibe.session-board.v1";

export function sessionBoardKey(cwd: string, sessionId: string): string {
  return `${cwd}\u0000${sessionId}`;
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
  const previous = saved.statuses;
  const statuses = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  storage.setItem(SESSION_BOARD_STORAGE_KEY, JSON.stringify({
    ...saved,
    statuses: { ...statuses, [sessionBoardKey(cwd, sessionId)]: status },
  }));
}
