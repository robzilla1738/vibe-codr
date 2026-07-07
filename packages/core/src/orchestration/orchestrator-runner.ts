import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createId, type Handoff, type Mode, type ToolDefinition } from "@vibe/shared";
import { createSemaphore, createSerialLock } from "@vibe/tools";
import { EventBus as EventBusImpl } from "../event-bus.ts";
import { ChildRegistry } from "./child-registry.ts";
import {
  enforceSchema,
  structuredDirective,
  structuredRetryPrompt,
} from "./structured-output.ts";
import type { NamedAgent } from "../agents.ts";
import {
  validateDag,
  runDag,
  formatTaskResults,
  type TaskSpec,
  type TaskResult,
} from "../orchestrator.ts";
import type { Session, SessionDeps } from "../session.ts";
import { spawnGit } from "../git-info.ts";
import {
  HANDOFF_INSTRUCTION,
  formatHandoffForKickoff,
  parseHandoff,
  stripHandoffFence,
} from "../build/handoff.ts";
import {
  appendOrchestrationEvent,
  loadCompletedTasks,
  persistTaskReport,
  planIdentity,
} from "../build/journal.ts";
import { runGate, formatGateFailure } from "../build/gate.ts";
import { bunExec } from "../build/exec.ts";
import {
  gitAddWorktree,
  gitRemoveWorktree,
  gitMergeWorktreeBranch,
  gitStagedFiles,
  gitRestoreFiles,
  gitDiffSince,
  commitWorktree,
} from "../build/gitops.ts";
import { scanStubs, formatStubFindings } from "../build/stubscan.ts";
import { ReportStore } from "./report-store.ts";

// A subagent's final answer lands verbatim in the PARENT's prompt, so — like
// every other context-producing tool — it must be bounded: a verbose or runaway
// child (and a parent can fan out `maxParallel` of them in one step) would
// otherwise flood the parent's context window and risk a 400 on the next turn.
// Generous, since a consolidated report is high-value, but capped. The UI still
// gets the full text via the `subagent-finished` event.
const MAX_SUBAGENT_OUTPUT = 32_000;
function capSubagentOutput(s: string): string {
  return s.length > MAX_SUBAGENT_OUTPUT
    ? `${s.slice(0, MAX_SUBAGENT_OUTPUT)}\n…(subagent output truncated at ${MAX_SUBAGENT_OUTPUT} chars; ask it for a more focused subtask if you need the rest)`
    : s;
}

// The real diff handed to a task reviewer also lands in a model's context, so it
// too is bounded — a large refactor's diff would otherwise blow the review turn.
const MAX_REVIEW_DIFF = 20_000;
function capDiff(s: string): string {
  return s.length > MAX_REVIEW_DIFF
    ? `${s.slice(0, MAX_REVIEW_DIFF)}\n…(diff truncated at ${MAX_REVIEW_DIFF} chars)`
    : s;
}

/**
 * The slice of a `Session` the orchestrator machinery depends on. Keeping this
 * explicit (rather than reaching into the whole Session) keeps the runner's
 * coupling to the parent narrow: it reads live mode/goal/depth/model, forks
 * children, emits on the shared bus (via `deps`), and folds a finished child's
 * mutation flag + usage + cost back into the parent through `onChildSettled`.
 */
export interface SessionHandle {
  readonly id: string;
  readonly model: string;
  readonly mode: Mode;
  /** Mode frozen at the current turn's start — the authority for the plan-turn
   * read-only contract (a mid-turn user mode flip must not un-coerce children
   * spawned later in the same plan turn). */
  readonly turnMode: Mode;
  readonly goal: string | null;
  readonly depth: number;
  readonly deps: SessionDeps;
  /** Fork a child session (a fresh subagent conversation). */
  fork(overrides: Partial<SessionDeps> & { model?: string }): Session;
  /** Fold a settled child's mutation flag + usage + cost up into the parent. */
  onChildSettled(child: Session): void;
  /** Release the parent's tree-global limiter slot for the span of `fn` (while a
   * spawn tool awaits its children the parent makes no provider call), so a queued
   * child can acquire it — breaking the fan-out hold-and-wait. Ref-counted in the
   * Session so parallel spawns in one step release/re-acquire the slot once; a
   * no-op when no limiter is wired. */
  suspendLimiterSlot<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The subagent / task-DAG machinery for a Session: the `spawn_subagent` and
 * `spawn_tasks` tools plus the fork → run → review → retry pipeline behind them.
 * One runner per Session (so the fan-out gate is per-session, matching the
 * original semantics — a parent awaiting its children can't deadlock against a
 * tree-global cap).
 */
export class OrchestratorRunner {
  #handle: SessionHandle;
  /** Bounds how many subagents this session runs concurrently (each fan-out).
   * Per-session, not tree-global, so a parent awaiting its children can't
   * deadlock against the cap. */
  #childGate: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Emit the "review degraded to a generic child" warning at most once per
   * session, not once per verified task. */
  #reviewDegradationWarned = false;
  /** Serializes every operation that mutates or builds the ONE shared main tree:
   * the commit+merge+remove of each worktree/ensemble task AND the shared-tree
   * `runGate` build/test. Concurrent squash-merges race `.git/index` (and a merge
   * touching a file a prior merge staged is refused by git); concurrent gate builds
   * in one dir clobber each other's outputs and cross-observe edits. So the whole
   * shared-tree critical section — merges and gates alike — must run one-at-a-time. */
  #mergeLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live-activity tap teardown per child id (see #tapChildActivity): the child
   * runs on an isolated bus, so we subscribe to it and re-emit throttled activity
   * onto the parent bus, then stop when the child finishes. */
  #childTaps = new Map<string, () => void>();
  /** Tree-shared registry of retained (continue_subagent) + detached (background)
   * children, created lazily by the root runner like reportStore. */
  #childRegistry: ChildRegistry;
  /** Warn once per session when a requested `detach` is coerced to synchronous. */
  #detachCoercionWarned = false;

  constructor(handle: SessionHandle) {
    this.#handle = handle;
    this.#childGate = createSemaphore(handle.deps.config.subagent.maxParallel);
    // Tree-shared ledgers: the ROOT runner (where these are absent) creates them
    // on its live deps; forks inherit the SAME objects via `{...deps}`, so the
    // spawn ceiling is tree-global and read_report can see sibling reports.
    if (!handle.deps.spawnCounter) handle.deps.spawnCounter = { used: 0 };
    // The merge lock MUST be tree-global too: a nested `spawn_tasks` runner shares
    // the same `.git`, so a per-runner lock would let a parent-runner merge race a
    // child-runner merge on `.git/index`. Share the root's lock across the tree.
    if (!handle.deps.mergeLock) handle.deps.mergeLock = createSerialLock();
    this.#mergeLock = handle.deps.mergeLock;
    if (!handle.deps.reportStore) {
      handle.deps.reportStore = new ReportStore(handle.deps.cwd, handle.id);
    }
    // Tree-shared child registry (continuation LRU + detached tracking): created
    // once by the root, inherited by every fork via `{...deps}`.
    if (!handle.deps.childRegistry) {
      handle.deps.childRegistry = new ChildRegistry(
        handle.deps.config.subagent.retainCompleted,
        handle.deps.cwd, // the shared-tree cwd — children whose cwd differs (worktree descendants) aren't retained
      );
    }
    this.#childRegistry = handle.deps.childRegistry;
  }

  /** Build the per-session `spawn_subagent` tool (closes over this session). */
  spawnTool(): ToolDefinition<{
    prompt: string;
    agent?: string;
    mode?: Mode;
    outputSchema?: Record<string, unknown>;
    detach?: boolean;
  }> {
    const Input = z.object({
      prompt: z
        .string()
        .describe(
          "The complete, self-contained subtask. The subagent sees none of this " +
            "conversation — inline the objective, exact files/paths, and success criteria.",
        ),
      agent: z
        .string()
        .optional()
        .describe("Named agent to specialize the subagent (see the roster in the system prompt)."),
      mode: z.enum(["plan", "execute"]).optional(),
      outputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Optional JSON Schema. When set, the subagent's FINAL message must be exactly one JSON " +
            "object matching it — validated, and retried with the errors as feedback on a mismatch. " +
            "Use when you need the result as machine-consumable structured data.",
        ),
      detach: z
        .boolean()
        .optional()
        .describe(
          "Run the subagent in the BACKGROUND and return its id immediately so you can keep " +
            "working; collect its result later with check_task. For long, independent work. " +
            "Interactive sessions only (coerced to synchronous otherwise).",
        ),
    });
    // NOTE: there is deliberately no `model` parameter. The subagent's model is a
    // user *setting* — `subagent.model` (or a named agent's own `model`), falling
    // back to the parent's model — never something the model picks per call. A
    // model that invented `model:"gpt-4"` here would spawn a child on a provider
    // the user hasn't configured (the Ollama-Cloud "gpt-4 subagent" bug).
    return {
      name: "spawn_subagent",
      description:
        "Delegate a self-contained subtask to a fresh subagent with its own context " +
        "window; it returns only its final answer. Issue several calls in ONE step to " +
        "run them in parallel — give each a disjoint set of files. Pass `outputSchema` for a " +
        "machine-consumable JSON result, or `detach:true` to run it in the background and collect " +
        "it later with check_task. Follow up with continue_subagent (using the returned id) instead " +
        "of re-spawning when a child already has the context. While you are " +
        "planning (read-only), subagents are read-only too (investigation only).",
      inputSchema: Input,
      // The spawn itself touches nothing — the child's own tools gate their side
      // effects individually — so don't make orchestration prompt for permission.
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ prompt, agent, mode, outputSchema, detach }, ctx) => {
        const check = this.#classifyAgent(agent);
        if (!check.ok) {
          if (check.reason === "unknown") {
            return { output: `Unknown agent "${agent}". Run /agents to list them.`, isError: true };
          }
          // While planning the parent is read-only, so any child is coerced to plan
          // below. A named agent declared for execute (it writes / runs commands)
          // can't do its job under that constraint — coercing it would just burn a
          // turn on a child instructed to edit files it has no tools to touch. The
          // plan-mode roster already hides such agents (only `mode === "plan"` is
          // advertised); reject one named explicitly here too, pointing at the
          // read-only agents the model CAN delegate to. (An explicit `mode:"execute"`
          // request without a named agent is still safely coerced — see #forkChild.)
          const readOnly = [...(this.#handle.deps.agents?.values() ?? [])]
            .filter((a) => a.mode === "plan")
            .map((a) => a.name);
          const suggestion = readOnly.length
            ? ` Use a read-only agent (${readOnly.join(", ")})`
            : " Investigate read-only without a named agent";
          return {
            output:
              `Agent "${agent}" runs in execute mode (it writes or runs commands) ` +
              `and can't run while planning, which is read-only.${suggestion}, or ` +
              `delegate it once you switch to execute mode.`,
            isError: true,
          };
        }
        const named = check.named;
        const child = this.#forkChild(named, mode);
        if (!child) return this.#spawnCeilingError();
        this.#emitStarted(child.id, prompt);

        // Background (detached) spawn: fire the SAME execution path as a tracked,
        // try/caught promise and return the handle immediately. Interactive +
        // root-only + under the concurrency ceiling — otherwise coerce to sync so
        // engine-idle stays the true terminal signal for headless runs and a
        // background grandchild never emits onto a torn-down subagent bus.
        if (detach === true && this.#detachAllowed()) {
          const abort = new AbortController();
          const promise = this.#runSpawnedChild(child, prompt, outputSchema, abort.signal, false)
            .then((r) => this.#childRegistry.markDetachedFinished(child.id, { report: r.text, isError: r.isError }))
            .catch((err) =>
              this.#childRegistry.markDetachedFinished(child.id, {
                report: `Background subagent threw: ${(err as Error)?.message ?? String(err)}`,
                isError: true,
              }),
            );
          this.#childRegistry.registerDetached({
            id: child.id,
            kind: "subagent",
            status: "running",
            abort,
            promise,
            summary: firstLine(prompt),
          });
          return {
            output:
              `Started subagent \`${child.id}\` in the background. Keep working; call ` +
              `check_task("${child.id}") to collect its status/result, and it will be summarized ` +
              "in your next turn when it finishes.",
          };
        }
        if (detach === true) this.#warnDetachCoerced();

        const r = await this.#runSpawnedChild(child, prompt, outputSchema, ctx.abortSignal);
        return { output: r.text, ...(r.isError ? { isError: true } : {}) };
      },
    };
  }

  /**
   * Build the per-session `continue_subagent` tool: resume a retained completed
   * subagent by id with a follow-up message. It keeps its FULL prior context (the
   * live Session object), so this is cheaper and better-informed than re-spawning
   * a child that would have to re-investigate. Does NOT fork (spawnCounter is
   * untouched — no new subagent is created), and re-gates the child to plan when
   * the parent is now planning, mirroring #forkChild.
   */
  continueTool(): ToolDefinition<{ id: string; message: string }> {
    return {
      name: "continue_subagent",
      description:
        "Resume a previously spawned subagent by its id (returned in a spawn_subagent result) with " +
        "a follow-up message. It keeps its full prior context — prefer this over spawning a fresh " +
        "child when one already investigated the relevant area. Unknown or expired ids return an error.",
      inputSchema: z.object({
        id: z.string().describe("The id of a subagent from an earlier spawn_subagent result."),
        message: z.string().describe("The follow-up instruction for that subagent."),
      }),
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ id, message }, ctx) => {
        const child = this.#childRegistry.lookup(id);
        if (!child) {
          const max = this.#handle.deps.config.subagent.retainCompleted;
          return {
            output:
              `No retained subagent with id "${id}" — it was never spawned in this session tree, or ` +
              `has been evicted (only the ${max} most recently used completed subagents are retained). ` +
              "Spawn a fresh subagent instead.",
            isError: true,
          };
        }
        // Belt-and-braces beyond the retention guard: a retained child whose
        // working directory has since vanished (a worktree it descended from was
        // torn down) can't be resumed — running it would ENOENT. Evict it and
        // report the expiry honestly rather than crash.
        if (!existsSync(child.cwd)) {
          this.#childRegistry.evict(id);
          return {
            output:
              `Subagent "${id}" can no longer be resumed — its working directory was cleaned up ` +
              "(it ran inside a worktree that has since been removed). Spawn a fresh subagent instead.",
            isError: true,
          };
        }
        // Re-gate mode like #forkChild: coerce the child to plan while the parent
        // is planning (read-only). The coercion is REVERSIBLE — remember the
        // child's pre-coercion mode so a later continuation, once the parent is
        // executing again, can restore it. Never auto-PROMOTE a plan-native child:
        // only a mode we ourselves coerced away is ever restored.
        if (this.#parentPlanning()) {
          if (child.mode !== "plan") {
            this.#childRegistry.rememberCoercedMode(id, child.mode);
            child.setMode("plan");
          }
        } else {
          const restored = this.#childRegistry.takeCoercedMode(id);
          if (restored) child.setMode(restored);
        }
        // The child's isolated bus was closed when its last run settled; give it a
        // fresh one and re-tap so live activity surfaces during the continuation.
        const childBus = new EventBusImpl();
        child.rebindBus(childBus);
        this.#tapChildActivity(child.id, childBus);
        this.#emitStarted(child.id, message);
        const { timedOut, aborted } = await this.#runChildToCompletion(child, message, ctx.abortSignal);
        const outcome = this.#childOutcome(child, timedOut, aborted);
        this.#emitFinished(child.id, outcome.event);
        this.#childRegistry.retain(child); // bump LRU on reuse
        return {
          output: capSubagentOutput(outcome.text) + this.#handleSuffix(child.id),
          ...(outcome.isError ? { isError: true } : {}),
        };
      },
    };
  }

  /**
   * Build the per-session `check_task` tool: report the status and (when done)
   * the report of a DETACHED (background) subagent by its id. Detached
   * `spawn_tasks` results are also reachable per-task via `read_report`.
   */
  checkTaskTool(): ToolDefinition<{ id: string }> {
    return {
      name: "check_task",
      description:
        "Check a background (detached) spawn by its id (returned when you passed detach:true). " +
        "Returns whether it is still running or, once finished, its report.",
      inputSchema: z.object({
        id: z.string().describe("The id of a background spawn (from a detach:true result)."),
      }),
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ id }) => {
        const rec = this.#childRegistry.getDetached(id);
        if (!rec) {
          return { output: `No background spawn with id "${id}" in this session.`, isError: true };
        }
        if (rec.status === "running") {
          return { output: `Background spawn \`${id}\`${rec.summary ? ` (${rec.summary})` : ""} is still running.` };
        }
        return {
          output: `Background spawn \`${id}\` ${rec.status}:\n${capSubagentOutput(rec.report ?? "(no report)")}`,
          ...(rec.isError ? { isError: true } : {}),
        };
      },
    };
  }

  /**
   * Build the per-session `spawn_tasks` tool: submit a dependency-ordered plan
   * the engine schedules deterministically (the agentswarm Executor pattern).
   */
  spawnTasksTool(): ToolDefinition<{
    tasks: {
      id: string;
      objective: string;
      deps?: string[];
      files?: string[];
      verify?: boolean;
      agent?: string;
      tier?: "cheap" | "strong";
      check?: boolean;
      worktree?: boolean;
      hard?: boolean;
      outputSchema?: Record<string, unknown>;
    }[];
    detach?: boolean;
  }> {
    const TaskInput = z.object({
      id: z.string().describe("Stable id, referenced by other tasks' `deps`."),
      objective: z
        .string()
        .describe("The complete, self-contained subtask (the subagent sees none of this conversation)."),
      deps: z.array(z.string()).optional().describe("Ids of tasks that must finish before this one starts."),
      files: z.array(z.string()).optional().describe("Files this task owns (give each task a DISJOINT set)."),
      verify: z.boolean().optional().describe("Run a review→retry pass after this task."),
      agent: z.string().optional().describe("Named agent to specialize the subagent."),
      tier: z
        .enum(["cheap", "strong"])
        .optional()
        .describe(
          "Model tier: 'cheap' for scouts / mechanical work, 'strong' for leads / reviewers / verifiers. Resolves to a configured model — you do NOT pick a provider.",
        ),
      check: z
        .boolean()
        .optional()
        .describe("Run the repo's real detected checks (build/typecheck/test) after this task; a red result fails it."),
      worktree: z
        .boolean()
        .optional()
        .describe(
          "Run this task in an isolated git worktree — for parallel writers whose file sets can't be declared disjoint; its changes squash-merge back on success.",
        ),
      hard: z
        .boolean()
        .optional()
        .describe(
          "Run as a best-of-N ensemble in isolated worktrees; expensive, reserve for genuinely hard tasks.",
        ),
      outputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Optional JSON Schema. When set, this (shared-tree) task's FINAL message must be exactly one JSON object matching it — validated and retried on mismatch; the validated JSON becomes the report.",
        ),
    });
    return {
      name: "spawn_tasks",
      description:
        "Submit a whole plan of subtasks as a dependency graph; the engine runs it deterministically — every task whose dependencies are done starts immediately (parallel where possible), dependents unlock as inputs complete, and a task whose dependency failed is skipped. Prefer this over many separate spawn_subagent calls for multi-step work: declare `deps` for ordering, disjoint `files` per task, and `verify:true` on a task to have it reviewed and retried. Pass `detach:true` to run the whole plan in the background and collect each task's report via read_report. Each task is a fresh subagent; it returns a consolidated report.",
      inputSchema: z.object({
        tasks: z.array(TaskInput).min(1),
        detach: z
          .boolean()
          .optional()
          .describe(
            "Run the whole plan in the BACKGROUND and return immediately; collect each task's report via read_report, or the batch status via check_task. Interactive sessions only.",
          ),
      }),
      readOnly: true,
      concurrencySafe: true,
      execute: async ({ tasks, detach }, ctx) => {
        // Plan identity: stamped onto every spec (and thus every journal event)
        // so a resume seeds ONLY from this exact plan's prior run — a later
        // same-session plan reusing a task id never inherits a stale result.
        // Behavior-bearing fields ride in the hash too: a re-plan flipping
        // verify/check/files/tier must re-run, not inherit.
        const plan = planIdentity(
          tasks.map((t) => ({
            id: t.id,
            objective: t.objective,
            deps: t.deps ?? [],
            files: t.files,
            verify: t.verify,
            check: t.check,
            tier: t.tier,
          })),
        );
        const specs: TaskSpec[] = tasks.map((t) => ({
          id: t.id,
          plan,
          objective: t.objective,
          deps: t.deps ?? [],
          ...(t.files ? { files: t.files } : {}),
          ...(t.verify ? { verify: t.verify } : {}),
          ...(t.agent ? { agent: t.agent } : {}),
          ...(t.tier ? { tier: t.tier } : {}),
          ...(t.check ? { check: t.check } : {}),
          ...(t.worktree ? { worktree: t.worktree } : {}),
          ...(t.hard ? { hard: t.hard } : {}),
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        }));
        // Validate the plan SYNCHRONOUSLY so a bad plan errors immediately, even
        // for a detached run (it must not be deferred into the background).
        const dagError = validateDag(specs);
        if (dagError) return { output: `Invalid task plan: ${dagError}`, isError: true };
        for (const s of specs) {
          const err = this.#validateAgentForTask(s.agent);
          if (err) return { output: `Task "${s.id}": ${err}`, isError: true };
        }

        const runPlan = (signal: AbortSignal | undefined, suspendParentSlot: boolean): Promise<string> => {
          // Resume seed: completed tasks from a prior run of THIS EXACT plan
          // (the journal on disk, filtered by plan identity — a different
          // same-session plan's completions are never a seed). runDag honors
          // only ids still in this spec set, so a re-submitted plan re-runs only
          // what didn't finish. Best-effort — a missing/torn journal simply
          // yields no seed.
          const seed = loadCompletedTasks(this.#handle.deps.cwd, this.#handle.id, plan);
          return runDag(
            specs,
            (spec, depResults) => this.#runTask(spec, depResults, signal, suspendParentSlot),
            {
              onStatus: (spec, status, result) =>
                this.#handle.deps.bus.emit({
                  type: "orchestration-task",
                  sessionId: this.#handle.id,
                  taskId: spec.id,
                  objective: spec.objective,
                  status,
                  ...(result?.attempts !== undefined ? { attempts: result.attempts } : {}),
                  ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
                }),
              ...(seed.length ? { seed } : {}),
            },
          ).then((results) => capSubagentOutput(formatTaskResults(results)));
        };

        // Background (detached) plan: same execution path, tracked/try-caught, so
        // finalize can abort+await it and check_task/read_report collect results.
        if (detach === true && this.#detachAllowed()) {
          const abort = new AbortController();
          const batchId = createId("bgtasks");
          const promise = runPlan(abort.signal, false)
            .then((report) => this.#childRegistry.markDetachedFinished(batchId, { report, isError: false }))
            .catch((err) =>
              this.#childRegistry.markDetachedFinished(batchId, {
                report: `Background tasks threw: ${(err as Error)?.message ?? String(err)}`,
                isError: true,
              }),
            );
          this.#childRegistry.registerDetached({
            id: batchId,
            kind: "tasks",
            status: "running",
            abort,
            promise,
            summary: `${specs.length} task(s)`,
          });
          return {
            output:
              `Started ${specs.length} task(s) in the background (ids: ${specs.map((s) => s.id).join(", ")}). ` +
              `Keep working; collect each task's report with read_report, or check_task("${batchId}") for the ` +
              "batch status. The batch will also be summarized in your next turn when it finishes.",
          };
        }
        if (detach === true) this.#warnDetachCoerced();

        return { output: await runPlan(ctx.abortSignal, true) };
      },
    };
  }

  /**
   * Classify a named agent against the current mode — the one rule both
   * spawn_subagent and the task orchestrator enforce: an unknown agent is
   * rejected, and an execute-mode agent (it writes / runs commands) can't run
   * while the parent is planning (read-only). Callers render their own message
   * from the verdict (the two surfaces word the rejection differently).
   */
  #classifyAgent(agent: string | undefined):
    | { ok: true; named: NamedAgent | undefined }
    | { ok: false; reason: "unknown" | "execute-in-plan" } {
    if (!agent) return { ok: true, named: undefined };
    const named = this.#handle.deps.agents?.get(agent);
    if (!named) return { ok: false, reason: "unknown" };
    if (this.#parentPlanning() && named.mode !== "plan") {
      return { ok: false, reason: "execute-in-plan" };
    }
    return { ok: true, named };
  }

  /** The parent is planning if EITHER the in-flight turn started in plan mode
   * (turnMode — a mid-turn flip to execute must not un-coerce children spawned
   * later in the same plan turn, whose gate still runs as a plan turn) or the
   * live mode is plan (a mid-turn flip INTO plan means stop writing now). */
  #parentPlanning(): boolean {
    return this.#handle.turnMode === "plan" || this.#handle.mode === "plan";
  }

  /** Validate a task's named agent against the current mode (mirrors spawn_subagent). */
  #validateAgentForTask(agent: string | undefined): string | null {
    const check = this.#classifyAgent(agent);
    if (check.ok) return null;
    if (check.reason === "unknown") return `unknown agent "${agent}". Run /agents to list them.`;
    return `agent "${agent}" runs in execute mode and can't run while planning.`;
  }

  /**
   * Dispatch a task to its execution strategy: a best-of-N ensemble (a `hard`
   * task when `build.ensemble.n > 0` and worktrees are usable), an isolated
   * worktree (a `worktree` task), or the shared tree (the default). Both worktree
   * strategies fall back to the shared tree when git worktrees aren't available —
   * worktree unavailability must never fail a task.
   */
  async #runTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    // False for a DETACHED task batch: the spawn_tasks turn already ended and
    // released the root's limiter slot, so its task children must take their own
    // slots rather than suspend a slot the root no longer holds.
    suspendParentSlot = true,
  ): Promise<TaskResult> {
    const build = this.#handle.deps.config.build;
    if (build.ensemble.n > 0 && spec.hard && build.worktrees.enabled) {
      if (await this.#worktreesUsable()) return this.#runEnsembleTask(spec, depResults, parentSignal, suspendParentSlot);
      // Worktrees can't be created here (a non-git cwd, or an unborn HEAD — a
      // greenfield repo with no commit for `worktree add` to fork off). A hard
      // task must still run: fall back to a single shared-tree attempt rather than
      // hard-failing every ensemble attempt with 'worktree-unavailable'.
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": git worktrees unavailable — running the ensemble as a single shared-tree task.`,
      });
      return this.#runSharedTask(spec, depResults, parentSignal, suspendParentSlot);
    }
    if (spec.worktree && build.worktrees.enabled) {
      // #runWorktreeTask itself falls back to the shared tree if the worktree
      // can't be created (e.g. a non-git cwd), so no pre-check is needed here.
      return this.#runWorktreeTask(spec, depResults, parentSignal, suspendParentSlot);
    }
    return this.#runSharedTask(spec, depResults, parentSignal, suspendParentSlot);
  }

  /** Whether git worktrees can actually be created in the session cwd. Requires a
   * real work tree AND a born HEAD: `git worktree add … HEAD` forks off HEAD, so
   * an unborn HEAD (a repo with no commit yet) fails even though it IS inside a
   * work tree — the old `is-inside-work-tree`-only check mis-reported it usable. */
  async #worktreesUsable(): Promise<boolean> {
    try {
      const repo = await spawnGit(this.#handle.deps.cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (!(repo.ok && /true/.test(repo.stdout))) return false;
      const head = await spawnGit(this.#handle.deps.cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
      return head.ok && !!head.stdout.trim();
    } catch {
      return false;
    }
  }

  /** The current HEAD sha of a tree (the base each worktree attempt forks from,
   * used as the diff-size tiebreak ref for the ensemble). */
  async #headRef(cwd: string): Promise<string> {
    const r = await spawnGit(cwd, ["rev-parse", "HEAD"]);
    return r.ok ? r.stdout.trim() || "HEAD" : "HEAD";
  }

  /**
   * Run a task in an isolated git worktree. The child's tools redirect to the
   * worktree (via the fork's cwd), so parallel worktree writers touching the same
   * relative path never collide. On success the worktree's work is committed then
   * squash-merged back into the main tree, and the gate/review run on the MERGED
   * main tree (that state is what matters). A conflicting merge fails the task.
   *
   * There is deliberately no in-worktree verify→retry loop: the worktree is
   * squash-merged and removed once the child settles, so a red post-merge gate
   * fails the task to be re-planned rather than retried against a discarded tree.
   */
  async #runWorktreeTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<TaskResult> {
    const mainCwd = this.#handle.deps.cwd;
    const slug = worktreeSlug(spec.id);
    const wtPath = join(mainCwd, ".vibe", "worktrees", worktreePathName(this.#handle.id, slug));
    const branch = worktreeBranch(this.#handle.id, slug);
    const wt = await gitAddWorktree(mainCwd, { path: wtPath, branch });
    if (!wt) {
      // Never fail a task over worktree unavailability — run it in the shared
      // tree instead (the journal note the caller asked for, surfaced as a notice
      // since the append-only journal only carries task-started/finished events).
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": git worktree unavailable — running in the shared tree.`,
      });
      return this.#runSharedTask(spec, depResults, parentSignal, suspendParentSlot);
    }

    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    const profile = this.#handle.deps.repoProfile;
    const wantsGate = (spec.check || spec.verify) && !!profile;
    const startedAt = Date.now();
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      worktree: true,
      ...(spec.tier ? { tier: spec.tier } : {}),
      ...(spec.plan ? { plan: spec.plan } : {}),
    });
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      // The child's raw final message carries the ```handoff fence, already
      // parsed into the structured `handoff` field — strip it from the prose so
      // read_report, the planner summary, and dependents' kickoffs don't all
      // repeat the machine block as noise.
      const result: TaskResult = {
        ...partial,
        output: stripHandoffFence(partial.output),
        durationMs: Date.now() - startedAt,
      };
      this.#recordFinished(spec, result);
      return result;
    };

    try {
      const child = this.#forkChild(named, undefined, spec.tier, wt);
      if (!child) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: this.#spawnCeilingError().output, attempts: 1 });
      }
      this.#handle.deps.bus.emit({ type: "subagent-started", sessionId: this.#handle.id, subagentId: child.id, prompt: spec.objective });
      const { timedOut, aborted } = await this.#runChildToCompletion(child, buildTaskKickoff(spec, depResults, ""), parentSignal, suspendParentSlot);
      const outcome = this.#childOutcome(child, timedOut, aborted);
      this.#handle.deps.bus.emit({ type: "subagent-finished", sessionId: this.#handle.id, subagentId: child.id, result: outcome.event });
      if (outcome.isError) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: outcome.text, attempts: 1 });
      }
      const handoff = parseHandoff(outcome.text) ?? undefined;

      // Structured output: the FINAL message must be exactly one JSON object
      // matching spec.outputSchema. The worktree path has no verify→retry loop
      // (the tree squash-merges and tears down once the child settles), so
      // enforce ONCE — a mismatch fails the task with the validator's honest
      // errors + raw text rather than merging unvalidated prose as the report.
      let reportText = outcome.text;
      if (spec.outputSchema) {
        const res = enforceSchema(outcome.text, spec.outputSchema);
        if (!res.ok) {
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: `Structured output invalid:\n${res.errors.map((e) => `- ${e}`).join("\n")}\n\nRaw final message:\n${res.raw}`,
            attempts: 1,
          });
        }
        reportText = res.json;
      }

      // Commit → squash-merge → gate → CAPTURE DIFF, all inside ONE critical
      // section on the shared tree: the gate builds+tests the whole MAIN tree, so a
      // sibling worktree task's merge landing between this task's merge and its own
      // gate would give a nondeterministic verdict (and two builds clobbering one
      // dir). The review child runs OUTSIDE the lock (below) on the diff captured
      // HERE — it's a full LLM turn that may itself emit `spawn_tasks`, and that
      // nested runner shares this same NON-reentrant tree-global lock; running the
      // review inside the lock would deadlock the whole tree. The lock only ever
      // wraps git ops + the gate build, never a child turn. Worktree removal runs in
      // the outer finally, also serialized.
      const verdict = await this.#mergeLock(
        async (): Promise<{ ok: true; diff?: string } | { ok: false; output: string }> => {
          await commitWorktree(wt, `vibecodr(task ${spec.id}): ${spec.objective}`);
          // Sibling tasks' already-staged (uncommitted) changes in this shared tree,
          // captured BEFORE our merge so the revert set is OUR delta only.
          const preStaged = new Set(await gitStagedFiles(mainCwd));
          if (!(await gitMergeWorktreeBranch(mainCwd, branch))) {
            return { ok: false, output: "merge conflict — changes discarded; re-plan with disjoint files or sequential deps" };
          }
          // Exactly what OUR squash-merge staged — reverted on a red/aborted gate so
          // main isn't left holding the failing changes; a sibling's disjoint staged
          // changes (in preStaged) survive.
          const mergedFiles = (await gitStagedFiles(mainCwd)).filter((f) => !preStaged.has(f));
          if (wantsGate) {
            const gate = await runGate(mainCwd, profile!, 0, {
              checks: this.#handle.deps.config.build.gate.checks,
              timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
              // Confine repo-authored build scripts under the OS sandbox exactly
              // like the engine's own gate — orchestrator gates were unsandboxed.
              exec: bunExec(this.#handle.deps.sandbox),
              ...(parentSignal ? { signal: parentSignal } : {}),
            });
            if (gate.outcome === "red") {
              await gitRestoreFiles(mainCwd, mergedFiles);
              return { ok: false, output: `Checks failed on the merged tree (changes reverted):\n${formatGateFailure(gate, 1)}` };
            }
            // An interrupted gate produced NO verdict — treat it like red so the
            // task fails and the merged changes are reverted (the outer finally
            // tears down the worktree). Never let an interrupt read as a pass.
            if (gate.outcome === "aborted") {
              await gitRestoreFiles(mainCwd, mergedFiles);
              return { ok: false, output: "Gate interrupted before a verdict — merged changes reverted." };
            }
          }
          // Capture the diff of THIS task's merged changes while the tree is still
          // stable (before releasing the lock lets a sibling merge land).
          return { ok: true, ...(spec.verify ? { diff: await this.#captureTaskDiff(spec) } : {}) };
        },
      );
      if (!verdict.ok) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: verdict.output, attempts: 1, ...(handoff ? { handoff } : {}) });
      }
      // Review OUTSIDE the lock (see above) on the diff captured inside it.
      if (spec.verify) {
        const review = await this.#reviewCapturedDiff(spec, reportText, verdict.diff ?? "", parentSignal, suspendParentSlot);
        if (!review.clean) {
          return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: `Post-merge review found issues:\n${review.feedback}`, attempts: 1, ...(handoff ? { handoff } : {}) });
        }
      }
      return settle({ id: spec.id, objective: spec.objective, outcome: "completed", output: reportText, attempts: 1, ...(handoff ? { handoff } : {}) });
    } catch (err) {
      return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: `Worktree task threw: ${(err as Error)?.message ?? String(err)}`, attempts: 1 });
    } finally {
      // Always tear down the worktree — the happy path AND every early return/throw
      // after gitAddWorktree created it (spawn-ceiling, child error/interrupt, a
      // thrown exception). Without this an early return leaks the worktree + its
      // branch, and a later re-run of the same id can't recreate the branch (so it
      // silently loses worktree isolation). Serialized behind the merge lock so
      // removal can't race a sibling's squash-merge on the shared .git.
      await this.#mergeLock(() => gitRemoveWorktree(mainCwd, wt, branch)).catch(() => {});
    }
  }

  /**
   * Best-of-N ensemble: run N attempts of the SAME objective in N isolated
   * worktrees, each nudged toward a distinct strategy, then judge OBJECTIVELY —
   * commit each attempt and run the repo's real gate INSIDE its worktree
   * (green=2 / unverified=1 / red=0; no-change=-1; tiebreak = smaller diff). Only
   * the winner (score > 0) squash-merges into the main tree; every other worktree
   * + branch is discarded. Each attempt's usage folds into the parent via the
   * per-child #runChildToCompletion path.
   */
  async #runEnsembleTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<TaskResult> {
    const mainCwd = this.#handle.deps.cwd;
    const n = Math.min(this.#handle.deps.config.build.ensemble.n, ENSEMBLE_STRATEGIES.length);
    const startedAt = Date.now();
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      worktree: true,
      ...(spec.tier ? { tier: spec.tier } : {}),
      ...(spec.plan ? { plan: spec.plan } : {}),
    });
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      // The child's raw final message carries the ```handoff fence, already
      // parsed into the structured `handoff` field — strip it from the prose so
      // read_report, the planner summary, and dependents' kickoffs don't all
      // repeat the machine block as noise.
      const result: TaskResult = {
        ...partial,
        output: stripHandoffFence(partial.output),
        durationMs: Date.now() - startedAt,
      };
      this.#recordFinished(spec, result);
      return result;
    };
    const baseRef = await this.#headRef(mainCwd);

    const attempts = await Promise.all(
      Array.from({ length: n }, (_, i) => i).map((i) =>
        this.#runEnsembleAttempt(spec, depResults, parentSignal, i, baseRef, suspendParentSlot),
      ),
    );

    // Safety net: if NO attempt could even create a worktree (born HEAD passed the
    // pre-check but `worktree add` still failed for every attempt), never fail a
    // hard task over it — fall back to a single shared-tree attempt. No child ran
    // for a worktree-unavailable attempt, so this wastes no model calls.
    if (attempts.every((a) => a.wt === null)) {
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "info",
        message: `Task "${spec.id}": no ensemble worktree could be created — running in the shared tree.`,
      });
      // Forward suspendParentSlot: a DETACHED batch already released the root's
      // tree-global limiter slot (suspendParentSlot=false), so the shared-tree
      // fallback must not re-suspend a slot the idle parent no longer holds —
      // that over-releases the limiter and admits an extra concurrent turn.
      return this.#runSharedTask(spec, depResults, parentSignal, suspendParentSlot);
    }

    // Winner: highest score, ties broken by the smaller diff. Must score > 0.
    const winner = [...attempts]
      .filter((a) => a.score > 0)
      .sort((x, y) => y.score - x.score || x.diffSize - y.diffSize)[0];

    try {
      if (!winner) {
        const summary = attempts
          .map((a) => `- attempt ${a.i} (${a.label}): ${a.verdict}`)
          .join("\n");
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: `Best-of-${n} ensemble: no attempt passed the gate.\n${summary}`,
          attempts: n,
        });
      }
      // Structured output: the winning attempt's FINAL message must match
      // spec.outputSchema. An ensemble has no verify→retry loop, so validate the
      // winner BEFORE merging — a winner that won on gate score but violates the
      // schema fails the task with honest errors + raw text rather than merging
      // unvalidated prose as the report.
      let winnerReport = winner.text;
      if (spec.outputSchema) {
        const res = enforceSchema(winner.text, spec.outputSchema);
        if (!res.ok) {
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: `Ensemble winner's structured output invalid:\n${res.errors.map((e) => `- ${e}`).join("\n")}\n\nRaw final message:\n${res.raw}`,
            attempts: n,
          });
        }
        winnerReport = res.json;
      }
      // Merge AND re-gate the MERGED main tree inside one lock hold — mirroring
      // #runWorktreeTask. The winner's green was produced in ISOLATION off a
      // baseRef captured at ensemble start; by merge time sibling tasks may have
      // advanced the tree, so the winner's isolated verdict is stale and the
      // COMBINED result must be re-verified or a hard task could land a red main
      // tree while reporting success.
      const profile = this.#handle.deps.repoProfile;
      const wantsGate = (spec.check || spec.verify) && !!profile;
      const mergeVerdict = await this.#mergeLock(
        async (): Promise<{ ok: true } | { ok: false; output: string }> => {
          // Files a SIBLING task already squash-merged into this shared uncommitted
          // tree (staged, not yet committed). Capture them BEFORE our merge so the
          // revert set below is OUR merge's DELTA only — never the whole index.
          const preStaged = new Set(await gitStagedFiles(mainCwd));
          if (!(await gitMergeWorktreeBranch(mainCwd, winner.branch))) {
            return { ok: false, output: "merge conflict — changes discarded; re-plan with disjoint files or sequential deps" };
          }
          // Exactly what OUR squash-merge added to the staged set — a RED gate
          // reverts THESE paths, leaving main clean, while a sibling's disjoint
          // staged changes (in preStaged) are untouched.
          const mergedFiles = (await gitStagedFiles(mainCwd)).filter((f) => !preStaged.has(f));
          if (wantsGate) {
            const gate = await runGate(mainCwd, profile!, 0, {
              checks: this.#handle.deps.config.build.gate.checks,
              timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
              // Confine repo-authored build scripts under the OS sandbox exactly
              // like the engine's own gate — orchestrator gates were unsandboxed.
              exec: bunExec(this.#handle.deps.sandbox),
              ...(parentSignal ? { signal: parentSignal } : {}),
            });
            if (gate.outcome === "red") {
              await gitRestoreFiles(mainCwd, mergedFiles);
              return { ok: false, output: `Ensemble winner passed in isolation but the MERGED tree is red (changes reverted):\n${formatGateFailure(gate, 1)}` };
            }
            if (gate.outcome === "aborted") {
              await gitRestoreFiles(mainCwd, mergedFiles);
              return { ok: false, output: "Gate interrupted before a verdict — merged changes reverted." };
            }
          }
          return { ok: true };
        },
      );
      if (!mergeVerdict.ok) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: mergeVerdict.output,
          attempts: n,
          ...(winner.handoff ? { handoff: winner.handoff } : {}),
        });
      }
      return settle({
        id: spec.id,
        objective: spec.objective,
        outcome: "completed",
        output: winnerReport,
        attempts: n,
        ...(winner.handoff ? { handoff: winner.handoff } : {}),
      });
    } finally {
      // Discard EVERY attempt's worktree + branch (the winner's merge is done, so
      // its branch is now redundant; losers are thrown away). Serialized so a
      // removal can't race a merge on the shared .git. A rejecting removal must
      // not abort the loop (leaking the remaining attempts' worktrees) or, from
      // this finally, clobber the already-settled result — swallow per iteration
      // (matches the worktree-path teardown).
      for (const a of attempts) {
        if (a.wt) await this.#mergeLock(() => gitRemoveWorktree(mainCwd, a.wtPath, a.branch)).catch(() => {});
      }
    }
  }

  /** One ensemble attempt: fork a child in its own worktree with a strategy
   * directive, commit its work, and score it by the in-worktree gate. */
  async #runEnsembleAttempt(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    i: number,
    baseRef: string,
    suspendParentSlot = true,
  ): Promise<EnsembleAttempt> {
    const mainCwd = this.#handle.deps.cwd;
    const profile = this.#handle.deps.repoProfile;
    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    const strategy = ENSEMBLE_STRATEGIES[i]!;
    const label = strategy.name;
    const wtId = `${worktreeSlug(spec.id)}-a${i}`;
    const wtPath = join(mainCwd, ".vibe", "worktrees", worktreePathName(this.#handle.id, wtId));
    const branch = worktreeBranch(this.#handle.id, wtId);
    const base: EnsembleAttempt = { i, label, wt: null, wtPath, branch, text: "", score: -1, diffSize: Infinity, verdict: "not-run" };

    // Track the worktree handle in the OUTER scope so a throw anywhere below still
    // returns it to the caller for cleanup. Without this, a throw from `runGate`/
    // `commitWorktree`/`gitDiffSince`/child-run rejected the caller's `Promise.all`
    // BEFORE its cleanup `finally` ran, leaking EVERY sibling attempt's worktree +
    // branch. #runEnsembleAttempt now never throws.
    let wt: Awaited<ReturnType<typeof gitAddWorktree>> = null;
    try {
      wt = await gitAddWorktree(mainCwd, { path: wtPath, branch });
      if (!wt) return { ...base, verdict: "worktree-unavailable" };
      const child = this.#forkChild(named, undefined, spec.tier, wt);
      if (!child) return { ...base, wt, verdict: "spawn-ceiling" };
      this.#handle.deps.bus.emit({ type: "subagent-started", sessionId: this.#handle.id, subagentId: child.id, prompt: spec.objective });
      const kickoff = `${buildTaskKickoff(spec, depResults, "")}\n\n${strategy.directive}`;
      const { timedOut, aborted } = await this.#runChildToCompletion(child, kickoff, parentSignal, suspendParentSlot);
      const outcome = this.#childOutcome(child, timedOut, aborted);
      this.#handle.deps.bus.emit({ type: "subagent-finished", sessionId: this.#handle.id, subagentId: child.id, result: outcome.event });
      const handoff = parseHandoff(outcome.text) ?? undefined;
      if (outcome.isError) return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), verdict: "child-error" };

      // Commit so the branch carries the work (squash-merge sees only commits) and
      // the in-worktree gate judges the committed state.
      const committed = await commitWorktree(wt, `vibecodr(ensemble ${spec.id} a${i}): ${spec.objective}`);
      if (!committed) return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), score: -1, verdict: "no-changes" };

      const diffSize = (await gitDiffSince(wt, baseRef)).length;
      let score = 1;
      let verdict = "unverified";
      if (profile) {
        const gate = await runGate(wt, profile, 0, {
          checks: this.#handle.deps.config.build.gate.checks,
          timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
          exec: bunExec(this.#handle.deps.sandbox),
          ...(parentSignal ? { signal: parentSignal } : {}),
        });
        // An interrupted gate (aborted) scores 0 alongside red: never select
        // work whose checks the user cut short — an unverified interrupt is not a
        // tiebreak-eligible "unverified" (score 1), it's a non-result.
        score = gate.outcome === "green" ? 2 : gate.outcome === "red" || gate.outcome === "aborted" ? 0 : 1;
        verdict = gate.outcome;
      }
      return { ...base, wt, text: outcome.text, ...(handoff ? { handoff } : {}), score, diffSize, verdict };
    } catch (err) {
      // Return the (possibly created) worktree so the caller's cleanup removes it.
      return { ...base, wt, verdict: "error", text: `ensemble attempt threw: ${(err as Error)?.message ?? String(err)}` };
    }
  }

  /** Run one orchestrator task in the SHARED tree: fork a subagent, thread in
   * dependency results + coordination, then (when `check`/`verify`) run the
   * repo's REAL checks and an adversarial diff review, retrying up to
   * verifyMaxAttempts. */
  async #runSharedTask(
    spec: TaskSpec,
    depResults: TaskResult[],
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<TaskResult> {
    const named = spec.agent ? this.#handle.deps.agents?.get(spec.agent) : undefined;
    // The retry budget spans BOTH the verify→retry loop and structured-output
    // enforcement — a task can be `verify:true` and/or carry an `outputSchema`.
    const maxAttempts = Math.max(
      spec.verify ? this.#handle.deps.config.subagent.verifyMaxAttempts : 1,
      spec.outputSchema ? this.#handle.deps.config.subagent.structuredMaxAttempts : 1,
      1,
    );
    const profile = this.#handle.deps.repoProfile;
    // Both `check:true` and `verify:true` run the real green-gate FIRST when a
    // profile exists — a red tree fails the attempt on machine truth without
    // spending an LLM review call. `verify` additionally gets the diff review.
    const wantsGate = (spec.check || spec.verify) && !!profile;
    const startedAt = Date.now();
    // Journal the task's start (best-effort — journaling never fails a run).
    this.#journal({
      type: "task-started",
      at: startedAt,
      id: spec.id,
      objective: spec.objective,
      deps: spec.deps,
      ...(spec.tier ? { tier: spec.tier } : {}),
      ...(spec.plan ? { plan: spec.plan } : {}),
    });

    let feedback = "";
    let attempts = 0;
    let handoff: Handoff | undefined;
    // Every terminal path records the report (store + persist + journal) and
    // stamps the wall-clock so the UIEvent + journal carry it.
    const settle = (partial: Omit<TaskResult, "durationMs">): TaskResult => {
      // The child's raw final message carries the ```handoff fence, already
      // parsed into the structured `handoff` field — strip it from the prose so
      // read_report, the planner summary, and dependents' kickoffs don't all
      // repeat the machine block as noise.
      const result: TaskResult = {
        ...partial,
        output: stripHandoffFence(partial.output),
        durationMs: Date.now() - startedAt,
      };
      this.#recordFinished(spec, result);
      return result;
    };

    while (attempts < maxAttempts) {
      attempts++;
      const child = this.#forkChild(named, undefined, spec.tier);
      if (!child) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "failed",
          output: this.#spawnCeilingError().output,
          attempts,
        });
      }
      this.#handle.deps.bus.emit({
        type: "subagent-started",
        sessionId: this.#handle.id,
        subagentId: child.id,
        prompt: spec.objective,
      });
      const { timedOut, aborted } = await this.#runChildToCompletion(
        child,
        buildTaskKickoff(spec, depResults, feedback),
        parentSignal,
        suspendParentSlot,
      );
      const outcome = this.#childOutcome(child, timedOut, aborted);
      this.#handle.deps.bus.emit({
        type: "subagent-finished",
        sessionId: this.#handle.id,
        subagentId: child.id,
        result: outcome.event,
      });
      if (outcome.isError) {
        return settle({ id: spec.id, objective: spec.objective, outcome: "failed", output: outcome.text, attempts });
      }
      // The structured handoff (if the child emitted one) rides to dependents
      // verbatim; the full prose is pull-only via read_report.
      handoff = parseHandoff(outcome.text) ?? undefined;

      // The report the task settles with — the validated JSON when an
      // outputSchema is set (below), otherwise the child's prose.
      let reportText = outcome.text;
      // Structured output: the FINAL message must be exactly one JSON object
      // matching spec.outputSchema. Validate BEFORE the gate/review so a mismatch
      // re-runs the child (with the errors as feedback) without spending a gate or
      // review call; on success the validated JSON becomes the report.
      if (spec.outputSchema) {
        const res = enforceSchema(outcome.text, spec.outputSchema);
        if (!res.ok) {
          feedback = `Your final message must be exactly one JSON object matching the required schema:\n${res.errors.map((e) => `- ${e}`).join("\n")}`;
          if (attempts < maxAttempts) continue; // re-run with the validation errors
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: `Structured output invalid after ${attempts} attempt(s):\n${feedback}\n\nRaw final message:\n${res.raw}`,
            attempts,
          });
        }
        reportText = res.json;
      }

      // Executable verify: run the real checks BEFORE any LLM review. A red gate
      // is machine truth — fail the attempt with the structured, actionable gate
      // output as the retry feedback, without burning a review call.
      if (wantsGate) {
        // Serialize the shared-tree gate through the SAME tree lock the worktree
        // path uses: `runGate` builds/tests the whole `cwd`, so two concurrent
        // shared `check` tasks (no deps → dispatched together) would run two
        // `build`/`test` processes in one dir, clobbering each other's outputs and
        // each seeing the OTHER task's edits — a nondeterministic verdict. The lock
        // also mutually-excludes shared gates from worktree merge/gate critical
        // sections so neither observes the other mid-write. Deadlock-free: runGate
        // acquires no fan-out slot, so the lock holder always makes progress.
        const gate = await this.#mergeLock(() =>
          runGate(this.#handle.deps.cwd, profile!, attempts - 1, {
            checks: this.#handle.deps.config.build.gate.checks,
            timeoutSec: this.#handle.deps.config.build.gate.timeoutSec,
            exec: bunExec(this.#handle.deps.sandbox),
            ...(parentSignal ? { signal: parentSignal } : {}),
          }),
        );
        // An interrupted gate is a terminal non-verdict: the user hit Esc, so
        // settle the task FAILED without a verdict and WITHOUT burning a retry —
        // an interrupt means "stop", never "try again". This must precede the red
        // branch so a killed check (nonzero exit) can't be re-run in a loop.
        if (gate.outcome === "aborted") {
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: "Gate interrupted before a verdict — task not verified.",
            attempts,
            ...(handoff ? { handoff } : {}),
          });
        }
        if (gate.outcome === "red") {
          feedback = formatGateFailure(gate, maxAttempts);
          if (attempts < maxAttempts) continue; // retry with the failing checks
          return settle({
            id: spec.id,
            objective: spec.objective,
            outcome: "failed",
            output: `Checks failed after ${attempts} attempt(s):\n${feedback}`,
            attempts,
            ...(handoff ? { handoff } : {}),
          });
        }
        // green or unverified → fall through to the diff review (for verify).
      }

      if (!spec.verify) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "completed",
          output: reportText,
          attempts,
          ...(handoff ? { handoff } : {}),
        });
      }
      const review = await this.#reviewTask(spec, reportText, parentSignal, suspendParentSlot);
      if (review.clean) {
        return settle({
          id: spec.id,
          objective: spec.objective,
          outcome: "completed",
          output: reportText,
          attempts,
          ...(handoff ? { handoff } : {}),
        });
      }
      feedback = review.feedback;
    }
    return settle({
      id: spec.id,
      objective: spec.objective,
      outcome: "failed",
      output: `Verification still failing after ${attempts} attempt(s):\n${feedback}`,
      attempts,
      ...(handoff ? { handoff } : {}),
    });
  }

  /** The isError result returned when the tree hits its subagent budget. Shared
   * so spawn_subagent and the task path word it identically. */
  #spawnCeilingError(): { output: string; isError: true } {
    const max = this.#handle.deps.config.subagent.maxTotal;
    return {
      output:
        `Subagent budget exhausted: this session tree has already spawned its ceiling of ${max} ` +
        "subagents (subagent.maxTotal). Do the remaining work directly, or narrow the plan — no more " +
        "children can be spawned this run.",
      isError: true,
    };
  }

  /**
   * Adversarial diff review of a finished task's work. The reviewer sees the REAL
   * unstaged diff of the task's declared files (not the child's self-report) plus
   * advisory stub-scan findings, and defaults to the `strong` tier when a `review`
   * agent isn't configured. Emits a one-time degradation notice in that case.
   */
  async #reviewTask(
    spec: TaskSpec,
    work: string,
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<{ clean: boolean; feedback: string }> {
    // Capture the diff, THEN review it (the review reads the captured diff, not the
    // live tree). Split so a caller holding the shared-tree merge lock can capture
    // INSIDE the lock and run the review child OUTSIDE it — see #reviewCapturedDiff.
    return this.#reviewCapturedDiff(spec, work, await this.#captureTaskDiff(spec), parentSignal, suspendParentSlot);
  }

  /**
   * Run the read-only review child against an ALREADY-captured diff. Deliberately
   * takes the diff as a param (not the live tree) so it can run OUTSIDE the
   * tree-global `#mergeLock`: the review child runs a full LLM turn and may itself
   * emit `spawn_tasks`, whose nested runner shares that same non-reentrant lock —
   * running it inside the lock would deadlock the whole tree. The diff is captured
   * by the caller inside the lock (tree stable), so the review still judges exactly
   * this task's merged changes.
   */
  async #reviewCapturedDiff(
    spec: TaskSpec,
    work: string,
    diff: string,
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<{ clean: boolean; feedback: string }> {
    const reviewAgent = this.#handle.deps.agents?.get("review");
    if (!reviewAgent && !this.#reviewDegradationWarned) {
      // LOUD once-per-session: a generic read-only child is a weaker reviewer than
      // a purpose-built `review` agent, and silent degradation hides that.
      this.#reviewDegradationWarned = true;
      this.#handle.deps.bus.emit({
        type: "notice",
        level: "warn",
        message:
          "No 'review' agent is configured — task verification is degraded to a generic read-only " +
          "reviewer. Add a `review` agent for higher-quality diff review.",
      });
    }
    const stubBlock =
      this.#handle.deps.config.build.review.stubScan && diff
        ? formatStubFindings(scanStubs(diff))
        : "";
    // Read-only reviewer; prefer the strong tier when the user configured one.
    const child = this.#forkChild(reviewAgent, "plan", "strong");
    if (!child) {
      // No reviewer could be spawned (budget) — do NOT pass it as clean; surface
      // the reason as feedback so the task fails rather than ships unreviewed.
      return { clean: false, feedback: this.#spawnCeilingError().output };
    }
    const prompt =
      `Review the work done for this task. Objective: ${spec.objective}\n` +
      (spec.files?.length ? `Files: ${spec.files.join(", ")}\n` : "") +
      `\nThe agent reported:\n${work}\n\n` +
      "The ACTUAL diff of the task's changes (authoritative — review THIS, not the report above):\n" +
      "```diff\n" +
      (diff ? capDiff(diff) : "(no textual diff — the task may have made no on-disk changes)") +
      "\n```\n" +
      (stubBlock
        ? `\nDeterministic stub-scan flagged these ADDED lines (advisory — verify each, some are false positives):\n${stubBlock}\n`
        : "") +
      "\nVerify against the diff and the files. Report concrete issues as `path:line — problem`, " +
      "or reply exactly REVIEW-CLEAN if the work is correct and complete.";
    await this.#runChildToCompletion(child, prompt, parentSignal, suspendParentSlot);
    const out = child.lastAssistantText();
    return { clean: isReviewClean(out), feedback: out || "(reviewer produced no output)" };
  }

  /** Capture the task's diff vs HEAD, scoped to its declared files (unscoped when
   * it declared none). Diffing against HEAD (not the bare unstaged `git diff`)
   * covers BOTH a shared-tree task (whose edits are unstaged) AND a worktree task
   * whose squash-merge STAGED its changes — a plain `git diff` would show an empty
   * diff for the latter. Falls back to the unstaged diff on an unborn HEAD (a
   * greenfield repo with no commit yet). Best-effort — on a git error, returns "". */
  async #captureTaskDiff(spec: TaskSpec): Promise<string> {
    const scope = spec.files?.length ? ["--", ...spec.files] : [];
    try {
      const r = await spawnGit(this.#handle.deps.cwd, ["diff", "HEAD", ...scope]);
      if (r.ok) return r.stdout;
      // Unborn HEAD (no commit yet) → fall back to the unstaged working diff.
      const bare = await spawnGit(this.#handle.deps.cwd, ["diff", ...scope]);
      return bare.ok ? bare.stdout : "";
    } catch {
      return "";
    }
  }

  /** Append an orchestration-journal event (best-effort — never fails a run). */
  #journal(event: Parameters<typeof appendOrchestrationEvent>[2]): void {
    try {
      appendOrchestrationEvent(this.#handle.deps.cwd, this.#handle.id, event);
    } catch {
      /* journaling is best-effort */
    }
  }

  /** Record a settled task: fill the in-memory report store, persist the full
   * report for a completed task (so read_report survives resume), and journal the
   * finish with its report path. All best-effort. */
  #recordFinished(spec: TaskSpec, result: TaskResult): void {
    this.#handle.deps.reportStore?.set(spec.id, { objective: spec.objective, output: result.output });
    let reportPath: string | undefined;
    if (result.outcome === "completed") {
      reportPath = persistTaskReport(this.#handle.deps.cwd, this.#handle.id, spec.id, result.output);
    }
    this.#journal({
      type: "task-finished",
      at: Date.now(),
      id: spec.id,
      objective: spec.objective,
      outcome: result.outcome,
      attempts: result.attempts,
      ...(result.handoff ? { handoff: result.handoff } : {}),
      ...(reportPath ? { reportPath } : {}),
      ...(spec.plan ? { plan: spec.plan } : {}),
    });
  }

  /**
   * Fork a subagent child for delegated work (shared by spawn_subagent and the
   * orchestrator). Resolves the named agent's mode/model/system and coerces the
   * child to plan mode when the parent is planning. Returns null when the tree
   * has hit its `subagent.maxTotal` spawn ceiling (the caller surfaces an error
   * to the model instead of throwing).
   *
   * The model is a *setting* — never model-chosen per call. Resolution chain:
   * named-agent model → `tier` model (a CONFIG string in build.models) →
   * subagent.model → the parent's model. A `tier` NEVER injects a
   * model-invented provider; it only reads config, so the Ollama-Cloud "gpt-4
   * subagent" class of bug can't recur through it.
   */
  #forkChild(
    named: NamedAgent | undefined,
    requestedMode: Mode | undefined,
    tier?: TaskSpec["tier"],
    cwdOverride?: string,
  ): Session | null {
    // Tree-global spawn ceiling: fail closed at the cap rather than let a runaway
    // model fan out forever (cost was previously the only backstop).
    const counter = this.#handle.deps.spawnCounter;
    if (counter && counter.used >= this.#handle.deps.config.subagent.maxTotal) return null;
    if (counter) counter.used++;

    const childMode: Mode = this.#parentPlanning()
      ? "plan"
      : (requestedMode ?? named?.mode ?? "execute");
    // Kickoff context injected into every child: the named agent's own system
    // block, plus the repo symbol map (engine-built, mtime-cached) so a fresh
    // child orients on the codebase's structure without re-deriving it — the
    // single cheapest way to stop children reinventing helpers/breaking callers.
    const extraSystem: string[] = [];
    if (named?.system) extraSystem.push(named.system);
    if (this.#handle.deps.repoMap) {
      extraSystem.push(
        `REPO SYMBOL MAP (files ranked by how load-bearing they are; top-level declarations):\n${this.#handle.deps.repoMap}`,
      );
    }
    const tierModel = tier ? this.#handle.deps.config.build.models[tier] : undefined;
    // The child streams onto its OWN bus (isolated from the parent's UI); we tap
    // it below to surface live activity.
    const childBus = new EventBusImpl();
    const child = this.#handle.fork({
      bus: childBus,
      model: named?.model ?? tierModel ?? this.#handle.deps.config.subagent.model ?? this.#handle.model,
      mode: childMode,
      goal: this.#handle.goal,
      depth: this.#handle.depth + 1,
      // A worktree/ensemble task redirects the child's whole toolset to its
      // isolated tree by overriding the fork's cwd (SessionDeps.cwd → every tool).
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
      ...(extraSystem.length ? { extraSystem } : {}),
      // A named agent's tool allowlist/denylist restricts the child's tools.
      ...(named?.tools || named?.denyTools
        ? { toolFilter: { ...(named.tools ? { allow: named.tools } : {}), ...(named.denyTools ? { deny: named.denyTools } : {}) } }
        : {}),
    });
    this.#tapChildActivity(child.id, childBus);
    return child;
  }

  /**
   * Live child activity: the child runs on an isolated bus, so subscribe to it
   * and re-emit a compact one-line `subagent-activity` onto the PARENT bus for
   * each tool-call-started / file-changed — so a minutes-long fan-out shows what
   * each child is doing right now, not just started/finished. Throttled to one
   * emit per 250ms per child (intermediate events are dropped, not queued), and
   * torn down by #runChildToCompletion when the child finishes.
   */
  #tapChildActivity(childId: string, childBus: EventBusImpl): void {
    const sub = childBus.subscribe();
    let lastEmit = 0;
    // Consume the child's stream; ends when the bus closes (stop() below).
    void (async () => {
      for await (const e of sub) {
        let label: string | undefined;
        if (e.type === "tool-call-started") label = activityLabel(e.toolName, e.input);
        else if (e.type === "file-changed") label = `✎ ${e.path}`;
        if (label === undefined) continue;
        const now = Date.now();
        if (now - lastEmit < ACTIVITY_THROTTLE_MS) continue; // drop intermediate
        lastEmit = now;
        this.#handle.deps.bus.emit({
          type: "subagent-activity",
          sessionId: this.#handle.id,
          subagentId: childId,
          label,
        });
      }
    })();
    // Closing the child bus drains any buffered events then ends the loop above.
    this.#childTaps.set(childId, () => childBus.close());
  }

  /** Emit `subagent-started` on the parent bus for `id`. */
  #emitStarted(id: string, prompt: string): void {
    this.#handle.deps.bus.emit({ type: "subagent-started", sessionId: this.#handle.id, subagentId: id, prompt });
  }

  /** Emit `subagent-finished` on the parent bus for `id`. */
  #emitFinished(id: string, result: string): void {
    this.#handle.deps.bus.emit({ type: "subagent-finished", sessionId: this.#handle.id, subagentId: id, result });
  }

  /** Whether a `detach:true` spawn actually runs in the background. Interactive
   * root sessions only, under the concurrency ceiling: a headless run's true
   * terminal signal is engine-idle (queue drain), which a background child would
   * outlive; and a detached grandchild spawned by a subagent would emit onto its
   * parent's torn-down bus. Both cases coerce detach to synchronous. */
  #detachAllowed(): boolean {
    return (
      this.#handle.deps.interactive === true &&
      this.#handle.depth === 0 &&
      this.#childRegistry.runningDetachedCount() < this.#handle.deps.config.subagent.maxDetached
    );
  }

  /** One-time notice that a requested detach was coerced to a synchronous run. */
  #warnDetachCoerced(): void {
    if (this.#detachCoercionWarned) return;
    this.#detachCoercionWarned = true;
    this.#handle.deps.bus.emit({
      type: "notice",
      level: "info",
      message:
        this.#handle.deps.interactive === true
          ? "Background subagents at capacity (or nested) — running this detach:true spawn synchronously."
          : "Background (detach:true) subagents need an interactive session — running synchronously instead.",
    });
  }

  /** The follow-up handle appended to a spawn_subagent result so the model knows
   * it can continue the child. Omitted when continuation is disabled. */
  #handleSuffix(id: string): string {
    return this.#handle.deps.config.subagent.retainCompleted > 0
      ? `\n\n(subagent id: ${id} — follow up with continue_subagent)`
      : "";
  }

  /** Retain a completed shared-tree spawn_subagent child for continue_subagent
   * (no-op when retention is disabled). */
  #retainCompleted(child: Session): void {
    this.#childRegistry.retain(child);
  }

  /**
   * Run a freshly-forked spawn_subagent child and produce its model-facing output.
   * The shared funnel for BOTH the synchronous and detached paths: it runs the
   * child (enforcing `outputSchema` when present), emits `subagent-finished`,
   * retains the child for continuation, and returns the capped text + error flag.
   */
  async #runSpawnedChild(
    child: Session,
    prompt: string,
    outputSchema: Record<string, unknown> | undefined,
    parentSignal: AbortSignal | undefined,
    // Whether the parent is AWAITING this child (holds a limiter slot to hand
    // back). False for a DETACHED child: the spawning turn already ended and
    // released the parent's slot, so suspending it would release a slot the
    // parent no longer holds and leak one on re-acquire — the detached child
    // takes its OWN slot when it runs.
    suspendParentSlot = true,
  ): Promise<{ text: string; isError: boolean }> {
    if (outputSchema) return this.#runStructured(child, prompt, outputSchema, parentSignal, suspendParentSlot);
    const { timedOut, aborted } = await this.#runChildToCompletion(child, prompt, parentSignal, suspendParentSlot);
    const outcome = this.#childOutcome(child, timedOut, aborted);
    this.#emitFinished(child.id, outcome.event);
    this.#retainCompleted(child);
    return { text: capSubagentOutput(outcome.text) + this.#handleSuffix(child.id), isError: outcome.isError };
  }

  /**
   * Enforce structured output: run the child, extract + validate its final JSON
   * against `schema`, and on a mismatch re-run the SAME child (keeping its
   * context) with the validation errors as feedback, up to
   * subagent.structuredMaxAttempts. Success → the validated JSON string is the
   * report. Final failure NEVER fabricates an object — it surfaces the errors plus
   * the raw text so the model can recover. Mirrors the #runSharedTask verify→retry
   * shape; keeps ONE activity tap across attempts and tears it down at the end.
   */
  async #runStructured(
    child: Session,
    basePrompt: string,
    schema: Record<string, unknown>,
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<{ text: string; isError: boolean }> {
    const maxAttempts = Math.max(1, this.#handle.deps.config.subagent.structuredMaxAttempts);
    let attempts = 0;
    let errors: string[] = [];
    let raw = "";
    try {
      while (attempts < maxAttempts) {
        attempts++;
        const runPrompt =
          attempts === 1 ? `${basePrompt}${structuredDirective(schema)}` : structuredRetryPrompt(errors);
        const { timedOut, aborted } = await this.#runChildOnce(child, runPrompt, parentSignal, suspendParentSlot);
        const outcome = this.#childOutcome(child, timedOut, aborted);
        if (outcome.isError) {
          // A timeout / interrupt / hard failure isn't a schema mismatch — surface
          // it directly rather than pretending it's retryable output.
          this.#emitFinished(child.id, outcome.event);
          this.#retainCompleted(child);
          return { text: capSubagentOutput(outcome.text), isError: true };
        }
        const result = enforceSchema(child.lastAssistantText(), schema);
        if (result.ok) {
          this.#emitFinished(child.id, result.json);
          this.#retainCompleted(child);
          // Pristine JSON — deliberately NO continue-handle suffix (it would break
          // a machine consumer). The child is still retained for follow-up.
          return { text: capSubagentOutput(result.json), isError: false };
        }
        errors = result.errors;
        raw = result.raw;
      }
      const msg =
        `Subagent output did not match the required JSON schema after ${attempts} attempt(s).\n` +
        `Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
        `Raw final message:\n${raw || "(empty)"}`;
      this.#emitFinished(child.id, `schema mismatch after ${attempts} attempt(s)`);
      this.#retainCompleted(child);
      return { text: capSubagentOutput(msg), isError: true };
    } finally {
      this.#teardownTap(child.id);
    }
  }

  /** Stop and drop a child's live-activity tap (closes its isolated bus). */
  #teardownTap(childId: string): void {
    const stopTap = this.#childTaps.get(childId);
    if (stopTap) {
      this.#childTaps.delete(childId);
      stopTap();
    }
  }

  /**
   * Run a forked child to completion through the fan-out gate + per-subagent
   * wall-clock timeout, propagating a parent abort and folding the child's
   * usage/cost up into this session, then tearing down its activity tap. Returns
   * whether the timeout fired. The single-run funnel used by every task path.
   */
  async #runChildToCompletion(
    child: Session,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<{ timedOut: boolean; aborted: boolean }> {
    try {
      return await this.#runChildOnce(child, prompt, parentSignal, suspendParentSlot);
    } finally {
      // Stop the live-activity tap now the child has finished emitting (closes its
      // isolated bus, which drains any buffered events then ends the tap loop).
      this.#teardownTap(child.id);
    }
  }

  /**
   * ONE run of a child through the gate + limiter-suspend + wall-clock timeout,
   * folding usage up on settle. Does NOT tear down the activity tap, so a
   * multi-attempt caller (structured enforcement) can keep it alive across
   * attempts and tear it down once at the end. `suspendParentSlot` is false for a
   * DETACHED child (the parent isn't awaiting it — see #runSpawnedChild).
   */
  async #runChildOnce(
    child: Session,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    suspendParentSlot = true,
  ): Promise<{ timedOut: boolean; aborted: boolean }> {
    const onAbort = () => child.abort();
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    // The child's actual provider run, guarded by the per-child wall-clock timeout.
    const invoke = (): Promise<void> => {
      // If the user aborted while this child was still queued, don't burn a
      // model call — the parent turn is already unwinding.
      if (parentSignal?.aborted) return Promise.resolve();
      // Wall-clock guard: a hung provider stream can't wedge the gate forever.
      const timeoutMs = this.#handle.deps.config.subagent.timeoutMs;
      if (!timeoutMs) return child.run(prompt);
      const timer = setTimeout(() => {
        timedOut = true;
        child.abort();
      }, timeoutMs);
      return child.run(prompt).finally(() => clearTimeout(timer));
    };
    try {
      // Bound concurrent fan-out: at most `subagent.maxParallel` children run at
      // once; extras queue. Parallel calls in one step share this gate.
      await this.#childGate(() =>
        // When the parent AWAITS this child it makes NO provider call, so hand its
        // tree-global limiter slot back for the child's span: a child inherits the
        // same limiter (fork), and without releasing here the parent's held slot +
        // the child's queued acquire is a hold-and-wait that deadlocks a deep or
        // recursive fan-out once the wall-clock escape above is disabled
        // (`subagent.timeoutMs:0`). Ref-counted in the Session, so N parallel
        // children release/re-acquire the one slot exactly once. A DETACHED child
        // is NOT awaited by a slot-holding parent, so it must NOT suspend — it
        // takes its own slot via child.run's own limiter guard.
        suspendParentSlot ? this.#handle.suspendLimiterSlot(invoke) : invoke(),
      );
    } finally {
      parentSignal?.removeEventListener("abort", onAbort);
    }
    // Fold the child's mutation flag + tokens + cost into the parent (the child
    // runs on an isolated bus), so auto-verify, `/cost`, and the spend guard all
    // account for delegated work.
    this.#handle.onChildSettled(child);
    // A parent abort that landed while this child was queued (the gate short-
    // circuit above) means the child never ran — surface it so #childOutcome
    // treats the task as interrupted, not a clean (empty) completion.
    return { timedOut, aborted: parentSignal?.aborted === true };
  }

  /** Normalize a finished child into a model-facing text + error flag + a short
   * event label, salvaging any partial output on timeout/failure. */
  #childOutcome(
    child: Session,
    timedOut: boolean,
    aborted = false,
  ): { text: string; isError: boolean; event: string } {
    const partial = child.lastAssistantText();
    if (timedOut) {
      const secs = Math.round(this.#handle.deps.config.subagent.timeoutMs / 1000);
      return {
        text:
          `Subagent timed out after ${secs}s and was stopped.` +
          (partial ? `\n\nPartial output before timeout:\n${partial}` : ""),
        isError: true,
        event: `timed out after ${secs}s`,
      };
    }
    // An interrupted child (Esc / steer aborted it, or it was aborted before it
    // ever ran because the parent turn was already unwinding) is NOT a clean
    // completion: its output is partial. Session marks a cancel as `interrupted`
    // (not `lastError`), so without this the outcome would fall through to
    // isError:false — and a task would be journaled "completed" and, for a
    // worktree task, its PARTIAL edits committed + squash-merged into the main
    // tree. Fail it instead so it re-runs on resume rather than silently losing work.
    if (child.interrupted || aborted) {
      return {
        text: partial
          ? `Subagent was interrupted before completing.\n\nPartial output before interruption:\n${partial}`
          : "Subagent was interrupted before completing (no output produced).",
        isError: true,
        event: "interrupted",
      };
    }
    if (child.lastError) {
      return {
        text: partial
          ? `Subagent failed: ${child.lastError}\n\nPartial output before failure:\n${partial}`
          : `Subagent failed: ${child.lastError}`,
        isError: true,
        event: `failed: ${child.lastError}`,
      };
    }
    const text =
      partial ||
      (child.didMutate
        ? "(subagent completed via tool calls but produced no written summary)"
        : "(subagent produced no output)");
    return { text, isError: false, event: text };
  }
}

/** Compose the self-contained kickoff prompt for an orchestrator task: the
 * objective, owned files, prerequisite handoffs, coordination reminder, the
 * handoff-block instruction, and (on a verify retry) the reviewer's feedback. */
function buildTaskKickoff(spec: TaskSpec, depResults: TaskResult[], feedback: string): string {
  const parts: string[] = [spec.objective];
  if (spec.files?.length) {
    parts.push(
      // Honest lock semantics: the claim registry rejects CONCURRENT writes while
      // another task holds a file; a later task can still touch a file an earlier,
      // already-finished task owned. So the guidance is disjointness, not a myth
      // that any shared path is hard-rejected regardless of timing.
      `Files you own (edit only these; while another task concurrently holds a file the engine rejects your write to it, so keep to your set): ${spec.files.join(", ")}`,
    );
  }
  if (depResults.length) {
    // Prefer the dependency's STRUCTURED handoff (its load-bearing facts,
    // verbatim) over a blind prose slice; either way point at read_report for the
    // full write-up so a dependent can pull detail on demand instead of drowning
    // in it by default.
    const summaries = depResults
      .map((d) =>
        d.handoff
          ? formatHandoffForKickoff(d.id, d.handoff)
          : `- [${d.id}] ${d.output.replace(/\s+/g, " ").trim().slice(0, 1_000)}\n  (full report: read_report("${d.id}"))`,
      )
      .join("\n");
    parts.push(`Results from the prerequisite tasks you depend on:\n${summaries}`);
  }
  parts.push(
    "You're one task in a coordinated plan. Use read_notes/post_note to see and share decisions with sibling tasks. Be self-contained, then report what you did and any follow-ups. Done only when the objective is fully met.",
  );
  if (feedback) {
    parts.push(`A previous attempt was reviewed and needs fixing before this is acceptable:\n${feedback}`);
  }
  // A structured task's final message must be ONLY JSON — the handoff fence would
  // violate that, so it replaces the handoff instruction with the schema directive.
  parts.push(spec.outputSchema ? structuredDirective(spec.outputSchema) : HANDOFF_INSTRUCTION);
  return parts.join("\n\n");
}

/** The first non-empty line of a prompt, trimmed and capped — a compact label for
 * a detached child in check_task + the background-finished surfacing. */
function firstLine(text: string): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * Whether a task reviewer's output is a CLEAN verdict. Requires `REVIEW-CLEAN` as
 * its own verdict at the start of a line — NOT a bare substring — so an
 * adversarial reviewer that writes "NOT REVIEW-CLEAN — path:line — problem" (or
 * "this is not REVIEW-CLEAN") is treated as feedback, not a pass whose concrete
 * issues get silently discarded. Biased to a re-review (false negative) over
 * shipping rejected work (false positive).
 */
export function isReviewClean(out: string): boolean {
  return /(^|\n)\s*REVIEW-CLEAN\b/.test(out);
}

/** One best-of-N ensemble attempt's outcome (see #runEnsembleAttempt). */
interface EnsembleAttempt {
  i: number;
  /** Short strategy name (for the no-winner summary). */
  label: string;
  /** The created worktree path, or null when it couldn't be created. */
  wt: string | null;
  wtPath: string;
  branch: string;
  /** The child's final report (the winner's becomes the task output). */
  text: string;
  handoff?: Handoff;
  /** green=2 / unverified=1 / red=0 / no-change (or failed to run)=-1. */
  score: number;
  /** Changed-file count vs the fork base — the smaller-diff tiebreak. */
  diffSize: number;
  /** Human-readable gate/failure verdict for the no-winner summary. */
  verdict: string;
}

/** Best-of-N ensemble strategies (ported from agentswarm): each attempt gets a
 * distinct directive appended to its kickoff so N children explore genuinely
 * different approaches rather than N near-identical ones. */
const ENSEMBLE_STRATEGIES: { name: string; directive: string }[] = [
  { name: "minimal-diff", directive: "Strategy directive: take a MINIMAL-DIFF approach — the smallest, most surgical change that fully satisfies the objective; touch as few lines as possible." },
  { name: "test-first", directive: "Strategy directive: take a TEST-FIRST approach — pin the desired behavior with tests first, then implement until they pass." },
  { name: "library-first", directive: "Strategy directive: take a LIBRARY-FIRST approach — prefer an existing dependency or stdlib primitive over hand-rolled code; reuse before you build." },
  { name: "first-principles", directive: "Strategy directive: take a FROM-FIRST-PRINCIPLES approach — derive the cleanest design directly from the requirements rather than the obvious patch." },
  { name: "defensive", directive: "Strategy directive: take a DEFENSIVE approach — prioritize edge cases, input validation, and clear error handling." },
];

/** At most one live-activity emit per child per this interval (drop intermediate). */
const ACTIVITY_THROTTLE_MS = 250;
const MAX_ACTIVITY_LABEL = 80;

/** A compact one-line label for a child's tool call: "$ <cmd head>" for bash,
 * "edit/read/write <path>" for the file tools, else the bare tool name. */
function activityLabel(toolName: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let label: string;
  if (toolName === "bash" && typeof inp.command === "string") {
    label = `$ ${inp.command.split("\n")[0]?.trim() ?? ""}`;
  } else if (typeof inp.path === "string" && (toolName === "edit" || toolName === "read" || toolName === "write")) {
    label = `${toolName} ${inp.path}`;
  } else {
    label = toolName;
  }
  return label.length > MAX_ACTIVITY_LABEL ? label.slice(0, MAX_ACTIVITY_LABEL) : label;
}

/** Filesystem-safe worktree id fragment (matches the journal's own sanitizer). */
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
}

/** A short stable hash of the FULL raw id — appended to the sanitized fragment so
 * two DAG-distinct ids that sanitize to the same string (e.g. `auth.login` and
 * `auth_login`, or two >64-char ids differing only past char 64) still get
 * DISTINCT worktree paths + branches. Without it, the second task's gitAddWorktree
 * would force-remove the first's live worktree. */
function idHash(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 8);
}

/** Collision-free, filesystem-safe worktree slug: the sanitized (capped) id plus
 * a short hash of the raw id. Both the worktree path and branch derive from this
 * ONE slug so they stay in lockstep. */
export function worktreeSlug(id: string): string {
  return `${sanitizeId(id)}-${idHash(id)}`;
}

/** The 8-char session tag both the path and the branch embed so two runners
 * sharing a cwd (concurrent sessions, or a re-submitted plan reusing a task id)
 * never collide on the same worktree directory — the `gitAddWorktree` stale
 * cleanup would otherwise `rm -rf` a live sibling's worktree mid-edit. */
function sessionTag(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "root";
}

/** The session-scoped worktree DIRECTORY name — the slug prefixed with the
 * session tag, mirroring the branch so path and branch stay in lockstep AND
 * are unique per session. */
export function worktreePathName(sessionId: string, slug: string): string {
  return `${sessionTag(sessionId)}-${slug}`;
}

/** The fresh branch name for a worktree task: `vibe-wt/<session-short>-<slug>`.
 * Takes an already-safe slug (from `worktreeSlug`) so it is never re-truncated —
 * truncating here would chop the disambiguating hash off the tail. */
function worktreeBranch(sessionId: string, slug: string): string {
  return `vibe-wt/${sessionTag(sessionId)}-${slug}`;
}
