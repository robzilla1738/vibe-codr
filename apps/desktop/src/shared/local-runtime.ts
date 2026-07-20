export type LocalRuntimeState = "working" | "needs-input" | "needs-review" | "idle" | "failed" | "stopped";

export const DEFAULT_LOCAL_RUNTIME_CAPACITY = 3;
export const MIN_LOCAL_RUNTIME_CAPACITY = 1;
export const MAX_LOCAL_RUNTIME_CAPACITY = 8;

export function isLocalRuntimeCapacity(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_LOCAL_RUNTIME_CAPACITY
    && value <= MAX_LOCAL_RUNTIME_CAPACITY;
}

/** Invalid persisted values never leak into lifecycle policy. */
export function normalizeLocalRuntimeCapacity(value: unknown): number {
  return isLocalRuntimeCapacity(value) ? value : DEFAULT_LOCAL_RUNTIME_CAPACITY;
}

export interface LocalRuntimeSettings {
  capacity: number;
}

/** Content-free status for one desktop-owned local engine. Background runtimes
 * never forward transcript/tool payloads to the renderer. */
export interface LocalRuntimeStatus {
  key: string;
  cwd: string;
  sessionId: string;
  state: LocalRuntimeState;
  updatedAt: number;
  jobCount: number;
  foreground: boolean;
}

/** A launch waiting for a safe local runtime slot. This is intentionally
 * separate from LocalRuntimeStatus: queued work does not own an engine. */
export interface LocalRuntimeLaunchQueueItem {
  id: string;
  cwd: string;
  sessionId?: string;
  createdAt: number;
  position: number;
  status: "queued";
}

export interface LocalRuntimeLaunchQueueSnapshot {
  capacity: number;
  items: LocalRuntimeLaunchQueueItem[];
}

export type LocalRuntimeNotificationKind =
  | "permission"
  | "question"
  | "plan-review"
  | "failure"
  | "completed";

/** Main-process-only notification input. No prompt, tool, error, transcript,
 * path label, or credential content crosses this boundary. */
export interface LocalRuntimeNotificationTransition {
  kind: LocalRuntimeNotificationKind;
  cwd: string;
  sessionId: string;
  transitionId: string;
}

export interface LocalRuntimeNotificationTarget {
  cwd: string;
  sessionId: string;
}
