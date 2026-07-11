import type { EngineCommand, UIEvent } from "@vibe/shared";

/** Desktop client → Bun */
export type HostInbound =
  | {
      op: "bootstrap";
      cwd: string;
      resume?: string;
      continue?: boolean;
      model?: string;
      mode?: "plan" | "execute" | "yolo";
    }
  | { op: "send"; command: EngineCommand }
  | {
      op: "rpc";
      id: number;
      method:
        | "snapshot"
        | "listModels"
        | "listProviders"
        | "listAgents"
        | "listSkills"
        | "listMcp"
        | "finalize"
        | "listSessions"
        | "listProjects"
        | "renameSession"
        | "deleteSession"
        | "archiveSession";
      params?: {
        cwd?: string;
        id?: string;
        title?: string;
      };
    }
  | { op: "shutdown" };

/** Bun → desktop client */
export type HostOutbound =
  | { type: "ready"; sessionId: string }
  | { type: "event"; event: UIEvent }
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
  "listModels",
  "listProviders",
  "listAgents",
  "listSkills",
  "listMcp",
  "finalize",
  "listSessions",
  "listProjects",
  "renameSession",
  "deleteSession",
  "archiveSession",
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
  "subagent-started",
  "subagent-activity",
  "subagent-finished",
  "loop-tick",
  "loop-stopped",
  "notice",
  "engine-error",
  "turn-finished",
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

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
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
      return typeof event.text === "string";
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
      !optionalString(msg.model)
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
      (!optionalString(params.cwd) || !optionalString(params.id) || !optionalString(params.title))
    )
      return null;
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
    return typeof msg.sessionId === "string" && msg.sessionId ? (value as HostOutbound) : null;
  if (msg.type === "event") return isUIEvent(msg.event) ? (value as HostOutbound) : null;
  if (msg.type === "fatal") return typeof msg.message === "string" ? (value as HostOutbound) : null;
  if (msg.type === "resp") {
    if (!Number.isSafeInteger(msg.id) || (msg.id as number) < 1 || typeof msg.ok !== "boolean")
      return null;
    return msg.ok || typeof msg.error === "string" ? (value as HostOutbound) : null;
  }
  return null;
}
