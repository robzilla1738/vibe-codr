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
  /**
   * Plan-readiness gate (set by core in plan mode). `present_plan` consults it
   * before surfacing a plan: a triage of the user's request decides what
   * research the plan must be grounded in, and the session's observed research
   * telemetry decides whether that happened. A rejection re-enters the loop
   * with concrete instructions; after the rejection budget is spent the plan is
   * allowed through with `ungrounded: true` so the UI can warn instead of the
   * model deadlocking.
   */
  planGate?: (plan: {
    plan?: string;
    sources?: { url: string }[];
    assumptions?: string[];
    files?: string[];
    verification?: string;
    decisions?: string[];
  }) => PlanGateVerdict;
  /**
   * Tree-global stale-write guard (one per Session tree, set by core on the
   * engine-owned instance). Used by `read`/`edit`/`write` to record the
   * mtime of every file the tree has read and refuse a later mutation whose
   * disk mtime has moved past the recorded baseline. Required: the engine
   * always provides one per Session tree, and unit tests must construct their
   * own `FreshnessRegistry` (no module-level singleton — that was the bug2.md
   * C-3 leak). Declared structurally so `@vibe/shared` doesn't pull in
   * `@vibe/tools`; the implementation lives in `FreshnessRegistry`
   * (`packages/tools/src/builtins/freshness.ts`).
   */
  freshness: FreshnessRegistryLike;
}

/** Structural shape the tools layer needs from the freshness registry. The
 * concrete class (`FreshnessRegistry` in `@vibe/tools/builtins/freshness`)
 * is the only implementation but it isn't imported here to keep the
 * `@vibe/shared` boundary clean of `@vibe/tools`. `clearSession` is called
 * by core on child settle so the per-tree footprint stays bounded by active
 * sessions, not lifetime. */
export interface FreshnessRegistryLike {
  recordRead(sessionId: string, absPath: string): void;
  recordWrite(sessionId: string, absPath: string): void;
  assertFresh(sessionId: string, absPath: string): { stale: boolean; ageMs?: number };
  clearSession(sessionId: string): void;
}

/** Verdict from the plan-readiness gate (see {@link ToolContext.planGate}). */
export interface PlanGateVerdict {
  allow: boolean;
  /** When rejected: exactly what research is missing, model-facing. */
  reason?: string;
  /** Allowed only because the rejection budget ran out — research never happened. */
  ungrounded?: boolean;
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
