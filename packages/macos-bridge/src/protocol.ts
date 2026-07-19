import type {
  EngineCommand,
  EngineSnapshot,
  ExecutionTarget,
  PortableSessionArchiveV1,
  UIEvent,
} from "@vibe/shared";

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

/** Desktop client → Bun */
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

/** Bun → desktop client */
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

export interface ProjectSummary {
  cwd: string;
  name: string;
  updatedAt: number;
  sessions: ProjectSessionSummary[];
}

export type RpcMethod = Extract<HostInbound, { op: "rpc" }>["method"];

const RPC_METHODS = new Set<RpcMethod>([
  "snapshot",
  "replayEvents",
  "listModels",
  "listProviders",
  "listAgents",
  "listSkills",
  "listMcp",
  "listPluginStatus",
  "providerAuthStatus",
  "beginProviderAuth",
  "cancelProviderAuth",
  "logoutProviderAuth",
  "exportProviderAuth",
  "finalize",
  "listSessions",
  "searchSessions",
  "listProjects",
  "renameProject",
  "archiveProject",
  "deleteProject",
  "renameSession",
  "deleteSession",
  "archiveSession",
  "forkSession",
  "prepareHandoff",
  "exportPortableSession",
  "importPortableSession",
  "commitPortableImport",
  "abortPortableImport",
  "recoverLostCloudOwnership",
  "abortInterruptedHandoff",
  "commitHandoff",
  "abortHandoff",
]);

const ENGINE_COMMAND_TYPES = new Set([
  "submit-prompt",
  "run-slash",
  "set-mode",
  "set-approvals",
  "set-model",
  "set-subagent-model",
  "set-agent-model",
  "create-agent",
  "set-goal",
  "resume-goal",
  "abort",
  "dequeue",
  "steer",
  "compact",
  "request-runtime-handoff",
  "resolve-external-capability",
  "resolve-permission",
  "resolve-plan",
  "shutdown",
]);

const UI_EVENT_TYPES = new Set<UIEvent["type"]>([
  "session-start",
  "user-message",
  "assistant-text-delta",
  "reasoning-delta",
  "tool-call-started",
  "tool-call-progress",
  "tool-call-finished",
  "step-finished",
  "usage-updated",
  "context-updated",
  "mode-changed",
  "model-changed",
  "goal-changed",
  "goal-run",
  "theme-changed",
  "accent-changed",
  "details-changed",
  "mouse-changed",
  "git-updated",
  "jobs-changed",
  "approvals-changed",
  "plan-presented",
  "permission-request",
  "permission-settled",
  "tasks-updated",
  "orchestration-task",
  "queue-changed",
  "file-changed",
  "checkpoint-created",
  "checkpoint-restored",
  "verify-started",
  "verify-finished",
  "compacted",
  "runtime-handoff-requested",
  "external-capability-pending",
  "external-capability-resolved",
  "subagent-started",
  "subagent-activity",
  "subagent-finished",
  "loop-tick",
  "loop-stopped",
  "notice",
  "engine-error",
  "turn-finished",
  "turn-performance",
  "session-idle",
  "engine-idle",
]);

const SESSION_EVENT_TYPES = new Set<UIEvent["type"]>([
  "session-start",
  "user-message",
  "assistant-text-delta",
  "reasoning-delta",
  "tool-call-started",
  "tool-call-progress",
  "tool-call-finished",
  "step-finished",
  "usage-updated",
  "context-updated",
  "mode-changed",
  "model-changed",
  "goal-changed",
  "goal-run",
  "git-updated",
  "jobs-changed",
  "plan-presented",
  "permission-request",
  "permission-settled",
  "tasks-updated",
  "orchestration-task",
  "file-changed",
  "compacted",
  "subagent-started",
  "subagent-activity",
  "subagent-finished",
  "turn-finished",
  "turn-performance",
  "session-idle",
  "engine-idle",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

function optionalNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

function optionalSafeNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function executionTarget(value: unknown): boolean {
  const target = record(value);
  return (
    !!target &&
    (target.kind === "local" ||
      (target.kind === "cloud" && (target.provider === "e2b" || target.provider === "vercel")))
  );
}

function portableArchive(value: unknown): boolean {
  const archive = record(value);
  return (
    !!archive &&
    archive.schemaVersion === 1 &&
    typeof archive.sessionId === "string" &&
    typeof archive.sourceRoot === "string" &&
    typeof archive.sourceStateRoot === "string" &&
    Number.isSafeInteger(archive.ownershipGeneration) &&
    typeof archive.engineRevision === "string" &&
    executionTarget(archive.executionTarget) &&
    Array.isArray(archive.files) &&
    typeof archive.archiveSha256 === "string"
  );
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sessionUsage(value: unknown): boolean {
  const usage = record(value);
  return (
    !!usage &&
    Number.isFinite(usage.inputTokens) &&
    Number.isFinite(usage.outputTokens) &&
    Number.isFinite(usage.totalTokens) &&
    Number.isFinite(usage.costUSD)
  );
}

function engineCommand(value: unknown): value is EngineCommand {
  const command = record(value);
  if (!command || typeof command.type !== "string" || !ENGINE_COMMAND_TYPES.has(command.type))
    return false;
  switch (command.type) {
    case "submit-prompt":
      return typeof command.text === "string";
    case "run-slash":
      return typeof command.name === "string" && typeof command.args === "string";
    case "set-mode":
      return (
        (command.mode === "plan" || command.mode === "execute") && optionalBoolean(command.start)
      );
    case "set-approvals":
      return (command.mode === "ask" || command.mode === "auto") && optionalBoolean(command.quiet);
    case "set-model":
      return typeof command.model === "string";
    case "set-subagent-model":
      return command.model === null || typeof command.model === "string";
    case "set-agent-model":
      return (
        typeof command.name === "string" &&
        (command.model === null || typeof command.model === "string")
      );
    case "create-agent":
      return typeof command.name === "string";
    case "set-goal":
      return command.goal === null || typeof command.goal === "string";
    case "dequeue":
    case "steer":
      return typeof command.id === "string";
    case "resolve-permission":
      return (
        typeof command.id === "string" &&
        ["once", "always", "always-project", "deny"].includes(String(command.decision)) &&
        optionalString(command.feedback)
      );
    case "resolve-plan":
      return (
        ["accept", "edit", "keep-planning"].includes(String(command.decision)) &&
        optionalString(command.edit) &&
        (command.approvals === undefined || command.approvals === "auto")
      );
    case "request-runtime-handoff":
      return executionTarget(command.target) && optionalString(command.instruction);
    case "resolve-external-capability":
      return (
        typeof command.id === "string" &&
        (command.decision === "approve" || command.decision === "deny") &&
        optionalString(command.error)
      );
    default:
      return true;
  }
}

export function isUIEvent(value: unknown): value is UIEvent {
  const event = record(value);
  if (
    !event ||
    typeof event.type !== "string" ||
    !UI_EVENT_TYPES.has(event.type as UIEvent["type"])
  )
    return false;
  if (SESSION_EVENT_TYPES.has(event.type as UIEvent["type"]) && typeof event.sessionId !== "string")
    return false;
  switch (event.type) {
    case "session-start":
      return typeof event.model === "string" && (event.mode === "plan" || event.mode === "execute");
    case "user-message":
      return (
        typeof event.text === "string" &&
        (event.origin === undefined || event.origin === "user" || event.origin === "engine") &&
        optionalString(event.label) &&
        optionalString(event.turnId)
      );
    case "turn-performance": {
      const sample = record(event.sample);
      return (
        !!sample &&
        typeof sample.turnId === "string" &&
        typeof sample.model === "string" &&
        (sample.serviceTier === "default" || sample.serviceTier === "priority") &&
        typeof sample.totalMs === "number" &&
        Number.isFinite(sample.totalMs)
      );
    }
    case "assistant-text-delta":
    case "reasoning-delta":
      return typeof event.delta === "string" && optionalString(event.subagentId);
    case "tool-call-started":
      return (
        typeof event.toolCallId === "string" &&
        typeof event.toolName === "string" &&
        optionalString(event.subagentId)
      );
    case "tool-call-progress":
      return (
        typeof event.toolCallId === "string" &&
        typeof event.chunk === "string" &&
        optionalString(event.subagentId)
      );
    case "tool-call-finished":
      return (
        typeof event.toolCallId === "string" &&
        typeof event.toolName === "string" &&
        typeof event.isError === "boolean" &&
        optionalString(event.subagentId)
      );
    case "step-finished":
      return event.usage === undefined || record(event.usage) !== null;
    case "usage-updated":
      return sessionUsage(event.usage);
    case "context-updated":
      return Number.isFinite(event.usedTokens) && Number.isFinite(event.contextWindow);
    case "mode-changed":
      return event.mode === "plan" || event.mode === "execute";
    case "model-changed":
      return typeof event.model === "string";
    case "goal-changed":
      return event.goal === null || typeof event.goal === "string";
    case "goal-run":
      return record(event.run) !== null;
    case "theme-changed":
      return typeof event.theme === "string";
    case "accent-changed":
      return typeof event.accent === "string";
    case "details-changed":
      return event.details === "quiet" || event.details === "normal" || event.details === "verbose";
    case "mouse-changed":
      return typeof event.mouse === "boolean";
    case "git-updated":
      return record(event.git) !== null;
    case "jobs-changed":
      return Array.isArray(event.jobs);
    case "approvals-changed":
      return event.mode === "ask" || event.mode === "auto";
    case "plan-presented":
      return (
        typeof event.plan === "string" &&
        (event.sources === undefined || Array.isArray(event.sources)) &&
        (event.assumptions === undefined || stringArray(event.assumptions)) &&
        optionalBoolean(event.ungrounded)
      );
    case "permission-request":
      return typeof event.id === "string" && typeof event.toolName === "string";
    case "permission-settled":
      return stringArray(event.ids) && (event.reason === "aborted" || event.reason === "shutdown");
    case "tasks-updated":
      return Array.isArray(event.tasks);
    case "orchestration-task":
      return (
        typeof event.taskId === "string" &&
        typeof event.objective === "string" &&
        ["running", "completed", "failed", "skipped"].includes(String(event.status)) &&
        optionalNumber(event.attempts) &&
        optionalNumber(event.durationMs)
      );
    case "queue-changed":
      return (
        (event.active === null || record(event.active) !== null) && Array.isArray(event.pending)
      );
    case "notice":
      return (
        (event.level === "info" || event.level === "warn" || event.level === "error") &&
        typeof event.message === "string"
      );
    case "engine-error":
      return typeof event.message === "string" && optionalString(event.sessionId);
    case "file-changed":
      return (
        typeof event.toolCallId === "string" &&
        typeof event.path === "string" &&
        (event.action === "edit" || event.action === "write") &&
        typeof event.diff === "string" &&
        Number.isFinite(event.added) &&
        Number.isFinite(event.removed)
      );
    case "checkpoint-created":
    case "checkpoint-restored":
      return typeof event.id === "string" && typeof event.label === "string";
    case "verify-started":
      return typeof event.command === "string";
    case "verify-finished":
      return typeof event.ok === "boolean" && typeof event.output === "string";
    case "compacted":
      return Number.isFinite(event.freedTokens);
    case "runtime-handoff-requested":
      return (
        typeof event.sessionId === "string" &&
        executionTarget(event.target) &&
        optionalString(event.instruction)
      );
    case "external-capability-pending": {
      const request = record(event.request);
      return (
        typeof event.sessionId === "string" &&
        !!request &&
        typeof request.id === "string" &&
        typeof request.integration === "string" &&
        typeof request.toolName === "string" &&
        typeof request.originatingTurn === "string" &&
        Number.isFinite(request.createdAt)
      );
    }
    case "external-capability-resolved":
      return (
        typeof event.sessionId === "string" &&
        typeof event.id === "string" &&
        (event.status === "denied" || event.status === "resolved")
      );
    case "subagent-started":
      return typeof event.subagentId === "string" && typeof event.prompt === "string";
    case "subagent-activity":
      return typeof event.subagentId === "string" && typeof event.label === "string";
    case "subagent-finished":
      return typeof event.subagentId === "string" && typeof event.result === "string";
    case "loop-tick":
      return typeof event.loopId === "string" && Number.isFinite(event.iteration);
    case "loop-stopped":
      return typeof event.loopId === "string" && typeof event.reason === "string";
    case "engine-idle":
      return (
        event.gate === undefined ||
        ["green", "red", "unverified", "aborted"].includes(String(event.gate))
      );
    default:
      return true;
  }
}

export function decodeInbound(line: string): HostInbound | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = record(value);
  if (!msg || typeof msg.op !== "string") return null;
  if (msg.op === "shutdown") return { op: "shutdown" };
  if (msg.op === "bootstrap") {
    if (
      typeof msg.cwd !== "string" ||
      !msg.cwd.trim() ||
      !optionalString(msg.resume) ||
      !optionalString(msg.model) ||
      !optionalRequiredModels(msg.requiredModels) ||
      !optionalRuntimeProfile(msg.runtimeProfile) ||
      !optionalRuntimeCredentials(msg.runtimeCredentials) ||
      (msg.executionTarget !== undefined && !executionTarget(msg.executionTarget))
    )
      return null;
    if (msg.continue !== undefined && typeof msg.continue !== "boolean") return null;
    if (
      msg.mode !== undefined &&
      msg.mode !== "plan" &&
      msg.mode !== "execute" &&
      msg.mode !== "yolo"
    )
      return null;
    return value as HostInbound;
  }
  if (msg.op === "send") {
    return engineCommand(msg.command) ? (value as HostInbound) : null;
  }
  if (msg.op === "rpc") {
    if (
      !Number.isSafeInteger(msg.id) ||
      (msg.id as number) < 1 ||
      typeof msg.method !== "string" ||
      !RPC_METHODS.has(msg.method as RpcMethod)
    )
      return null;
    const params = msg.params === undefined ? null : record(msg.params);
    if (msg.params !== undefined && !params) return null;
    if (
      params &&
      (!optionalString(params.cwd) ||
        !optionalString(params.id) ||
        !optionalString(params.name) ||
        !optionalString(params.title) ||
        !optionalString(params.sessionId) ||
        !optionalString(params.nonce) ||
        !optionalString(params.engineRevision) ||
        !optionalString(params.archivePath) ||
        (params.providerId !== undefined &&
          params.providerId !== "openai-codex" &&
          params.providerId !== "xai-oauth") ||
        (params.authMethod !== undefined &&
          params.authMethod !== "browser" &&
          params.authMethod !== "device") ||
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
    )
      return null;
    if (params) {
      const allowed = new Set([
        "cwd", "id", "name", "title", "sessionId", "target", "expectedGeneration",
        "ownershipGeneration", "nonce", "engineRevision", "archive", "archivePath",
        "provisional", "providerId", "authMethod", "authSessionId", "hostInstanceId",
        "afterSeq", "query", "limit", "atTurnId",
      ]);
      if (Object.keys(params).some((key) => !allowed.has(key))) return null;
    }
    return value as HostInbound;
  }
  return null;
}

export function decodeOutbound(line: string): HostOutbound | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = record(value);
  if (!msg || typeof msg.type !== "string") return null;
  if (msg.type === "ready")
    return Number.isSafeInteger(msg.protocolVersion) && (msg.protocolVersion as number) > 0 &&
      typeof msg.engineRevision === "string" && msg.engineRevision.length > 0 &&
      Array.isArray(msg.capabilities) && msg.capabilities.length <= 64 &&
      msg.capabilities.every((capability) => typeof capability === "string" && capability.length > 0 && capability.length <= 128) &&
      typeof msg.hostInstanceId === "string" && msg.hostInstanceId.length > 0 &&
      typeof msg.sessionId === "string" && msg.sessionId.length > 0
      ? (value as HostOutbound)
      : null;
  if (msg.type === "event") return typeof msg.hostInstanceId === "string" && msg.hostInstanceId.length > 0 &&
    Number.isSafeInteger(msg.seq) && (msg.seq as number) > 0 && isUIEvent(msg.event)
    ? (value as HostOutbound)
    : null;
  if (msg.type === "fatal") return typeof msg.message === "string" ? (value as HostOutbound) : null;
  if (msg.type === "resp") {
    if (!Number.isSafeInteger(msg.id) || (msg.id as number) < 1 || typeof msg.ok !== "boolean")
      return null;
    return msg.ok || typeof msg.error === "string" ? (value as HostOutbound) : null;
  }
  return null;
}
