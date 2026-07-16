import type { CloudFailureDetails, CloudStartupStage, CloudStatusEvent } from "./cloud";

export const CLOUD_STARTUP_STAGES: ReadonlyArray<{ id: CloudStartupStage; label: string }> = [
  { id: "waiting", label: "Safe boundary" },
  { id: "packaging", label: "Package workspace" },
  { id: "creating", label: "Create sandbox" },
  { id: "uploading", label: "Upload" },
  { id: "verifying", label: "Verify runtime" },
  { id: "restoring", label: "Restore session" },
  { id: "starting-agent", label: "Start agent" },
  { id: "checking-health", label: "Health check" },
  { id: "connecting", label: "Connect" },
];

export function cloudStatusBelongsToSession(event: CloudStatusEvent, sessionId: string | null): boolean {
  return !event.sessionId || event.sessionId === sessionId;
}

export function cloudHandoffActionLabel(
  working: boolean,
  error: string | null,
  failure: CloudFailureDetails | null,
): string {
  if (working) return "Preparing handoff…";
  if (error && failure?.retryable) return "Try again";
  if (error && failure && !failure.retryable) return "Recovery required";
  return "Confirm and continue in Cloud";
}
