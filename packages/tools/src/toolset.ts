import { tool, jsonSchema, type Tool } from "ai";
import type { ZodType } from "zod";
import type {
  CheckPermission,
  Mode,
  ToolContext,
  ToolDefinition,
} from "@vibe/shared";
import { builtinTools } from "./builtins/index.ts";

/** Zod schemas expose `.parse`; raw JSON Schema objects don't. */
function isZodSchema(s: unknown): boolean {
  return typeof (s as { parse?: unknown })?.parse === "function";
}

/** The session-scoped parts of a ToolContext supplied by the engine. */
export type ToolRuntimeBase = Pick<ToolContext, "cwd" | "sessionId" | "emit"> & {
  /** Optional gate for side-effecting tools (allow/deny/ask). */
  checkPermission?: CheckPermission;
  /** Plugin hook fired before a tool runs; may veto it (deny + reason). */
  beforeTool?: (
    toolName: string,
    input: unknown,
  ) => Promise<{ deny?: boolean; reason?: string }>;
  /** Plugin hook fired after a tool produces output. */
  afterTool?: (toolName: string, output: unknown) => void | Promise<void>;
};

/**
 * Holds tool definitions and produces the AI-SDK tool map for a given mode.
 * Plan mode exposes only read-only tools, so the model literally cannot emit a
 * side-effecting tool call while planning.
 */
export class Toolset {
  #tools = new Map<string, ToolDefinition>();
  /** Names of the trusted built-in tools — never let an extension shadow these. */
  #builtins = new Set<string>();
  /** Optional sink for collision warnings (engine wires it to a UI notice). */
  onConflict?: (message: string) => void;

  constructor(defs: ToolDefinition[] = builtinTools()) {
    for (const def of defs) this.register(def, true);
  }

  /**
   * Register a tool. Tools registered at construction are "built-in" and trusted;
   * later registrations (MCP servers, plugins) must not shadow a built-in — an
   * MCP tool named `bash`/`edit` could otherwise silently hijack a core tool.
   */
  register(def: ToolDefinition, builtin = false): void {
    if (builtin) {
      this.#builtins.add(def.name);
    } else if (this.#builtins.has(def.name)) {
      this.onConflict?.(
        `Ignored extension tool "${def.name}": it collides with a built-in tool.`,
      );
      return;
    } else if (this.#tools.has(def.name)) {
      this.onConflict?.(
        `Tool "${def.name}" is registered more than once; the later one wins.`,
      );
    }
    this.#tools.set(def.name, def);
  }

  all(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** Tools permitted in `mode`. Plan mode -> read-only only; respects `modes`. */
  forMode(mode: Mode): ToolDefinition[] {
    return this.all().filter((t) => {
      if (t.modes && !t.modes.includes(mode)) return false;
      if (mode === "plan" && !t.readOnly) return false;
      return true;
    });
  }

  /** Names permitted in `mode` (for AI-SDK `activeTools`). */
  names(mode: Mode): string[] {
    return this.forMode(mode).map((t) => t.name);
  }

  /** Build the AI-SDK `tools` map for `mode`, bound to the session context. */
  aiTools(mode: Mode, base: ToolRuntimeBase): Record<string, Tool> {
    // One lock shared by every tool built here, so non-concurrency-safe tools
    // (edit/write/bash/git/…) run one-at-a-time even when the model emits them as
    // parallel calls within a single step (the AI SDK runs a step's tool calls
    // via Promise.all — without this, two edits to the same file would race and
    // silently drop one). Read-only / concurrency-safe tools still run freely.
    const serialize = createSerialLock();
    const map: Record<string, Tool> = {};
    for (const def of this.forMode(mode)) {
      map[def.name] = toAISDKTool(def, base, serialize);
    }
    return map;
  }
}

/** A tool is safe to run in parallel if it's read-only or explicitly marked so. */
export function isConcurrencySafe(def: ToolDefinition): boolean {
  return def.concurrencySafe === true || def.readOnly === true;
}

/**
 * A FIFO async lock: `run(fn)` executes `fn` only after every previously-queued
 * `fn` has settled. Used to serialize mutating tool calls within a step.
 */
export function createSerialLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    // Advance the chain to this task's settlement, swallowing errors so one
    // failing tool doesn't wedge the queue.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** Adapt one ToolDefinition into an AI-SDK `tool()`. */
export function toAISDKTool(
  def: ToolDefinition,
  base: ToolRuntimeBase,
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>,
): Tool {
  // Built-ins carry a Zod schema; bridged tools (MCP) carry a JSON Schema that
  // the AI SDK accepts once wrapped with `jsonSchema()`.
  const inputSchema = isZodSchema(def.inputSchema)
    ? (def.inputSchema as ZodType<unknown>)
    : jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0]);
  const run = async (
    input: unknown,
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<unknown> => {
    const ctx: ToolContext = {
      ...base,
      toolCallId: options.toolCallId,
      abortSignal: options.abortSignal ?? new AbortController().signal,
    };

    // Plugin veto hook (runs before the permission gate so a policy plugin can
    // block a tool outright).
    if (base.beforeTool) {
      const verdict = await base.beforeTool(def.name, input);
      if (verdict.deny) {
        const reason = verdict.reason ?? "denied by a plugin";
        base.emit({ type: "notice", level: "warn", message: `Blocked ${def.name}: ${reason}` });
        return `ERROR: tool "${def.name}" was blocked (${reason}). Choose a different approach.`;
      }
    }

    // Gate side-effecting tools through the permission layer.
    if (!def.readOnly && base.checkPermission) {
      const decision = await base.checkPermission(def.name, input);
      if (!decision.allowed) {
        const reason = decision.reason ?? "denied";
        base.emit({
          type: "notice",
          level: "warn",
          message: `Blocked ${def.name}: ${reason}`,
        });
        return `ERROR: tool "${def.name}" was not permitted (${reason}). Choose a different approach.`;
      }
    }

    const result = await def.execute(input, ctx);
    await base.afterTool?.(def.name, result.output);
    if (result.isError) {
      const text =
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output);
      return `ERROR: ${text}`;
    }
    return result.output;
  };

  // Mutating tools run through the shared serial lock so parallel calls in one
  // step don't race; read-only / concurrency-safe tools run unconstrained.
  const serialized = serialize && !isConcurrencySafe(def);
  return tool({
    description: def.description,
    inputSchema,
    execute: serialized
      ? (input, options) => serialize(() => run(input, options))
      : (input, options) => run(input, options),
  });
}
