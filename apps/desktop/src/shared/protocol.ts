import type { ExecutionTarget } from "./cloud";
import type { EngineCommand } from "./commands";
import type { UIEvent } from "./events";
import type { PortableSessionArchiveV1 } from "./handoff";
import type { EngineSnapshot } from "./types";

// Re-export for exhaustiveness tests that compare against the type unions.
export type { EngineCommand, UIEvent };

export const HOST_PROTOCOL_VERSION = 2 as const;
export const HOST_PROTOCOL_CAPABILITIES = ["event-replay"] as const;
export type HostProtocolCapability = (typeof HOST_PROTOCOL_CAPABILITIES)[number];

export interface HostEventFrame {
  type: "event";
  hostInstanceId: string;
  seq: number;
  event: UIEvent;
}

export interface HostReplayResult {
  hostInstanceId: string;
  events: HostEventFrame[];
  lastEventSeq: number;
  truncated: boolean;
}

export type HostSnapshot = EngineSnapshot & {
  hostInstanceId: string;
  lastEventSeq: number;
};

export interface HostRpcParams {
  cwd?: string;
  id?: string;
  name?: string;
  title?: string;
  sessionId?: string;
  target?: ExecutionTarget;
  expectedGeneration?: number;
  ownershipGeneration?: number;
  nonce?: string;
  engineRevision?: string;
  archive?: PortableSessionArchiveV1;
  archivePath?: string;
  provisional?: boolean;
  providerId?: "openai-codex" | "xai-oauth";
  authMethod?: "browser" | "device";
  authSessionId?: string;
  hostInstanceId?: string;
  afterSeq?: number;
  query?: string;
  limit?: number;
  atTurnId?: string;
}

/** Electron main → vibecodr-engine-host (mirrors macos-bridge protocol). */
export type HostInbound =
  | {
      op: "bootstrap";
      cwd: string;
      resume?: string;
      continue?: boolean;
      model?: string;
      mode?: "plan" | "execute" | "yolo";
      executionTarget?: ExecutionTarget;
      requiredModels?: string[];
      runtimeProfile?: {
        schemaVersion: 1;
        theme: string;
        accentColor?: string;
        details: "quiet" | "normal" | "verbose";
      };
      runtimeCredentials?: Record<string, string>;
    }
  | { op: "send"; command: EngineCommand }
  | {
      op: "rpc";
      id: number;
      method:
        | "snapshot"
        | "replayEvents"
        | "listModels"
        | "listProviders"
        | "listAgents"
        | "listSkills"
        | "listMcp"
        | "listPluginStatus"
        | "providerAuthStatus"
        | "beginProviderAuth"
        | "cancelProviderAuth"
        | "logoutProviderAuth"
        | "exportProviderAuth"
        | "finalize"
        | "listSessions"
        | "searchSessions"
        | "listProjects"
        | "renameProject"
        | "archiveProject"
        | "deleteProject"
        | "renameSession"
        | "deleteSession"
        | "archiveSession"
        | "forkSession"
        | "prepareHandoff"
        | "exportPortableSession"
        | "importPortableSession"
        | "commitPortableImport"
        | "abortPortableImport"
        | "recoverLostCloudOwnership"
        | "abortInterruptedHandoff"
        | "commitHandoff"
        | "abortHandoff";
      params?: HostRpcParams;
    }
  | { op: "shutdown" };

/** Host → Electron main. */
export type HostOutbound =
  | {
      type: "ready";
      protocolVersion: number;
      engineRevision: string;
      capabilities: string[];
      hostInstanceId: string;
      sessionId: string;
    }
  | HostEventFrame
  | { type: "resp"; id: number; ok: true; value: unknown }
  | { type: "resp"; id: number; ok: false; error: string }
  | { type: "fatal"; message: string };

export interface ProjectSessionSummary {
  id: string;
  title: string;
  model: string;
  mode: "plan" | "execute";
  goal: string | null;
  createdAt: number;
  updatedAt: number;
  latestTurnId?: string;
}

export interface SessionSearchHit {
  cwd: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  timestamp: number;
  snippet: string;
  score: number;
}

export type PluginContributionType = "tools" | "providers" | "commands" | "skills" | "hooks";

export interface PluginStatus {
  specifier: string;
  name: string;
  version?: string;
  status: "loaded" | "degraded" | "incompatible" | "failed";
  reason?: string;
  declaredContributions: PluginContributionType[];
  registeredContributions: Record<PluginContributionType, string[]>;
  provenance: {
    source: "npm" | "local";
    verified: boolean;
    packageVersion?: string;
    integrity?: string;
  };
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  updatedAt: number;
  sessions: ProjectSessionSummary[];
}

export type RpcMethod = Extract<HostInbound, { op: "rpc" }>["method"];

const RPC_METHODS = new Set<RpcMethod>([
  "snapshot", "replayEvents", "listModels", "listProviders", "listAgents", "listSkills", "listMcp", "listPluginStatus",
  "providerAuthStatus", "beginProviderAuth", "cancelProviderAuth", "logoutProviderAuth",
  "exportProviderAuth",
  "finalize", "listSessions", "searchSessions", "listProjects", "renameProject", "archiveProject", "deleteProject", "renameSession", "deleteSession", "archiveSession", "forkSession",
  "prepareHandoff", "exportPortableSession", "importPortableSession", "commitPortableImport", "abortPortableImport", "recoverLostCloudOwnership", "abortInterruptedHandoff", "commitHandoff", "abortHandoff",
]);

/** Exhaustive map — TypeScript fails compile if a command type is missing. */
const ENGINE_COMMAND_TYPE_MAP = {
  "submit-prompt": 1,
  "run-slash": 1,
  "set-mode": 1,
  "set-approvals": 1,
  "set-model": 1,
  "set-subagent-model": 1,
  "set-agent-model": 1,
  "create-agent": 1,
  "set-goal": 1,
  "resume-goal": 1,
  abort: 1,
  dequeue: 1,
  steer: 1,
  compact: 1,
  "request-runtime-handoff": 1,
  "resolve-external-capability": 1,
  "resolve-permission": 1,
  "resolve-plan": 1,
  "resolve-question": 1,
  "cancel-activity": 1,
  shutdown: 1,
} as const satisfies Record<EngineCommand["type"], 1>;

const ENGINE_COMMAND_TYPES = new Set<string>(Object.keys(ENGINE_COMMAND_TYPE_MAP));

/** Exhaustive map — TypeScript fails compile if a UIEvent type is missing. */
const UI_EVENT_TYPE_MAP = {
  "session-start": 1,
  "user-message": 1,
  "assistant-text-delta": 1,
  "reasoning-delta": 1,
  "tool-call-started": 1,
  "tool-call-progress": 1,
  "tool-call-finished": 1,
  "step-finished": 1,
  "usage-updated": 1,
  "context-updated": 1,
  "mode-changed": 1,
  "model-changed": 1,
  "goal-changed": 1,
  "goal-run": 1,
  "plan-state-changed": 1,
  "question-request": 1,
  "question-settled": 1,
  "activities-changed": 1,
  "theme-changed": 1,
  "accent-changed": 1,
  "details-changed": 1,
  "mouse-changed": 1,
  "git-updated": 1,
  "jobs-changed": 1,
  "approvals-changed": 1,
  "plan-presented": 1,
  "permission-request": 1,
  "permission-settled": 1,
  "tasks-updated": 1,
  "orchestration-task": 1,
  "queue-changed": 1,
  "file-changed": 1,
  "checkpoint-created": 1,
  "checkpoint-restored": 1,
  "verify-started": 1,
  "verify-finished": 1,
  compacted: 1,
  "runtime-handoff-requested": 1,
  "external-capability-pending": 1,
  "external-capability-resolved": 1,
  "subagent-started": 1,
  "subagent-activity": 1,
  "subagent-finished": 1,
  "loop-tick": 1,
  "loop-stopped": 1,
  notice: 1,
  "engine-error": 1,
  "turn-finished": 1,
  "turn-performance": 1,
  "session-idle": 1,
  "engine-idle": 1,
} as const satisfies Record<UIEvent["type"], 1>;

const UI_EVENT_TYPES = new Set<UIEvent["type"]>(
  Object.keys(UI_EVENT_TYPE_MAP) as UIEvent["type"][],
);

/** For unit tests: every UIEvent type is registered. */
export function listedUIEventTypes(): readonly UIEvent["type"][] {
  return Object.keys(UI_EVENT_TYPE_MAP) as UIEvent["type"][];
}

/** For unit tests: every EngineCommand type is registered. */
export function listedEngineCommandTypes(): readonly string[] {
  return Object.keys(ENGINE_COMMAND_TYPE_MAP);
}

const SESSION_EVENT_TYPES = new Set<UIEvent["type"]>([
  "session-start", "user-message", "assistant-text-delta", "reasoning-delta",
  "tool-call-started", "tool-call-progress", "tool-call-finished", "step-finished",
  "usage-updated", "context-updated", "mode-changed", "model-changed", "goal-changed",
  "goal-run", "plan-state-changed", "question-request", "question-settled", "activities-changed", "git-updated", "jobs-changed", "plan-presented", "permission-request",
  "permission-settled", "tasks-updated", "orchestration-task", "file-changed", "compacted",
  "subagent-started", "subagent-activity", "subagent-finished", "turn-finished",
  "turn-performance",
  "session-idle", "engine-idle",
  "runtime-handoff-requested", "external-capability-pending", "external-capability-resolved",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalRequiredModels(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value)
    && value.length > 0
    && value.length <= 32
    && value.every((model) => typeof model === "string" && model.length <= 512 && /^[^/\s]+\/\S+$/.test(model))
  );
}

function optionalRuntimeProfile(value: unknown): boolean {
  if (value === undefined) return true;
  const profile = record(value);
  return !!profile
    && profile.schemaVersion === 1
    && typeof profile.theme === "string"
    && profile.theme.length > 0
    && profile.theme.length <= 128
    && (profile.accentColor === undefined || typeof profile.accentColor === "string" && profile.accentColor.length <= 128)
    && (profile.details === "quiet" || profile.details === "normal" || profile.details === "verbose");
}

export const RUNTIME_IDENTIFIER_MAX_CHARS = 1_024;

/** IDs cross process boundaries and become Map/object/DOM keys. Reject empty,
 * oversized, or NUL-bearing values before they can enter long-lived state. */
export function isRuntimeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= RUNTIME_IDENTIFIER_MAX_CHARS
    && !value.includes("\0");
}

function optionalRuntimeIdentifier(value: unknown): boolean {
  return value === undefined || isRuntimeIdentifier(value);
}

function runtimeIdentifierArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRuntimeIdentifier);
}

function optionalRuntimeCredentials(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return false;
  let bytes = 0;
  for (const [name, val] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
    if (typeof val !== "string" || !val) return false;
    bytes += name.length + val.length;
    if (bytes > 256 * 1024) return false;
  }
  return true;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/** Retained from the locked bridge protocol; stricter telemetry validators
 * compose this baseline finite-number check with their domain constraints. */
function optionalNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return optionalNumber(value) && (value === undefined || nonNegativeNumber(value));
}

function optionalSafeNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function executionTarget(value: unknown): boolean {
  const target = record(value);
  return !!target && (target.kind === "local" || (target.kind === "cloud" && (target.provider === "e2b" || target.provider === "vercel")));
}

function portableArchive(value: unknown): boolean {
  const archive = record(value);
  return !!archive && archive.schemaVersion === 1 && isRuntimeIdentifier(archive.sessionId)
    && typeof archive.sourceRoot === "string" && typeof archive.sourceStateRoot === "string"
    && Number.isSafeInteger(archive.ownershipGeneration) && typeof archive.engineRevision === "string"
    && executionTarget(archive.executionTarget) && Array.isArray(archive.files)
    && typeof archive.archiveSha256 === "string";
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Deep nested UI payload checks (folded into isUIEvent so decodeOutbound is strict). */
function uiGitInfo(value: unknown): boolean {
  const git = record(value);
  return !!git
    && typeof git.branch === "string"
    && nonNegativeNumber(git.dirty)
    && nonNegativeNumber(git.ahead)
    && nonNegativeNumber(git.behind)
    && typeof git.worktree === "boolean";
}

function uiGoalRun(value: unknown): boolean {
  const run = record(value);
  return !!run
    && typeof run.active === "boolean"
    && (run.phase === null || run.phase === "plan" || run.phase === "execute")
    && nonNegativeNumber(run.round)
    && nonNegativeNumber(run.max)
    && (run.pausedReason === null || typeof run.pausedReason === "string")
    && typeof run.met === "boolean";
}

function uiJob(value: unknown): boolean {
  const item = record(value);
  return !!item
    && isRuntimeIdentifier(item.id)
    && typeof item.command === "string"
    && (item.status === "running" || item.status === "exited" || item.status === "killed")
    && (item.exitCode === null || Number.isFinite(item.exitCode))
    && (item.pid === undefined || (Number.isFinite(item.pid) && (item.pid as number) > 0))
    && stringArray(item.servers)
    && typeof item.outputTail === "string";
}

function uiTask(value: unknown): boolean {
  const item = record(value);
  return !!item
    && isRuntimeIdentifier(item.id)
    && typeof item.title === "string"
    && (item.status === "pending" || item.status === "in_progress" || item.status === "completed");
}

function uiQueuedItem(value: unknown): boolean {
  const item = record(value);
  return !!item && isRuntimeIdentifier(item.id) && typeof item.label === "string";
}

function uiPlanSource(value: unknown): boolean {
  const source = record(value);
  return !!source
    && typeof source.url === "string"
    && (source.title === undefined || typeof source.title === "string");
}

function sessionUsage(value: unknown): boolean {
  const usage = record(value);
  return !!usage && nonNegativeNumber(usage.inputTokens) && nonNegativeNumber(usage.outputTokens)
    && nonNegativeNumber(usage.totalTokens) && nonNegativeNumber(usage.costUSD)
    && optionalBoolean(usage.costEstimated)
    && optionalNonNegativeNumber(usage.cachedInputTokens);
}

function stepUsage(value: unknown): boolean {
  const usage = record(value);
  return !!usage
    && optionalNonNegativeNumber(usage.inputTokens)
    && optionalNonNegativeNumber(usage.outputTokens)
    && optionalNonNegativeNumber(usage.totalTokens)
    && optionalNonNegativeNumber(usage.cachedInputTokens);
}

function engineCommand(value: unknown): value is EngineCommand {
  const command = record(value);
  if (!command || typeof command.type !== "string" || !ENGINE_COMMAND_TYPES.has(command.type)) return false;
  switch (command.type) {
    case "submit-prompt": return typeof command.text === "string";
    case "run-slash": return typeof command.name === "string" && typeof command.args === "string";
    case "set-mode": return (command.mode === "plan" || command.mode === "execute") && optionalBoolean(command.start);
    case "set-approvals": return (command.mode === "ask" || command.mode === "auto") && optionalBoolean(command.quiet);
    case "set-model": return typeof command.model === "string";
    case "set-subagent-model": return command.model === null || typeof command.model === "string";
    case "set-agent-model": return typeof command.name === "string" && (command.model === null || typeof command.model === "string");
    case "create-agent": return typeof command.name === "string";
    case "set-goal": return command.goal === null || typeof command.goal === "string";
    case "dequeue":
    case "steer": return isRuntimeIdentifier(command.id);
    case "resolve-permission": return isRuntimeIdentifier(command.id) && ["once", "always", "always-project", "deny"].includes(String(command.decision)) && optionalString(command.feedback);
    case "resolve-plan": return ["accept", "edit", "keep-planning"].includes(String(command.decision)) && optionalString(command.edit) && (command.approvals === undefined || command.approvals === "auto");
    case "resolve-question": return isRuntimeIdentifier(command.id) && stringArray(command.answers) && optionalString(command.freeform);
    case "cancel-activity": return isRuntimeIdentifier(command.id);
    case "request-runtime-handoff": return executionTarget(command.target) && optionalString(command.instruction);
    case "resolve-external-capability": return isRuntimeIdentifier(command.id)
      && (command.decision === "approve" || command.decision === "deny") && optionalString(command.error);
    default: return true;
  }
}

export function isUIEvent(value: unknown): value is UIEvent {
  const event = record(value);
  if (!event || typeof event.type !== "string" || !UI_EVENT_TYPES.has(event.type as UIEvent["type"])) return false;
  if (SESSION_EVENT_TYPES.has(event.type as UIEvent["type"]) && !isRuntimeIdentifier(event.sessionId)) return false;
  switch (event.type) {
    case "session-start": return typeof event.model === "string" && (event.mode === "plan" || event.mode === "execute");
    case "user-message":
      return typeof event.text === "string"
        && (event.origin === undefined || event.origin === "user" || event.origin === "engine")
        && optionalString(event.label)
        && optionalRuntimeIdentifier(event.turnId);
    case "turn-performance": {
      const sample = record(event.sample);
      return !!sample && isRuntimeIdentifier(sample.turnId) && typeof sample.model === "string"
        && (sample.serviceTier === "default" || sample.serviceTier === "priority")
        && nonNegativeNumber(sample.totalMs);
    }
    case "assistant-text-delta":
    case "reasoning-delta": return typeof event.delta === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-started": return isRuntimeIdentifier(event.toolCallId) && typeof event.toolName === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-progress": return isRuntimeIdentifier(event.toolCallId) && typeof event.chunk === "string" && optionalRuntimeIdentifier(event.subagentId);
    case "tool-call-finished": return isRuntimeIdentifier(event.toolCallId) && typeof event.toolName === "string" && typeof event.isError === "boolean" && optionalRuntimeIdentifier(event.subagentId);
    case "step-finished": return event.usage === undefined || stepUsage(event.usage);
    case "usage-updated": return sessionUsage(event.usage);
    case "context-updated": return typeof event.usedTokens === "number"
      && Number.isFinite(event.usedTokens)
      && event.usedTokens >= 0
      && typeof event.contextWindow === "number"
      && Number.isFinite(event.contextWindow)
      && event.contextWindow > 0;
    case "mode-changed": return event.mode === "plan" || event.mode === "execute";
    case "model-changed": return typeof event.model === "string";
    case "goal-changed": return event.goal === null || typeof event.goal === "string";
    case "goal-run": return uiGoalRun(event.run);
    case "plan-state-changed": {
      const state = record(event.state);
      return !!state && ["inactive", "active", "pending", "exit_pending"].includes(String(state.status))
        && optionalString(state.plan)
        && (state.sources === undefined || (Array.isArray(state.sources) && state.sources.every(uiPlanSource)))
        && (state.assumptions === undefined || stringArray(state.assumptions))
        && optionalBoolean(state.ungrounded)
        && nonNegativeNumber(state.updatedAt);
    }
    case "question-request": {
      const question = record(event.question);
      return !!question && isRuntimeIdentifier(question.id) && typeof question.question === "string"
        && optionalString(question.header)
        && Array.isArray(question.choices) && question.choices.every((value) => {
          const choice = record(value);
          return !!choice && typeof choice.label === "string" && optionalString(choice.description);
        }) && typeof question.multiple === "boolean"
        && typeof question.allowFreeform === "boolean" && nonNegativeNumber(question.createdAt);
    }
    case "question-settled": return isRuntimeIdentifier(event.id) && ["answered", "aborted", "shutdown", "timeout"].includes(String(event.reason));
    case "activities-changed": return Array.isArray(event.activities) && event.activities.every((value) => {
      const activity = record(value);
      return !!activity && isRuntimeIdentifier(activity.id) && ["shell", "subagent", "tasks", "monitor"].includes(String(activity.kind))
        && typeof activity.label === "string" && ["queued", "running", "completed", "failed", "cancelled"].includes(String(activity.status))
        && optionalNonNegativeNumber(activity.startedAt) && optionalNonNegativeNumber(activity.finishedAt)
        && optionalString(activity.summary) && optionalString(activity.outputTail)
        && (activity.metrics === undefined || (() => {
          const metrics = record(activity.metrics);
          return !!metrics
            && optionalNonNegativeNumber(metrics.turns)
            && optionalNonNegativeNumber(metrics.toolCalls)
            && optionalNonNegativeNumber(metrics.inputTokens)
            && optionalNonNegativeNumber(metrics.outputTokens)
            && optionalNonNegativeNumber(metrics.contextTokens)
            && optionalNonNegativeNumber(metrics.contextWindow)
            && optionalNonNegativeNumber(metrics.errors);
        })());
    });
    case "theme-changed": return typeof event.theme === "string";
    case "accent-changed": return typeof event.accent === "string";
    case "details-changed": return event.details === "quiet" || event.details === "normal" || event.details === "verbose";
    case "mouse-changed": return typeof event.mouse === "boolean";
    case "git-updated": return uiGitInfo(event.git);
    case "jobs-changed": return Array.isArray(event.jobs) && event.jobs.every(uiJob);
    case "approvals-changed": return event.mode === "ask" || event.mode === "auto";
    case "plan-presented":
      return typeof event.plan === "string"
        && (event.sources === undefined || (Array.isArray(event.sources) && event.sources.every(uiPlanSource)))
        && (event.assumptions === undefined || stringArray(event.assumptions))
        && optionalBoolean(event.ungrounded);
    case "permission-request": return isRuntimeIdentifier(event.id) && typeof event.toolName === "string";
    case "permission-settled": return runtimeIdentifierArray(event.ids) && (event.reason === "aborted" || event.reason === "shutdown");
    case "tasks-updated": return Array.isArray(event.tasks) && event.tasks.every(uiTask);
    case "orchestration-task": return isRuntimeIdentifier(event.taskId) && typeof event.objective === "string" && ["running", "completed", "failed", "skipped"].includes(String(event.status)) && optionalNonNegativeNumber(event.attempts) && optionalNonNegativeNumber(event.durationMs);
    case "queue-changed":
      return (event.active === null || uiQueuedItem(event.active))
        && Array.isArray(event.pending)
        && event.pending.every(uiQueuedItem);
    case "notice": return (event.level === "info" || event.level === "warn" || event.level === "error") && typeof event.message === "string";
    case "engine-error": return typeof event.message === "string" && optionalRuntimeIdentifier(event.sessionId);
    case "file-changed": return isRuntimeIdentifier(event.toolCallId) && typeof event.path === "string" && (event.action === "edit" || event.action === "write") && typeof event.diff === "string" && nonNegativeNumber(event.added) && nonNegativeNumber(event.removed);
    case "checkpoint-created":
    case "checkpoint-restored": return isRuntimeIdentifier(event.id) && typeof event.label === "string";
    case "verify-started": return typeof event.command === "string";
    case "verify-finished": return typeof event.ok === "boolean" && typeof event.output === "string";
    case "compacted": return nonNegativeNumber(event.freedTokens);
    case "runtime-handoff-requested": return executionTarget(event.target) && optionalString(event.instruction);
    case "external-capability-pending": {
      const request = record(event.request);
      return !!request && isRuntimeIdentifier(request.id) && typeof request.integration === "string"
        && typeof request.toolName === "string" && isRuntimeIdentifier(request.originatingTurn)
        && nonNegativeNumber(request.createdAt);
    }
    case "external-capability-resolved": return isRuntimeIdentifier(event.id)
      && (event.status === "denied" || event.status === "resolved");
    case "subagent-started": return isRuntimeIdentifier(event.subagentId) && typeof event.prompt === "string";
    case "subagent-activity": return isRuntimeIdentifier(event.subagentId) && typeof event.label === "string";
    case "subagent-finished": return isRuntimeIdentifier(event.subagentId) && typeof event.result === "string";
    case "loop-tick": return isRuntimeIdentifier(event.loopId) && nonNegativeNumber(event.iteration);
    case "loop-stopped": return isRuntimeIdentifier(event.loopId) && typeof event.reason === "string";
    case "engine-idle": return event.gate === undefined || ["green", "red", "unverified", "aborted"].includes(String(event.gate));
    default: return true;
  }
}

export function decodeInbound(line: string): HostInbound | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const msg = record(value);
  if (!msg || typeof msg.op !== "string") return null;
  if (msg.op === "shutdown") return { op: "shutdown" };
  if (msg.op === "bootstrap") {
    if (typeof msg.cwd !== "string" || !msg.cwd.trim() || !optionalRuntimeIdentifier(msg.resume) || !optionalString(msg.model) || !optionalRequiredModels(msg.requiredModels) || !optionalRuntimeProfile(msg.runtimeProfile) || !optionalRuntimeCredentials(msg.runtimeCredentials) || (msg.executionTarget !== undefined && !executionTarget(msg.executionTarget))) return null;
    if (msg.continue !== undefined && typeof msg.continue !== "boolean") return null;
    if (msg.mode !== undefined && msg.mode !== "plan" && msg.mode !== "execute" && msg.mode !== "yolo") return null;
    return value as HostInbound;
  }
  if (msg.op === "send") {
    return engineCommand(msg.command)
      ? value as HostInbound
      : null;
  }
  if (msg.op === "rpc") {
    if (!Number.isSafeInteger(msg.id) || (msg.id as number) < 1 || typeof msg.method !== "string" || !RPC_METHODS.has(msg.method as RpcMethod)) return null;
    const params = msg.params === undefined ? null : record(msg.params);
    if (msg.params !== undefined && !params) return null;
    if (
      params &&
      (!optionalString(params.cwd) ||
        !optionalString(params.id) ||
        !optionalString(params.title) ||
        !optionalString(params.name) ||
        !optionalString(params.sessionId) ||
        !optionalString(params.nonce) ||
        !optionalString(params.engineRevision) ||
        !optionalString(params.archivePath) ||
        (params.providerId !== undefined && params.providerId !== "openai-codex" && params.providerId !== "xai-oauth") ||
        (params.authMethod !== undefined && params.authMethod !== "browser" && params.authMethod !== "device") ||
        !optionalString(params.authSessionId) ||
        !optionalString(params.hostInstanceId) ||
        !optionalString(params.query) ||
        !optionalString(params.atTurnId) ||
        !optionalSafeNonNegativeInteger(params.limit) ||
        !optionalSafeNonNegativeInteger(params.afterSeq) ||
        !optionalBoolean(params.provisional) ||
        !optionalSafeNonNegativeInteger(params.expectedGeneration) ||
        !optionalSafeNonNegativeInteger(params.ownershipGeneration) ||
        (params.target !== undefined && !executionTarget(params.target)) ||
        (params.archive !== undefined && !portableArchive(params.archive)))
    ) {
      return null;
    }
    if (params) {
      const allowed = new Set([
        "cwd", "id", "title", "name", "sessionId", "nonce", "engineRevision",
        "expectedGeneration", "ownershipGeneration", "target", "archive", "archivePath",
        "providerId", "authMethod", "authSessionId", "provisional", "hostInstanceId", "afterSeq",
        "query", "limit", "atTurnId",
      ]);
      if (Object.keys(params).some((key) => !allowed.has(key))) return null;
      if ((typeof params.cwd === "string" && (params.cwd.length > 32_768 || params.cwd.includes("\0")))
        || (typeof params.id === "string" && (params.id.length > 1_024 || params.id.includes("\0")))
        || (typeof params.title === "string" && params.title.length > 1_024)
        || (typeof params.name === "string" && params.name.length > 1_024)
        || (typeof params.sessionId === "string" && (params.sessionId.length > 1_024 || params.sessionId.includes("\0")))
        || (typeof params.nonce === "string" && params.nonce.length > 1_024)
        || (typeof params.engineRevision === "string" && params.engineRevision.length > 256)
        || (typeof params.query === "string" && params.query.length > 512)
        || (typeof params.atTurnId === "string" && params.atTurnId.length > 1_024)
        || (typeof params.archivePath === "string" && (params.archivePath.length > 32_768 || params.archivePath.includes("\0")))) return null;
    }
    return value as HostInbound;
  }
  return null;
}

export function encodeInbound(msg: HostInbound): string {
  return `${JSON.stringify(msg)}\n`;
}

/** The host rejects lines above 1,000,000 characters. A byte ceiling below
 * that boundary is safe for both ASCII and multibyte JSON payloads. */
export const HOST_INBOUND_SAFE_BYTES = 900_000;

export function encodedEngineCommandBytes(command: EngineCommand): number {
  return new TextEncoder().encode(encodeInbound({ op: "send", command })).byteLength;
}

export function decodeOutbound(line: string): HostOutbound | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const msg = record(value);
  if (!msg || typeof msg.type !== "string") return null;
  if (msg.type === "ready") return Number.isSafeInteger(msg.protocolVersion) && (msg.protocolVersion as number) > 0
    && typeof msg.engineRevision === "string" && msg.engineRevision.length > 0
    && Array.isArray(msg.capabilities) && msg.capabilities.length <= 64
    && msg.capabilities.every((capability) => typeof capability === "string" && capability.length > 0 && capability.length <= 128)
    && isRuntimeIdentifier(msg.hostInstanceId) && isRuntimeIdentifier(msg.sessionId)
    ? value as HostOutbound
    : null;
  if (msg.type === "event") return isRuntimeIdentifier(msg.hostInstanceId)
    && Number.isSafeInteger(msg.seq) && (msg.seq as number) > 0
    && isUIEvent(msg.event)
    ? value as HostOutbound
    : null;
  if (msg.type === "fatal") return typeof msg.message === "string" ? value as HostOutbound : null;
  if (msg.type === "resp") {
    if (!Number.isSafeInteger(msg.id) || (msg.id as number) < 1 || typeof msg.ok !== "boolean") return null;
    return msg.ok || typeof msg.error === "string" ? value as HostOutbound : null;
  }
  return null;
}
