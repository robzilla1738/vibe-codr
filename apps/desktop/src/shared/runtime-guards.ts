import type { UIEvent } from "./events";
import { isSubscriptionAuthStart, isSubscriptionAuthStatus } from "./provider-auth";
import {
  isRuntimeIdentifier,
  isUIEvent,
  type ProjectSummary,
  type RpcMethod,
} from "./protocol";
import type { EngineSnapshot } from "./types";

export const RPC_CATALOG_MAX_ITEMS = 20_000;
export const RPC_CATALOG_FIELD_MAX_CHARS = 16 * 1_024;
export const RPC_CATALOG_ERROR_MAX_CHARS = 64 * 1_024;
export const RPC_PROVIDER_ENV_MAX_ITEMS = 64;
export const RPC_PROVIDER_ENV_MAX_CHARS = 1_024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown): boolean {
  return finite(value) && (value as number) >= 0;
}

function positive(value: unknown): boolean {
  return finite(value) && (value as number) > 0;
}

function recordsWithRuntimeId(value: unknown, key: string): boolean {
  return Array.isArray(value) && value.every((item) => isRuntimeIdentifier(record(item)?.[key]));
}

function everyRecord(value: unknown, predicate: (item: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(value) && value.every((item) => {
    const parsed = record(item);
    return !!parsed && predicate(parsed);
  });
}

function catalogRecords(
  value: unknown,
  predicate: (item: Record<string, unknown>) => boolean,
): boolean {
  return Array.isArray(value)
    && value.length <= RPC_CATALOG_MAX_ITEMS
    && everyRecord(value, predicate);
}

function boundedString(value: unknown, maxChars = RPC_CATALOG_FIELD_MAX_CHARS): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !value.includes("\0");
}

function boundedDisplayString(value: unknown, maxChars = RPC_CATALOG_FIELD_MAX_CHARS): boolean {
  return typeof value === "string" && value.length <= maxChars && !value.includes("\0");
}

function boundedOptionalDisplayString(
  value: unknown,
  maxChars = RPC_CATALOG_FIELD_MAX_CHARS,
): boolean {
  return value === undefined || boundedDisplayString(value, maxChars);
}

function boundedOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || boundedString(value);
}

function boundedProviderEnv(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= RPC_PROVIDER_ENV_MAX_ITEMS
    && value.every((item) => boundedString(item, RPC_PROVIDER_ENV_MAX_CHARS));
}

function usage(value: unknown): boolean {
  const item = record(value);
  return !!item
    && (item.inputTokens === undefined || nonNegative(item.inputTokens))
    && (item.outputTokens === undefined || nonNegative(item.outputTokens))
    && (item.totalTokens === undefined || nonNegative(item.totalTokens))
    && (item.cachedInputTokens === undefined || nonNegative(item.cachedInputTokens));
}

function messagePart(value: unknown): boolean {
  const part = record(value);
  if (!part || typeof part.type !== "string") return false;
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string";
  if (part.type === "tool-call") {
    return isRuntimeIdentifier(part.toolCallId) && typeof part.toolName === "string";
  }
  if (part.type === "tool-result") {
    return isRuntimeIdentifier(part.toolCallId)
      && typeof part.toolName === "string"
      && (part.isError === undefined || typeof part.isError === "boolean");
  }
  return false;
}

function message(value: unknown): boolean {
  const item = record(value);
  return !!item
    && isRuntimeIdentifier(item.id)
    && (item.role === "user" || item.role === "assistant" || item.role === "system" || item.role === "tool")
    && Array.isArray(item.parts)
    && item.parts.every(messagePart)
    && finite(item.createdAt)
    && (item.usage === undefined || usage(item.usage));
}

export function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  const snap = record(value);
  const usage = record(snap?.usage);
  return !!snap
    && isRuntimeIdentifier(snap.sessionId)
    && typeof snap.model === "string"
    && (snap.mode === "plan" || snap.mode === "execute")
    && (snap.goal === null || typeof snap.goal === "string")
    && Array.isArray(snap.history) && snap.history.every(message)
    && Array.isArray(snap.tasks) && snap.tasks.every(task)
    && !!usage && nonNegative(usage.inputTokens) && nonNegative(usage.outputTokens)
    && nonNegative(usage.totalTokens) && nonNegative(usage.costUSD)
    && (usage.costEstimated === undefined || typeof usage.costEstimated === "boolean")
    && (usage.cachedInputTokens === undefined || nonNegative(usage.cachedInputTokens))
    && typeof snap.busy === "boolean"
    && typeof snap.theme === "string"
    && typeof snap.accentColor === "string"
    && (snap.details === "quiet" || snap.details === "normal" || snap.details === "verbose")
    && typeof snap.mouse === "boolean"
    && (snap.approvalMode === "ask" || snap.approvalMode === "auto")
    && (snap.subagentModel === undefined || typeof snap.subagentModel === "string")
    && (snap.reasoning === undefined || typeof snap.reasoning === "string")
    && (snap.git === undefined || gitInfo(snap.git))
    && (snap.pendingCapabilities === undefined || (Array.isArray(snap.pendingCapabilities) && snap.pendingCapabilities.every(pendingCapability)))
    && (snap.goalRun === undefined || goalRun(snap.goalRun))
    && Array.isArray(snap.commandNames) && snap.commandNames.every((item) => typeof item === "string");
}

function pendingCapability(value: unknown): boolean {
  const item = record(value);
  return !!item
    && isRuntimeIdentifier(item.id)
    && boundedString(item.integration)
    && boundedString(item.toolName)
    && isRuntimeIdentifier(item.originatingTurn)
    && (item.approvalScope === "once" || item.approvalScope === "session" || item.approvalScope === "integration")
    && (item.status === "pending" || item.status === "approved" || item.status === "denied" || item.status === "resolved")
    && nonNegative(item.createdAt);
}

export function isProjectSummaryArray(value: unknown): value is ProjectSummary[] {
  return Array.isArray(value) && value.every((item) => {
    const project = record(item);
    if (!project || typeof project.cwd !== "string" || typeof project.name !== "string" || !finite(project.updatedAt) || !Array.isArray(project.sessions)) return false;
    return project.sessions.every((sessionValue) => {
      const session = record(sessionValue);
      return !!session
        && isRuntimeIdentifier(session.id)
        && typeof session.title === "string"
        && typeof session.model === "string"
        && (session.mode === "plan" || session.mode === "execute")
        && (session.goal === null || typeof session.goal === "string")
        && finite(session.createdAt)
        && finite(session.updatedAt);
    });
  });
}

export function isRpcResult(method: RpcMethod, value: unknown): boolean {
  switch (method) {
    case "snapshot": return isEngineSnapshot(value);
    case "listProjects": return isProjectSummaryArray(value);
    case "listModels": return catalogRecords(value, (item) => boundedString(item.id) && boundedString(item.providerId) && boundedOptionalDisplayString(item.name) && (item.contextWindow === undefined || positive(item.contextWindow)));
    case "listProviders": return catalogRecords(value, (item) => boundedString(item.id) && typeof item.configured === "boolean" && typeof item.keyless === "boolean" && boundedProviderEnv(item.env));
    case "listAgents": return catalogRecords(value, (item) => boundedString(item.name) && boundedDisplayString(item.description) && boundedOptionalStringOrNull(item.model) && (item.mode === "plan" || item.mode === "execute"));
    case "listSkills": return catalogRecords(value, (item) => boundedString(item.name) && boundedDisplayString(item.description));
    case "listMcp": return catalogRecords(value, (item) => boundedString(item.name) && typeof item.connected === "boolean" && typeof item.configured === "boolean" && nonNegative(item.toolCount) && nonNegative(item.resourceCount) && nonNegative(item.promptCount) && boundedOptionalDisplayString(item.error, RPC_CATALOG_ERROR_MAX_CHARS));
    case "providerAuthStatus": return isSubscriptionAuthStatus(value);
    case "beginProviderAuth": return isSubscriptionAuthStart(value);
    case "cancelProviderAuth":
    case "logoutProviderAuth": return value === null;
    case "exportProviderAuth": {
      if (value === null) return true;
      const credential = record(value);
      return !!credential
        && (credential.providerId === "openai-codex" || credential.providerId === "xai-oauth")
        && typeof credential.access === "string" && credential.access.length > 0
        && (credential.accountId === undefined || typeof credential.accountId === "string");
    }
    case "listSessions": return recordsWithRuntimeId(value, "id");
    case "renameProject": return typeof record(value)?.name === "string";
    case "archiveProject":
    case "deleteProject": return typeof record(value)?.cwd === "string";
    case "renameSession":
    case "deleteSession":
    case "archiveSession": return isRuntimeIdentifier(record(value)?.id);
    case "finalize": return value === null;
    case "prepareHandoff": {
      const item = record(value);
      return !!item && isRuntimeIdentifier(item.sessionId)
        && Number.isSafeInteger(item.ownershipGeneration)
        && Number.isSafeInteger(item.previousGeneration)
        && isRuntimeIdentifier(item.nonce)
        && finite(item.preparedAt);
    }
    case "exportPortableSession": {
      const item = record(value);
      return !!item && item.schemaVersion === 1 && isRuntimeIdentifier(item.sessionId)
        && Number.isSafeInteger(item.ownershipGeneration) && typeof item.engineRevision === "string"
        && Array.isArray(item.files) && typeof item.archiveSha256 === "string";
    }
    case "importPortableSession": return isRuntimeIdentifier(record(value)?.sessionId);
    case "commitPortableImport":
    case "abortPortableImport":
    case "commitHandoff":
    case "abortHandoff": return value === null;
    case "recoverLostCloudOwnership": return Number.isSafeInteger(value) && (value as number) >= 1;
    case "abortInterruptedHandoff": {
      const result = record(value);
      return !!result
        && (result.outcome === "aborted" || result.outcome === "already-committed")
        && Number.isSafeInteger(result.generation)
        && (result.generation as number) >= 0;
    }
  }
}

function task(value: unknown): boolean {
  const item = record(value);
  return !!item
    && isRuntimeIdentifier(item.id)
    && typeof item.title === "string"
    && (item.status === "pending" || item.status === "in_progress" || item.status === "completed");
}

function gitInfo(value: unknown): boolean {
  const git = record(value);
  return !!git
    && typeof git.branch === "string"
    && nonNegative(git.dirty)
    && nonNegative(git.ahead)
    && nonNegative(git.behind)
    && typeof git.worktree === "boolean";
}

function goalRun(value: unknown): boolean {
  const run = record(value);
  return !!run
    && typeof run.active === "boolean"
    && (run.phase === null || run.phase === "plan" || run.phase === "execute")
    && nonNegative(run.round)
    && nonNegative(run.max)
    && (run.pausedReason === null || typeof run.pausedReason === "string")
    && typeof run.met === "boolean";
}

/**
 * Deep validation for event payloads that renderer components dereference.
 * Nested shape checks now live inside `isUIEvent` so decodeOutbound cannot
 * accept junk that only fails the second gate — keep this export for callers.
 */
export function isRenderableUIEvent(value: UIEvent): boolean {
  return isUIEvent(value);
}
