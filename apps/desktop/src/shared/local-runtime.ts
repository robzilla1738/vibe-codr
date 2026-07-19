export type LocalRuntimeState = "working" | "needs-input" | "needs-review" | "idle" | "failed" | "stopped";

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
