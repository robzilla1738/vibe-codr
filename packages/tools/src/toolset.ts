import { tool, jsonSchema, type Tool } from "ai";
import type { ZodType } from "zod";
import type {
  CheckPermission,
  FreshnessRegistryLike,
  Mode,
  ToolContext,
  ToolDefinition,
} from "@vibe/shared";
import { canonicalLockKey } from "./fs/canonical-key.ts";
import { normalizePathAliases } from "./path-input.ts";

/**
 * Run a file mutation under the session-tree's per-path write lock when one is
 * present (it is in the engine; not in standalone unit tests). Keeps the
 * read-modify-write of `absPath` atomic against concurrent subagents.
 */
export function withFileLock<T>(
  ctx: ToolContext,
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.lockFile ? ctx.lockFile(absPath, fn) : fn();
}
import { builtinTools } from "./builtins/index.ts";

/** Zod schemas expose `.parse`; raw JSON Schema objects don't. */
function isZodSchema(s: unknown): boolean {
  return typeof (s as { parse?: unknown })?.parse === "function";
}

/** The session-scoped parts of a ToolContext supplied by the engine. */
export type ToolRuntimeBase = Pick<ToolContext, "cwd" | "sessionId" | "emit"> & {
  /** Optional gate for side-effecting tools (allow/deny/ask). */
  checkPermission?: CheckPermission;
  /** Plugin hook fired before a tool runs; may veto it (deny + reason) or rewrite
   * its input (the returned `input`, when present, replaces the original). */
  beforeTool?: (
    toolName: string,
    input: unknown,
  ) => Promise<{ deny?: boolean; reason?: string; input?: unknown }>;
  /** Plugin hook fired after a tool produces output (PostToolUse-equivalent).
   * The tool has ALREADY run; the returned directive influences what the model
   * sees: `additionalContext` is appended (delimited) to the result, and `deny`
   * hides/overrides the result with an isError carrying `reason`. */
  afterTool?: (
    toolName: string,
    output: unknown,
  ) =>
    | void
    | { additionalContext?: string; deny?: boolean; reason?: string }
    | Promise<void | { additionalContext?: string; deny?: boolean; reason?: string }>;
  /** Per-file write lock shared across the whole session tree (see ToolContext). */
  lockFile?: <T>(absPath: string, fn: () => Promise<T>) => Promise<T>;
  /** Compiler diagnostics for a just-mutated file (see ToolContext.diagnose). */
  diagnose?: (absPath: string) => Promise<string | undefined>;
  /** Plan-readiness gate consulted by present_plan (see ToolContext.planGate). */
  planGate?: ToolContext["planGate"];
  /**
   * When true, every tool execute is refused (terminal present_plan). prepareStep
   * also strips tools for real models; this is the hard backstop for mocks and
   * models that ignore toolChoice:"none".
   */
  toolsDisabled?: () => boolean;
  /**
   * Record whether a tool call ended in a (handled) error, keyed by toolCallId.
   * Handled errors are returned to the model as ordinary string results, so the
   * AI-SDK `tool-result` stream part carries no error flag; the consumer reads
   * this side-channel to mark the call correctly in the UI.
   */
  recordToolResult?: (
    toolCallId: string,
    isError: boolean,
    rawOutput?: unknown,
    additionalContext?: string,
  ) => void;
  /**
   * Mark the current turn as having successfully mutated the workspace (or
   * other non-readOnly side effects). Called only AFTER a non-readOnly tool
   * executes successfully — not on tool-call intent, permission deny, or
   * error — so green-gate / verify do not fire for denied-only turns. Also
   * covers session-only tools (save_memory / run_check) that are not in the
   * Toolset map.
   */
  recordMutation?: () => void;
  /**
   * Live agent mode (re-read every tool call). A mid-turn flip to plan must
   * hard-deny non-readOnly tools even though the AI-SDK tool map was frozen
   * at turn start with execute tools.
   */
  liveMode?: () => Mode;
  /** Per-tree stale-write guard (one instance shared across the Session
   * tree, set by core on the engine-owned `FreshnessRegistry`). Required:
   * the engine always provides one per Session tree, and unit tests must
   * construct their own `FreshnessRegistry` (no module-level singleton). */
  freshness: FreshnessRegistryLike;
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
      this.onConflict?.(`Ignored extension tool "${def.name}": it collides with a built-in tool.`);
      return;
    } else if (this.#tools.has(def.name)) {
      this.onConflict?.(`Tool "${def.name}" is registered more than once; the later one wins.`);
    }
    this.#tools.set(def.name, def);
  }

  /**
   * Remove a previously-registered non-builtin tool. Used when an MCP server
   * re-lists (tools/list_changed) or drops, so stale tools don't linger. Built-in
   * tools are never removable.
   */
  unregister(name: string): void {
    if (this.#builtins.has(name)) return;
    this.#tools.delete(name);
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

  /** Build the AI-SDK `tools` map for `mode`, bound to the session context.
   * Pass `serialize` to share ONE mutation lock with tools registered outside
   * this map (per-session tools like save_memory/run_check) — otherwise those
   * would run unserialized next to edit/write/bash. */
  aiTools(mode: Mode, base: ToolRuntimeBase, serialize?: SerialLock): Record<string, Tool> {
    // One lock shared by every tool built here, so non-concurrency-safe tools
    // (edit/write/bash/git/…) run one-at-a-time even when the model emits them as
    // parallel calls in one step (the AI SDK runs a step's tool calls via
    // Promise.all — without this, two edits to the same file would race and
    // silently drop one). The lock's SCOPE is the whole turn (aiTools is built
    // once per Session.run), which is strictly safer than per-step. Read-only /
    // concurrency-safe tools still run freely.
    const lock = serialize ?? createSerialLock();
    const map: Record<string, Tool> = {};
    for (const def of this.forMode(mode)) {
      map[def.name] = toAISDKTool(def, base, lock);
    }
    return map;
  }
}

/** A tool is safe to run in parallel if it's read-only or explicitly marked so. */
export function isConcurrencySafe(def: ToolDefinition): boolean {
  return def.concurrencySafe === true || def.readOnly === true;
}

/** The FIFO mutation lock shared by a turn's non-concurrency-safe tools. */
export type SerialLock = <T>(fn: () => Promise<T>) => Promise<T>;

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

/**
 * A counting semaphore: `run(fn)` executes `fn` once a slot is free, with at
 * most `n` running concurrently. Used to bound how many subagents one agent
 * fans out at a time. Per-parent (not tree-global) on purpose — a global
 * semaphore deadlocks when a parent holding a slot awaits a child needing one.
 *
 * Abort-aware: when `signal` aborts while a call is still QUEUED (waiting for a
 * slot), the waiter is removed from the queue and rejects with an AbortError —
 * so a parent abort (Esc) immediately cancels queued children, not just the
 * in-flight one. An already-aborted signal rejects immediately without taking
 * a slot.
 */
export function createSemaphore(
  n: number,
): <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  const limit = Math.max(1, Math.floor(n));
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  const abortError = (): Error => {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  };
  return <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortError());
    const start = async (): Promise<T> => {
      active++;
      try {
        return await fn();
      } finally {
        release();
      }
    };
    if (active < limit) return start();
    return new Promise<T>((resolve, reject) => {
      const waiter = (): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        start().then(resolve, reject);
      };
      const onAbort = (): void => {
        const i = queue.indexOf(waiter);
        if (i !== -1) queue.splice(i, 1);
        reject(abortError());
      };
      queue.push(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/** Thrown when a subagent tries to write a file a DIFFERENT live agent owns. */
export class FileOwnedError extends Error {
  constructor(public readonly path: string) {
    super(
      `"${path}" is currently being written by another subagent. ` +
        "Coordinate (split the work by file) or pick a disjoint set of files.",
    );
    this.name = "FileOwnedError";
  }
}

/** A file-lock function: claims `absPath` for the optional `ownerId` while `fn` runs. */
export type FileLock = <T>(absPath: string, fn: () => Promise<T>, ownerId?: string) => Promise<T>;

/**
 * Per-path write CLAIM registry, shared across the whole session tree. A file is
 * EXCLUSIVELY owned by the first agent (identified by `ownerId`) to write it
 * while that write is live: a *concurrent* write from a DIFFERENT agent is hard-
 * rejected with {@link FileOwnedError} so the model coordinates instead of two
 * siblings clobbering each other. Same-agent writes (and any caller that passes
 * no `ownerId`) merely SERIALIZE — so single-session behavior is unchanged, and
 * a step's parallel edits to one file still apply one-after-another rather than
 * one silently winning. Claims are scoped to live writers: once the last writer
 * for a path finishes, ownership is released. Keys are canonicalized (symlinks +
 * casing) and idle locks pruned so the map can't grow without bound.
 */
export function createFileLock(): FileLock {
  const locks = new Map<
    string,
    { run: <T>(fn: () => Promise<T>) => Promise<T>; users: number; owner: string | undefined }
  >();
  return async <T>(absPath: string, fn: () => Promise<T>, ownerId?: string): Promise<T> => {
    const key = canonicalLockKey(absPath);
    let entry = locks.get(key);
    // A live entry owned by a DIFFERENT agent → reject this concurrent write.
    if (entry && entry.owner !== undefined && ownerId !== undefined && entry.owner !== ownerId) {
      throw new FileOwnedError(absPath);
    }
    if (!entry) {
      entry = { run: createSerialLock(), users: 0, owner: ownerId };
      locks.set(key, entry);
    } else if (entry.owner === undefined) {
      entry.owner = ownerId; // first identified writer takes ownership
    }
    entry.users++;
    try {
      return await entry.run(fn);
    } finally {
      // The decrement-and-delete is one synchronous step, so no acquirer can
      // ever observe (or re-grab) an entry at users===0 — pruning is race-free.
      if (--entry.users === 0) locks.delete(key);
    }
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
      freshness: base.freshness,
    };
    // The AI SDK invokes a step's tool calls via Promise.all, and the serial
    // lock runs them one at a time — so when the user aborts mid-step, later
    // calls in the same batch are still queued behind the lock. Bail BEFORE the
    // permission gate and execute: without this, an Esc'd turn still lands a
    // queued write/edit/git_push (egress after "stop") and the late
    // checkPermission emits a permission card after the board was swept. Re-check
    // after each awaited gate too (the abort can land during them).
    const abortIfCancelled = (): void => {
      if (ctx.abortSignal.aborted) {
        throw Object.assign(new Error("aborted before the tool ran"), { name: "AbortError" });
      }
    };
    abortIfCancelled();

    // Terminal present_plan: further tools this turn are hard-refused so free-form
    // "next I'll start" / skill init cannot run after the approval card is armed.
    // prepareStep strips tools for compliant models; this gate covers everything else.
    if (base.toolsDisabled?.()) {
      const reason =
        "plan already presented — further tools are disabled this turn; wait for the user to accept or revise";
      base.emit({ type: "notice", level: "info", message: `Blocked ${def.name}: ${reason}` });
      base.recordToolResult?.(options.toolCallId, true);
      return `ERROR: tool "${def.name}" was blocked (${reason}).`;
    }
    abortIfCancelled();

    // Canonicalize path aliases (file_path / filePath / file → path) BEFORE
    // permission checks and execute so a model that only supplied an alias
    // still matches path-scoped rules and the tool's execute sees `path`.
    // Schema preprocess already accepts aliases at AI-SDK validation; this
    // keeps direct execute / pre-validated paths honest too.
    let effectiveInput = normalizePathAliases(input);
    // Plugin/hook veto (runs before the permission gate so a policy hook can
    // block a tool outright) — and may rewrite the tool's input.
    if (base.beforeTool) {
      const verdict = await base.beforeTool(def.name, effectiveInput);
      if (verdict.deny) {
        const reason = verdict.reason ?? "denied by a plugin";
        base.emit({ type: "notice", level: "warn", message: `Blocked ${def.name}: ${reason}` });
        base.recordToolResult?.(options.toolCallId, true);
        return `ERROR: tool "${def.name}" was blocked (${reason}). Choose a different approach.`;
      }
      // Re-normalize after a hook rewrite so a hook that only set file_path still works.
      if (verdict.input !== undefined) effectiveInput = normalizePathAliases(verdict.input);
    }
    abortIfCancelled();

    // Mid-turn flip to plan: the tool map is frozen at turn start, so write
    // tools may still be registered — hard-deny them so the mode chip and
    // behavior match (plan is read-only).
    if (!def.readOnly && base.liveMode?.() === "plan") {
      const reason = "session is in plan mode (read-only)";
      base.emit({ type: "notice", level: "warn", message: `Blocked ${def.name}: ${reason}` });
      base.recordToolResult?.(options.toolCallId, true);
      return `ERROR: tool "${def.name}" was blocked (${reason}). Stay read-only while planning.`;
    }

    // Gate side-effecting tools through the permission layer — and NETWORK
    // tools too, even when read-only: a read-only flag used to bypass the gate
    // entirely, so a deny/ask rule on webfetch/web_search could never fire and
    // egress was ungovernable. Network reads keep their frictionless default
    // (fallback allow — no prompt), but configured rules now apply.
    if ((!def.readOnly || def.network) && base.checkPermission) {
      // dangerouslyUnsandboxed (bash) must ALWAYS require an explicit permission
      // rule, even in YOLO (auto-approve) mode. Without this, the frictionless
      // default auto-allows it — a prompt-injected page could exfiltrate via
      // `bash {command:"curl ...", dangerouslyUnsandboxed:true}` in YOLO. The
      // scope prefix "!unsandboxed " lets a user pre-authorize it deliberately.
      const isUnsandboxed =
        effectiveInput &&
        typeof effectiveInput === "object" &&
        "dangerouslyUnsandboxed" in effectiveInput &&
        (effectiveInput as { dangerouslyUnsandboxed?: boolean }).dangerouslyUnsandboxed === true;
      const decision = await base.checkPermission(
        def.name,
        effectiveInput,
        def.readOnly && def.network
          ? { fallback: "allow" }
          : isUnsandboxed
            ? { fallback: "deny" }
            : {},
      );
      if (!decision.allowed) {
        const reason = decision.reason ?? "denied";
        base.emit({
          type: "notice",
          level: "warn",
          message: `Blocked ${def.name}: ${reason}`,
        });
        base.recordToolResult?.(options.toolCallId, true);
        return `ERROR: tool "${def.name}" was not permitted (${reason}). Choose a different approach.`;
      }
    }
    // The permission gate can itself await a user decision — an abort during it
    // must stop the tool before execute (and before a stale card resolves).
    abortIfCancelled();

    // A THROW must land in the same error contract as a returned isError —
    // without this, a FileOwnedError (or any unexpected throw) skipped the
    // `ERROR:` prefix and the recordToolResult side-channel, so the UI showed
    // a failed call as successful and the model lost the recovery guidance.
    let result: Awaited<ReturnType<typeof def.execute>>;
    try {
      result = await def.execute(effectiveInput, ctx);
    } catch (err) {
      // A cancellation is not a tool failure — let it propagate so the turn's
      // abort semantics stay intact.
      if (ctx.abortSignal.aborted || (err as { name?: string })?.name === "AbortError") throw err;
      base.recordToolResult?.(options.toolCallId, true);
      return `ERROR: ${def.name} threw: ${(err as Error)?.message ?? String(err)}`;
    }
    const after = await base.afterTool?.(def.name, result.output);
    // PostToolUse deny: the tool DID run, but the hook wants its result hidden
    // and the model told why — surface it through the same isError contract as a
    // returned error (record the side-channel, prefix ERROR:). This overrides an
    // otherwise-successful result on purpose.
    if (after?.deny) {
      base.recordToolResult?.(options.toolCallId, true);
      return `ERROR: ${after.reason ?? `tool "${def.name}" result was denied by a tool.after.execute hook`}`;
    }
    if (result.isError) {
      base.recordToolResult?.(options.toolCallId, true, result.output);
      const text =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return `ERROR: ${text}`;
    }
    // Successful non-readOnly execute → the workspace (or durable state) changed.
    // Latch mutation HERE (not on tool-call intent) so denied/errored calls do
    // not trip the green-gate / auto-verify.
    if (!def.readOnly) base.recordMutation?.();
    // PostToolUse additionalContext: append the hook's note to the result, clearly
    // delimited so the model reads it as annotation (not tool output) next step.
    if (after?.additionalContext) {
      const text =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      const decorated = `${text}\n\n[hook: tool.after.execute] ${after.additionalContext}`;
      base.recordToolResult?.(options.toolCallId, false, result.output, after.additionalContext);
      return decorated;
    }
    base.recordToolResult?.(options.toolCallId, false, result.output);
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
