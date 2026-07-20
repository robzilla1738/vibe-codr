import type { EngineSnapshot, UIEvent } from "./domain.ts";
import type { ProjectSummary } from "./project.ts";

/**
 * Dependency-free synchronous guards for presentation clients. Transport and
 * RPC boundaries continue to use the canonical Zod schemas; these guards keep
 * the same renderer-dereferenced safety checks without loading that graph into
 * startup bundles.
 */

const UI_EVENT_TYPE_MAP = {
  "session-start": true,
  "user-message": true,
  "assistant-text-delta": true,
  "reasoning-delta": true,
  "tool-call-started": true,
  "tool-call-progress": true,
  "tool-call-finished": true,
  "step-finished": true,
  "usage-updated": true,
  "context-updated": true,
  "mode-changed": true,
  "model-changed": true,
  "goal-changed": true,
  "goal-run": true,
  "plan-state-changed": true,
  "question-request": true,
  "question-settled": true,
  "activities-changed": true,
  "theme-changed": true,
  "accent-changed": true,
  "details-changed": true,
  "mouse-changed": true,
  "git-updated": true,
  "jobs-changed": true,
  "approvals-changed": true,
  "plan-presented": true,
  "permission-request": true,
  "permission-settled": true,
  "tasks-updated": true,
  "orchestration-task": true,
  "queue-changed": true,
  "file-changed": true,
  "checkpoint-created": true,
  "checkpoint-restored": true,
  "verify-started": true,
  "verify-finished": true,
  compacted: true,
  "runtime-handoff-requested": true,
  "external-capability-pending": true,
  "external-capability-resolved": true,
  "subagent-started": true,
  "subagent-activity": true,
  "subagent-finished": true,
  "loop-tick": true,
  "loop-stopped": true,
  notice: true,
  "engine-error": true,
  "turn-finished": true,
  "turn-performance": true,
  "session-idle": true,
  "engine-idle": true,
} as const satisfies Record<UIEvent["type"], true>;

const UI_EVENT_TYPES = new Set<UIEvent["type"]>(
  Object.keys(UI_EVENT_TYPE_MAP) as UIEvent["type"][],
);
const SESSION_EVENT_TYPES = new Set<UIEvent["type"]>([
  "session-start", "user-message", "assistant-text-delta", "reasoning-delta",
  "tool-call-started", "tool-call-progress", "tool-call-finished", "step-finished",
  "usage-updated", "context-updated", "mode-changed", "model-changed", "goal-changed",
  "goal-run", "plan-state-changed", "question-request", "question-settled",
  "activities-changed", "git-updated", "jobs-changed", "plan-presented",
  "permission-request", "permission-settled", "tasks-updated", "orchestration-task",
  "file-changed", "compacted", "subagent-started", "subagent-activity",
  "subagent-finished", "turn-finished", "turn-performance", "session-idle", "engine-idle",
  "runtime-handoff-requested", "external-capability-pending", "external-capability-resolved",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || nonNegative(value);
}

export function isRuntimeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && !value.includes("\0");
}

function optionalRuntimeIdentifier(value: unknown): boolean {
  return value === undefined || isRuntimeIdentifier(value);
}

function catalogIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16 * 1_024
    && !value.includes("\0");
}

function runtimeIdentifierArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRuntimeIdentifier);
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function executionTarget(value: unknown): boolean {
  const target = record(value);
  return !!target && (target.kind === "local"
    || (target.kind === "cloud" && (target.provider === "e2b" || target.provider === "vercel")));
}

function usage(value: unknown): boolean {
  const item = record(value);
  return !!item
    && (item.inputTokens === undefined || nonNegative(item.inputTokens))
    && (item.outputTokens === undefined || nonNegative(item.outputTokens))
    && (item.totalTokens === undefined || nonNegative(item.totalTokens))
    && (item.cachedInputTokens === undefined || nonNegative(item.cachedInputTokens));
}

function sessionUsage(value: unknown): boolean {
  const item = record(value);
  return !!item && nonNegative(item.inputTokens) && nonNegative(item.outputTokens)
    && nonNegative(item.totalTokens) && nonNegative(item.costUSD)
    && optionalBoolean(item.costEstimated) && optionalNonNegative(item.cachedInputTokens);
}

function messagePart(value: unknown): boolean {
  const part = record(value);
  if (!part || typeof part.type !== "string") return false;
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string";
  if (part.type === "tool-call") {
    return isRuntimeIdentifier(part.toolCallId) && typeof part.toolName === "string";
  }
  if (part.type === "tool-result") {
    return isRuntimeIdentifier(part.toolCallId) && typeof part.toolName === "string"
      && (part.isError === undefined || typeof part.isError === "boolean");
  }
  return false;
}

function message(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id)
    && (item.role === "user" || item.role === "assistant" || item.role === "system" || item.role === "tool")
    && Array.isArray(item.parts) && item.parts.every(messagePart) && finite(item.createdAt)
    && (item.usage === undefined || usage(item.usage));
}

function task(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id) && typeof item.title === "string"
    && (item.status === "pending" || item.status === "in_progress" || item.status === "completed");
}

function gitInfo(value: unknown): boolean {
  const item = record(value);
  return !!item && typeof item.branch === "string" && nonNegative(item.dirty)
    && nonNegative(item.ahead) && nonNegative(item.behind) && typeof item.worktree === "boolean";
}

function goalRun(value: unknown): boolean {
  const item = record(value);
  return !!item && typeof item.active === "boolean"
    && (item.phase === null || item.phase === "plan" || item.phase === "execute")
    && nonNegative(item.round) && nonNegative(item.max)
    && (item.pausedReason === null || typeof item.pausedReason === "string")
    && typeof item.met === "boolean";
}

function pendingCapability(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id) && catalogIdentifier(item.integration)
    && catalogIdentifier(item.toolName) && isRuntimeIdentifier(item.originatingTurn)
    && (item.approvalScope === "once" || item.approvalScope === "session" || item.approvalScope === "integration")
    && (item.status === "pending" || item.status === "approved" || item.status === "denied" || item.status === "resolved")
    && nonNegative(item.createdAt);
}

export function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  const snap = record(value);
  return !!snap && isRuntimeIdentifier(snap.sessionId)
    && (snap.hostInstanceId === undefined || isRuntimeIdentifier(snap.hostInstanceId))
    && (snap.lastEventSeq === undefined
      || (Number.isSafeInteger(snap.lastEventSeq) && (snap.lastEventSeq as number) >= 0))
    && typeof snap.model === "string" && (snap.mode === "plan" || snap.mode === "execute")
    && (snap.goal === null || typeof snap.goal === "string")
    && Array.isArray(snap.history) && snap.history.every(message)
    && Array.isArray(snap.tasks) && snap.tasks.every(task) && sessionUsage(snap.usage)
    && typeof snap.busy === "boolean" && typeof snap.theme === "string"
    && typeof snap.accentColor === "string"
    && (snap.details === "quiet" || snap.details === "normal" || snap.details === "verbose")
    && typeof snap.mouse === "boolean" && (snap.approvalMode === "ask" || snap.approvalMode === "auto")
    && (snap.subagentModel === undefined || typeof snap.subagentModel === "string")
    && (snap.reasoning === undefined || typeof snap.reasoning === "string")
    && (snap.git === undefined || gitInfo(snap.git))
    && (snap.pendingCapabilities === undefined
      || (Array.isArray(snap.pendingCapabilities) && snap.pendingCapabilities.every(pendingCapability)))
    && (snap.goalRun === undefined || goalRun(snap.goalRun))
    && Array.isArray(snap.commandNames) && snap.commandNames.every((item) => typeof item === "string");
}

export function isProjectSummaryArray(value: unknown): value is ProjectSummary[] {
  return Array.isArray(value) && value.every((item) => {
    const project = record(item);
    if (!project || typeof project.cwd !== "string" || typeof project.name !== "string"
      || !finite(project.updatedAt) || !Array.isArray(project.sessions)) return false;
    return project.sessions.every((sessionValue) => {
      const session = record(sessionValue);
      return !!session && isRuntimeIdentifier(session.id) && typeof session.title === "string"
        && typeof session.model === "string" && (session.mode === "plan" || session.mode === "execute")
        && (session.goal === null || typeof session.goal === "string")
        && finite(session.createdAt) && finite(session.updatedAt)
        && (session.latestTurnId === undefined || isRuntimeIdentifier(session.latestTurnId));
    });
  });
}

function uiJob(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id) && typeof item.command === "string"
    && (item.status === "running" || item.status === "exited" || item.status === "killed")
    && (item.exitCode === null || finite(item.exitCode))
    && (item.pid === undefined || (finite(item.pid) && item.pid > 0))
    && stringArray(item.servers) && typeof item.outputTail === "string";
}

function uiPlanSource(value: unknown): boolean {
  const source = record(value);
  return !!source && typeof source.url === "string" && optionalString(source.title);
}

export function isUIEvent(value: unknown): value is UIEvent {
  const event = record(value);
  if (!event || typeof event.type !== "string"
    || !UI_EVENT_TYPES.has(event.type as UIEvent["type"])) return false;
  if (SESSION_EVENT_TYPES.has(event.type as UIEvent["type"])
    && !isRuntimeIdentifier(event.sessionId)) return false;
  switch (event.type) {
    case "session-start": return typeof event.model === "string" && (event.mode === "plan" || event.mode === "execute");
    case "user-message": return typeof event.text === "string"
      && (event.origin === undefined || event.origin === "user" || event.origin === "engine")
      && optionalString(event.label) && optionalRuntimeIdentifier(event.turnId);
    case "turn-performance": {
      const sample = record(event.sample);
      return !!sample && isRuntimeIdentifier(sample.turnId) && typeof sample.model === "string"
        && (sample.serviceTier === "default" || sample.serviceTier === "priority")
        && nonNegative(sample.totalMs);
    }
    case "assistant-text-delta":
    case "reasoning-delta": return typeof event.delta === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-started": return isRuntimeIdentifier(event.toolCallId) && typeof event.toolName === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-progress": return isRuntimeIdentifier(event.toolCallId) && typeof event.chunk === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-finished": return isRuntimeIdentifier(event.toolCallId) && typeof event.toolName === "string" && typeof event.isError === "boolean" && optionalRuntimeIdentifier(event.subagentId);
    case "step-finished": return event.usage === undefined || usage(event.usage);
    case "usage-updated": return sessionUsage(event.usage);
    case "context-updated": return nonNegative(event.usedTokens) && finite(event.contextWindow) && event.contextWindow > 0;
    case "mode-changed": return event.mode === "plan" || event.mode === "execute";
    case "model-changed": return typeof event.model === "string";
    case "goal-changed": return event.goal === null || typeof event.goal === "string";
    case "goal-run": return goalRun(event.run);
    case "plan-state-changed": {
      const state = record(event.state);
      return !!state && ["inactive", "active", "pending", "exit_pending"].includes(String(state.status))
        && optionalString(state.plan)
        && (state.sources === undefined || (Array.isArray(state.sources) && state.sources.every(uiPlanSource)))
        && (state.assumptions === undefined || stringArray(state.assumptions))
        && optionalBoolean(state.ungrounded) && nonNegative(state.updatedAt);
    }
    case "question-request": {
      const question = record(event.question);
      return !!question && isRuntimeIdentifier(question.id) && typeof question.question === "string"
        && optionalString(question.header) && Array.isArray(question.choices)
        && question.choices.every((value) => {
          const choice = record(value);
          return !!choice && typeof choice.label === "string" && optionalString(choice.description);
        }) && typeof question.multiple === "boolean" && typeof question.allowFreeform === "boolean"
        && nonNegative(question.createdAt);
    }
    case "question-settled": return isRuntimeIdentifier(event.id)
      && ["answered", "aborted", "shutdown", "timeout"].includes(String(event.reason));
    case "activities-changed": return Array.isArray(event.activities) && event.activities.every((value) => {
      const activity = record(value);
      const metrics = activity?.metrics === undefined ? null : record(activity.metrics);
      return !!activity && isRuntimeIdentifier(activity.id)
        && ["shell", "subagent", "tasks", "monitor"].includes(String(activity.kind))
        && typeof activity.label === "string"
        && ["queued", "running", "completed", "failed", "cancelled"].includes(String(activity.status))
        && optionalNonNegative(activity.startedAt) && optionalNonNegative(activity.finishedAt)
        && optionalString(activity.summary) && optionalString(activity.outputTail)
        && (activity.metrics === undefined || (!!metrics && optionalNonNegative(metrics.turns)
          && optionalNonNegative(metrics.toolCalls) && optionalNonNegative(metrics.inputTokens)
          && optionalNonNegative(metrics.outputTokens) && optionalNonNegative(metrics.contextTokens)
          && optionalNonNegative(metrics.contextWindow) && optionalNonNegative(metrics.errors)));
    });
    case "theme-changed": return typeof event.theme === "string";
    case "accent-changed": return typeof event.accent === "string";
    case "details-changed": return event.details === "quiet" || event.details === "normal" || event.details === "verbose";
    case "mouse-changed": return typeof event.mouse === "boolean";
    case "git-updated": return gitInfo(event.git);
    case "jobs-changed": return Array.isArray(event.jobs) && event.jobs.every(uiJob);
    case "approvals-changed": return event.mode === "ask" || event.mode === "auto";
    case "plan-presented": return typeof event.plan === "string"
      && (event.sources === undefined || (Array.isArray(event.sources) && event.sources.every(uiPlanSource)))
      && (event.assumptions === undefined || stringArray(event.assumptions)) && optionalBoolean(event.ungrounded);
    case "permission-request": return isRuntimeIdentifier(event.id) && typeof event.toolName === "string";
    case "permission-settled": return runtimeIdentifierArray(event.ids)
      && (event.reason === "aborted" || event.reason === "shutdown");
    case "tasks-updated": return Array.isArray(event.tasks) && event.tasks.every(task);
    case "orchestration-task": return isRuntimeIdentifier(event.taskId) && typeof event.objective === "string"
      && ["running", "completed", "failed", "skipped"].includes(String(event.status))
      && optionalNonNegative(event.attempts) && optionalNonNegative(event.durationMs);
    case "queue-changed": return (event.active === null || taskLikeQueueItem(event.active))
      && Array.isArray(event.pending) && event.pending.every(taskLikeQueueItem);
    case "notice": return (event.level === "info" || event.level === "warn" || event.level === "error")
      && typeof event.message === "string";
    case "engine-error": return typeof event.message === "string" && optionalRuntimeIdentifier(event.sessionId);
    case "file-changed": return isRuntimeIdentifier(event.toolCallId) && typeof event.path === "string"
      && (event.action === "edit" || event.action === "write") && typeof event.diff === "string"
      && nonNegative(event.added) && nonNegative(event.removed);
    case "checkpoint-created":
    case "checkpoint-restored": return isRuntimeIdentifier(event.id) && typeof event.label === "string";
    case "verify-started": return typeof event.command === "string";
    case "verify-finished": return typeof event.ok === "boolean" && typeof event.output === "string";
    case "compacted": return nonNegative(event.freedTokens);
    case "runtime-handoff-requested": return executionTarget(event.target) && optionalString(event.instruction);
    case "external-capability-pending": return pendingCapability(event.request);
    case "external-capability-resolved": return isRuntimeIdentifier(event.id)
      && (event.status === "denied" || event.status === "resolved");
    case "subagent-started": return isRuntimeIdentifier(event.subagentId) && typeof event.prompt === "string";
    case "subagent-activity": return isRuntimeIdentifier(event.subagentId) && typeof event.label === "string";
    case "subagent-finished": return isRuntimeIdentifier(event.subagentId) && typeof event.result === "string";
    case "loop-tick": return isRuntimeIdentifier(event.loopId) && nonNegative(event.iteration);
    case "loop-stopped": return isRuntimeIdentifier(event.loopId) && typeof event.reason === "string";
    case "engine-idle": return event.gate === undefined
      || ["green", "red", "unverified", "aborted"].includes(String(event.gate));
    case "turn-finished":
    case "session-idle": return true;
    default: return false;
  }
}

function taskLikeQueueItem(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id) && typeof item.label === "string";
}
