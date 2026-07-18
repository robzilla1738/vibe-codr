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
  GoalRunInfo,
  JobInfo,
  ModelSummary,
  ProviderInfo,
  AgentInfo,
  AgentCapability,
  SkillInfo,
  GoalContract,
  PlanState,
  QuestionChoice,
  StructuredQuestion,
  ActivityInfo,
} from "./types.ts";

// UI events (engine -> UI)
export type { TurnPerformanceSample, UIEvent, UIEventType } from "./events.ts";

export type {
  ExecutionTarget,
  CloudSessionStatus,
  PendingCapabilityRequest,
  PortableSessionFileV1,
  PortableSessionArchiveV1,
  HandoffPreparation,
} from "./handoff.ts";

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
  PlanGateVerdict,
  FreshnessRegistryLike,
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

// Stream reading + truncation
export type { KeepPolicy, CapOptions } from "./stream.ts";
export {
  CappedText,
  omittedMarker,
  drainTextStream,
  makeYieldGate,
  readCappedText,
  capText,
  readCappedBytes,
} from "./stream.ts";

// Theme + accent registry (shared across the core/TUI boundary — data only)
export { THEME_NAMES, ACCENT_PRESETS, ACCENT_NAMES } from "./theme-registry.ts";

// Build intelligence (deterministic recon / checks / gate / handoffs)
export type {
  CodeCommands,
  CheckName,
  RepoProfile,
  CheckSignal,
  GateSummary,
  Handoff,
  StubFinding,
} from "./build.ts";
