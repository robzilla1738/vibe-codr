import type { ZodType } from "zod";
import type { UIEvent } from "./events.ts";
import type { Mode } from "./types.ts";

/**
 * A JSON Schema object (draft-07-ish). Used by bridged tools (e.g. MCP) whose
 * input shape is only known at runtime; the tools layer wraps it for the AI SDK.
 * Kept structural so `@vibe/shared` stays dependency-light.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Result of a permission check for a side-effecting tool call. */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/** Evaluates whether a side-effecting tool call may proceed. `fallback`
 * overrides the unmatched-rule default (network read-only tools default to
 * allow instead of the interactive approvalMode). */
export type CheckPermission = (
  toolName: string,
  input: unknown,
  opts?: { fallback?: "allow" | "deny" | "ask" },
) => Promise<PermissionResult> | PermissionResult;

/** Runtime context handed to a tool's `execute`. */
export interface ToolContext {
  /** Working directory for the session. */
  cwd: string;
  sessionId: string;
  /** Aborted when the user cancels the turn or the parent session aborts. */
  abortSignal: AbortSignal;
  /** Emit a UI event (e.g. streamed bash output via `tool-call-progress`). */
  emit: (event: UIEvent) => void;
  /** Tool-call id assigned by the model, for progress correlation. */
  toolCallId: string;
  /**
   * Serialize the read-modify-write of a single absolute path across the whole
   * session tree, so two concurrent subagents can never corrupt the same file
   * (writes to different paths still run in parallel). Optional: undefined in
   * unit tests, where the tool runs its mutation directly.
   */
  lockFile?: <T>(absPath: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Compiler diagnostics for a just-mutated file (set by core when a language
   * service is available). edit/write append the result to their output so the
   * model sees "you broke the types" in the SAME step. Returns undefined when
   * the file is clean or diagnostics don't apply.
   */
  diagnose?: (absPath: string) => Promise<string | undefined>;
}

/** Result returned by a tool execution. */
export interface ToolResult {
  /** Human/model-readable output. Objects are JSON-serialized by the engine. */
  output: string | Record<string, unknown>;
  isError?: boolean;
}

/**
 * The canonical, framework-agnostic tool contract. `@vibe/tools` adapts these
 * into AI-SDK `tool()` objects at toolset-construction time. `readOnly` drives
 * plan-mode gating; `concurrencySafe` drives the dispatcher's parallel/serial
 * scheduling.
 */
// Default to `any` (not `unknown`) so heterogeneous tools with specific input
// types remain assignable to `ToolDefinition[]` despite parameter contravariance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<Input = any> {
  name: string;
  description: string;
  /** A Zod type (built-ins) or a raw JSON Schema (bridged/MCP tools). */
  inputSchema: ZodType<Input> | JsonSchema;
  readOnly: boolean;
  concurrencySafe?: boolean;
  /** The tool reaches the NETWORK (webfetch/web_search/…). Read-only network
   * tools skip the interactive approval prompt (their default is allow) but,
   * unlike pure local reads, they DO consult the permission rules — so a
   * `{tool:"webfetch", action:"deny"}` policy can actually govern egress. */
  network?: boolean;
  /** If set, the tool is only available in these modes (default: all). */
  modes?: Mode[];
  execute: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}
