import type { ZodType } from "zod";
import type { UIEvent } from "./events.ts";

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
  inputSchema: ZodType<Input>;
  readOnly: boolean;
  concurrencySafe?: boolean;
  execute: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}
