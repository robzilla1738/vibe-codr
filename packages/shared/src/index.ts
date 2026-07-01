// Domain types
export type {
  Mode,
  Role,
  Part,
  Usage,
  Message,
  Task,
  TaskStatus,
  QueuedItem,
  SessionUsage,
  EngineSnapshot,
  GitInfo,
  JobInfo,
  ModelSummary,
  ProviderInfo,
} from "./types.ts";

// UI events (engine -> UI)
export type { UIEvent, UIEventType } from "./events.ts";

// Engine commands (UI -> engine) + client contract
export type {
  EngineCommand,
  EngineCommandType,
  EngineClient,
} from "./commands.ts";

// Tool contract
export type {
  ToolContext,
  ToolResult,
  ToolDefinition,
  JsonSchema,
  PermissionResult,
  CheckPermission,
} from "./tool.ts";

// Errors
export {
  VibeError,
  ModelResolutionError,
  ProviderAuthError,
  PlanModeViolationError,
  PermissionDeniedError,
  ConfigError,
} from "./errors.ts";

// Logger
export type { Logger, LogLevel } from "./logger.ts";
export { createLogger } from "./logger.ts";

// Utilities
export { createId } from "./id.ts";
export { AsyncQueue } from "./async-queue.ts";
