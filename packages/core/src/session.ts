import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
} from "ai";
import {
  createId,
  makeYieldGate,
  type EngineSnapshot,
  type Message,
  type Mode,
  type Part,
  type RepoProfile,
  type Task,
  type TaskStatus,
  type UIEvent,
  type Usage,
} from "@vibe/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config, ModelPrice } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import {
  type Toolset,
  toAISDKTool,
  createSerialLock,
  type ToolRuntimeBase,
  type FileLock,
} from "@vibe/tools";
import type { HookBus, SkillRegistry } from "@vibe/plugins";
import type { EventBus } from "./event-bus.ts";
import { composeSystemPrompt, formatToday, formatWorkspaceState } from "./system-prompt.ts";
import { PermissionChecker, type PermissionResolver } from "./permissions.ts";
import type { NamedAgent } from "./agents.ts";
import { compactMessages, estimateTokens } from "./compaction.ts";
import { SourceLedger, harvestUrls, RESEARCH_TOOL_NAMES, type SourceEntry } from "./source-ledger.ts";
import { PlanGate } from "./plan-gate.ts";
import { globalStateDir } from "./state-dir.ts";
import {
  applyOffloads,
  planOffloads,
  pruneArtifacts,
  resultText as offloadResultText,
  type OffloadRecord,
} from "./microcompaction.ts";
import { formatRepoFacts } from "./build/profile.ts";
import type { SessionStore } from "./store.ts";
import { SESSION_META_VERSION } from "./store.ts";
import type { MemoryService } from "./memory-service.ts";
import { addUsage, computeCost, type TokenTotals } from "./usage.ts";
import {
  buildModelTuning,
  ANTHROPIC_CACHE_CONTROL,
  cacheTokensDisjointFromInput,
} from "./model-tuning.ts";
import type { ImageAttachment } from "./mentions.ts";
import { withRetry } from "./retry.ts";
import type { Limiter } from "./limiter.ts";
import type { Blackboard } from "./blackboard.ts";
import {
  OrchestratorRunner,
  type SessionHandle,
} from "./orchestration/orchestrator-runner.ts";
export { isReviewClean } from "./orchestration/orchestrator-runner.ts";
import { type ReportStore, buildReadReportTool } from "./orchestration/report-store.ts";
import type { ChildRegistry } from "./orchestration/child-registry.ts";
import type { Diagnostics } from "./diagnostics.ts";
import {
  buildUseSkillTool,
  buildRecallTool,
  buildRunCheckTool,
  buildSaveMemoryTool,
  buildPostNoteTool,
  buildReadNotesTool,
  buildTasksTool,
  type SessionToolsHandle,
} from "./session-tools.ts";
import type { SessionUsage } from "@vibe/shared";

const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Stream parts consumed between cooperative macrotask yields in #consume. */
const CONSUME_YIELD_PARTS = 50;
const COMPACT_KEEP_RECENT = 6;
/** Pre-first-step padding (tokens) for the unseen system prompt + tool schemas,
 * so a resumed/long session compacts before the real prompt blows the window.
 * Capped to 10% of the window at the call site for small local-model contexts. */
const COMPACT_OVERHEAD_MARGIN = 12_000;
/** Cap on the summarizer's own input (chars) — same bound buildDigest uses.
 * Compaction fires when context is near-full, so an uncapped transcript would
 * make the summarize call itself risk the window. */
const SUMMARY_INPUT_CAP = 24_000;

export interface SessionDeps {
  config: Config;
  registry: ProviderRegistry;
  toolset: Toolset;
  bus: EventBus;
  cwd: string;
  model: string;
  mode: Mode;
  goal?: string | null;
  projectMemory?: string;
  permissionResolver?: PermissionResolver;
  /** Extra system-prompt blocks (e.g. a named agent's instructions). */
  extraSystem?: string[];
  /** Restrict this (sub)agent's tools to an allowlist / minus a denylist (from a
   * named agent's frontmatter). Applied to the assembled tool map each turn. */
  toolFilter?: { allow?: string[]; deny?: string[] };
  /** Named subagents available to spawn. */
  agents?: Map<string, NamedAgent>;
  /** Deterministic repo recon (build/profile.ts), set by the engine after
   * bootstrap. Rides `...this.#deps` into every fork, so the whole session tree
   * knows the repo's REAL build/test commands without re-probing. */
  repoProfile?: RepoProfile;
  /** Token-budgeted repo symbol map (built once by the engine, mtime-cached
   * upstream) injected into subagent kickoffs so children orient instantly. */
  repoMap?: string;
  /** Per-file write CLAIM registry shared across the session tree (set by the
   * engine). Forks inherit it via `...this.#deps`; each session injects its own
   * id as the owner, so a concurrent write from a different subagent to a file
   * another already owns is hard-rejected (FileOwnedError) while same-agent
   * writes serialize. */
  fileLock?: FileLock;
  /** Long-term memory (hybrid recall + save). When present, recall_memory does
   * semantic+lexical search over saved memory and sessions, and save_memory is
   * offered; when absent, recall_memory degrades to lexical session search. */
  memory?: MemoryService;
  /** Skills available for progressive disclosure via `use_skill`. */
  skills?: SkillRegistry;
  /** Plugin hook bus for tool.before/after.execute and assistant.message. */
  hooks?: HookBus;
  /** Subagent recursion depth (0 = root). */
  depth?: number;
  /** Tree-global adaptive concurrency gate in front of every provider call,
   * shared across the session tree (forks inherit it via `...this.#deps`). */
  limiter?: Limiter;
  /** Shared coordination board for parallel subagents (post_note / read_notes),
   * shared across the tree like the file lock. */
  blackboard?: Blackboard;
  /** Tree-shared store of finished orchestrator task reports: `read_report`
   * reads it, the runner fills it as tasks settle. Created lazily by the root
   * runner when absent; forks inherit the SAME object via `...this.#deps`, so a
   * dependent task (a fork) can pull a dependency's FULL report. */
  reportStore?: ReportStore;
  /** Diagnostics seam (engine-owned, tree-shared via forks): edit/write append
   * its output. TS-only (`TsDiagnostics`) or multi-language (`CompositeDiagnostics`
   * over LSP). Absent → no-op. */
  diagnostics?: Diagnostics;
  /** Tree-global spawn ledger: total subagents spawned across the session tree,
   * the backstop against a runaway model (capped at subagent.maxTotal). Created
   * lazily by the root runner; forks inherit the SAME object via `...this.#deps`. */
  spawnCounter?: { used: number };
  /** Whether a UI can drive interactive prompts (the engine is attached to a
   * TUI). Threaded from the engine so subagent `detach` is coerced to synchronous
   * in headless `-p` runs — a detached child would outlive the queue-drain
   * (engine-idle) terminal signal. Forks inherit it via `...this.#deps`. */
  interactive?: boolean;
  /** Tree-shared registry of retained (continue_subagent) + detached (background)
   * subagent children. Created lazily by the root runner; forks inherit the SAME
   * object via `...this.#deps`, like reportStore. */
  childRegistry?: ChildRegistry;
  /** Tree-shared serial lock for the ONE shared `.git`/working tree: every
   * worktree merge+gate and shared-tree gate across the WHOLE session tree —
   * including NESTED `spawn_tasks` runners — serializes through it, so two runners
   * can't race `.git/index`. Created lazily by the root runner; forks inherit the
   * SAME lock via `...this.#deps`. */
  mergeLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  id?: string;
  /** Persistence backend; when set, the session is saved after each turn. */
  store?: SessionStore;
  /** Seed context/history when resuming a persisted session. */
  initialModelMessages?: ModelMessage[];
  initialHistory?: Message[];
  /** Seed the working task list when resuming a persisted session. */
  initialTasks?: Task[];
  /** Seed cumulative token usage when resuming a persisted session. */
  initialUsage?: TokenTotals;
  /** Seed the last turn's REAL provider input-token count when resuming, so the
   * first resumed turn's compaction trigger uses the true prior prompt size
   * instead of the system/tool-overhead-blind estimate (which can under-fire
   * and ship an over-window prompt straight into a provider 400). */
  initialLastInputTokens?: number;
  /** Seed accrued cost (USD) when resuming a persisted session. */
  initialCostUSD?: number;
  /** Seed the recalled-context block when resuming a persisted session. */
  initialRecalledContext?: string;
  /** Seed the web-source ledger when resuming, so `[n]` citations still resolve. */
  initialSources?: SourceEntry[];
  createdAt?: number;
  /** Resolve the active model's context window (for compaction). */
  getContextWindow?: (model: string) => Promise<number | undefined>;
  /** Resolve the active model's price (USD per 1M tokens) for cost tracking. */
  getPricing?: (model: string) => Promise<(ModelPrice & { estimated?: boolean }) | undefined>;
}

/**
 * One stateful agent conversation. `run()` executes a full multi-step agentic
 * turn via the AI SDK and emits `UIEvent`s. Subagents are forks of a Session.
 */
export class Session {
  readonly id: string;
  model: string;
  mode: Mode;
  goal: string | null;
  busy = false;

  #deps: SessionDeps;
  #modelMessages: ModelMessage[];
  #history: Message[];
  #tasks: Task[];
  #usage: TokenTotals;
  /** The provider's real input-token count for the last step — the TRUE current
   * context size (system prompt + tool schemas + messages + cache), far more
   * accurate than the JSON estimate. 0 until the first step reports usage. */
  #lastInputTokens = 0;
  /** Context window resolved for the current model (cached per turn). */
  #contextWindow = DEFAULT_CONTEXT_WINDOW;
  /** Cost accrued per step at the price in effect then (correct across model switches). */
  #costUSD: number;
  #price: (ModelPrice & { estimated?: boolean }) | undefined;
  #turnMutated = false;
  /** Set once the session's cumulative cost crosses the configured budget. */
  #budgetTripped = false;
  #createdAt: number;
  /** Proactively-recalled context injected into the system prompt (opt-in). */
  #recalledContext: string | undefined;
  #abort = new AbortController();
  /** The subagent / task-DAG machinery (spawn_subagent, spawn_tasks, the fork →
   * run → review → retry pipeline). Owns the per-session fan-out gate. */
  #runner: OrchestratorRunner;
  /** The narrow view of this session handed to the runner + leaf tool factories. */
  #handle: SessionHandle & SessionToolsHandle;
  /** The last turn's fatal error message, if any (null on success). Lets a
   * parent detect a failed subagent — the child runs on an isolated bus so its
   * `engine-error` never reaches the parent UI. */
  #lastError: string | null = null;
  /** Whether the last turn ended because the user cancelled it (Esc / steer /
   * spend-stop) rather than completing or erroring. Drives "don't auto-verify a
   * turn the user interrupted" and keeps a cancel from being painted as a fault. */
  #interrupted = false;
  /** Mode captured at run() start (null before the first turn) — see turnMode. */
  #turnMode: Mode | null = null;
  /** Messages from each COMPLETED step of the current turn (buffered in
   * onStepFinish). On an abort/error mid-turn `result.response` rejects, so these
   * matched tool_use/tool_result pairs would otherwise be lost — a resumed
   * session wouldn't know about a completed edit. Committed on the failure path. */
  #committedSteps: ModelMessage[] = [];
  /** Per-turn record of which tool calls ended in a handled error (permission
   * deny, plugin veto, or an `isError` execute result). The AI-SDK reports these
   * as ordinary string results, so the stream's `tool-result` part carries no
   * error flag; this side-channel lets `#consume` mark them correctly. Keyed by
   * toolCallId; populated by the tool adapter before the result part is emitted. */
  #toolCallErrors = new Map<string, boolean>();
  /** webfetch tool-call id → the URL it was asked to fetch. `webfetch`'s OUTPUT is
   * the page BODY, so harvesting URLs from it records arbitrary in-page links
   * (ads, "related", footnotes) as if the agent fetched them, while the URL it
   * actually fetched goes unrecorded. We capture the INPUT url here and record
   * THAT on success instead. */
  #fetchInputUrls = new Map<string, string>();
  /** Tool results offloaded to session artifacts (mid-turn microcompaction),
   * keyed by toolCallId. In-memory only: persisted messages carry the previews
   * themselves, so `--resume` needs no extra state. */
  #offloaded = new Map<string, OffloadRecord>();
  /** The provider's real system+tools+cache overhead beyond the message-text
   * estimate, measured from step usage — anchors the mid-turn fill projection
   * (the raw estimate can't see prompt scaffolding). */
  #overheadTokens = 0;
  /** Estimated token size of the exact message array sent on the last step (set
   * in prepareStep). Overhead = real inputTokens − this, so it isolates the
   * system+tools scaffolding WITHOUT re-counting the within-turn tail the older
   * "estimate of #modelMessages" formula folded in (which fired offloads early). */
  #lastSentEstimate = 0;
  /** This session's web-source ledger: URLs harvested from web_search/webfetch/
   * crawl_docs results, deduped + stably numbered. Injected into the system
   * prompt so the model cites `[n]` consistently, and shown by `/sources`. A
   * fresh instance per Session — forks (new Session) get their own, never the
   * parent's, so a subagent's reads don't re-harvest into the parent. */
  #sources = new SourceLedger();
  /** Plan-readiness gate for the CURRENT plan cycle (undefined outside plan
   * mode). Created lazily on the first plan-mode turn; triage accumulates
   * across revision prompts and telemetry across the whole cycle; retired by
   * setMode when the session leaves plan mode. */
  #planGate: PlanGate | undefined;
  /** The gate the CURRENT turn started with. A mid-turn mode switch retires
   * #planGate, but the in-flight plan turn must keep counting telemetry and
   * evaluating present_plan against the gate it began under — not silently
   * lose both to the live field going undefined. Reassigned at every run(). */
  #turnGate: PlanGate | undefined;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.id = deps.id ?? createId("ses");
    this.model = deps.model;
    this.mode = deps.mode;
    this.goal = deps.goal ?? null;
    this.#modelMessages = deps.initialModelMessages ?? [];
    this.#history = deps.initialHistory ?? [];
    this.#tasks = deps.initialTasks ?? [];
    this.#usage = {
      inputTokens: deps.initialUsage?.inputTokens ?? 0,
      outputTokens: deps.initialUsage?.outputTokens ?? 0,
      // Preserve the cumulative cache-read total across --resume, so the restored
      // session's cost/usage reporting doesn't silently reset it to zero.
      ...(deps.initialUsage?.cachedInputTokens
        ? { cachedInputTokens: deps.initialUsage.cachedInputTokens }
        : {}),
    };
    this.#costUSD = deps.initialCostUSD ?? 0;
    this.#lastInputTokens = deps.initialLastInputTokens ?? 0;
    this.#recalledContext = deps.initialRecalledContext;
    if (deps.initialSources?.length) this.#sources.hydrate(deps.initialSources);
    this.#createdAt = deps.createdAt ?? Date.now();
    this.#handle = this.#buildHandle();
    this.#runner = new OrchestratorRunner(this.#handle);
  }

  /** The narrow, live view of this session the runner + leaf tool factories use.
   * Getters keep mode/model/goal in sync as the session mutates them. */
  #buildHandle(): SessionHandle & SessionToolsHandle {
    const self = this;
    return {
      get id() {
        return self.id;
      },
      get model() {
        return self.model;
      },
      get mode() {
        return self.mode;
      },
      get goal() {
        return self.goal;
      },
      get depth() {
        return self.depth;
      },
      get deps() {
        return self.#deps;
      },
      fork: (overrides) => self.fork(overrides),
      onChildSettled: (child) => self.#foldChildUsage(child),
      suspendLimiterSlot: (fn) => self.suspendLimiterSlot(fn),
      setTasks: (incoming) => self.setTasks(incoming),
      patchTasks: (updates, add) => self.patchTasks(updates, add),
    };
  }

  /** Fold a settled subagent's mutation flag + usage + cost up into this session
   * (the child runs on an isolated bus), so auto-verify, `/cost`, and the spend
   * guard all account for delegated work. */
  #foldChildUsage(child: Session): void {
    // A child that actually mutated the workspace makes THIS turn a mutating one
    // (so auto-verify runs); a read-only investigation child does not.
    if (child.didMutate) this.#turnMutated = true;
    addUsage(this.#usage, child.usage);
    this.#costUSD += child.costUSD;
    this.#deps.bus.emit({ type: "usage-updated", sessionId: this.id, usage: this.#usageSnapshot() });
    this.#enforceBudget();
  }

  snapshot(): EngineSnapshot {
    return {
      sessionId: this.id,
      model: this.model,
      mode: this.mode,
      goal: this.goal,
      history: this.#history,
      // Copies, matching #emitTasks — a snapshot must not alias the live list.
      tasks: this.#tasks.map((t) => ({ ...t })),
      usage: this.#usageSnapshot(),
      busy: this.busy,
      theme: this.#deps.config.theme,
      accentColor: this.#deps.config.accentColor,
      approvalMode: this.#deps.config.approvalMode,
      // Filled by the engine, which owns the command/skill registries + git.
      commandNames: [],
    };
  }

  /** Current cumulative token + accrued-cost view for the UI. */
  #usageSnapshot(): SessionUsage {
    return {
      inputTokens: this.#usage.inputTokens,
      outputTokens: this.#usage.outputTokens,
      totalTokens: this.#usage.inputTokens + this.#usage.outputTokens,
      costUSD: this.#costUSD,
      // The cost is an estimate when the active price came from a base-model
      // catalog fallback (e.g. an Ollama Cloud tag) rather than an exact entry.
      ...(this.#price?.estimated && this.#costUSD > 0 ? { costEstimated: true } : {}),
      ...(this.#usage.cachedInputTokens
        ? { cachedInputTokens: this.#usage.cachedInputTokens }
        : {}),
    };
  }

  /**
   * Enforce the configured spend guard against cumulative cost. Warns once per
   * crossing; under `stop`, also aborts the active turn. Returns true if the
   * budget is exceeded.
   */
  #enforceBudget(): boolean {
    const budget = this.#deps.config.budget;
    if (!budget.limitUSD || this.#costUSD < budget.limitUSD) return false;
    if (!this.#budgetTripped) {
      this.#budgetTripped = true;
      this.#deps.bus.emit({
        type: "notice",
        level: "warn",
        message: `Spend limit reached: $${this.#costUSD.toFixed(4)} ≥ $${budget.limitUSD} (${budget.onExceed}).`,
      });
      // Only HARD-STOP on cost we actually know. An `estimated` price is a
      // base-model catalog guess (e.g. a local `lmstudio/…`/`ollama/…` tag that
      // inherited a cloud namesake's rate for a model that may be genuinely free)
      // — aborting a session on phantom spend is worse than letting it run. The
      // warn above still fires so the user sees the (estimated) crossing.
      if (budget.onExceed === "stop" && !this.#price?.estimated) this.#abort.abort();
    }
    return true;
  }

  /** Cumulative token totals for this session (for persistence/diagnostics). */
  get usage(): TokenTotals {
    return { ...this.#usage };
  }

  /** Accrued cost in USD for this session (incl. folded-in subagent cost). */
  get costUSD(): number {
    return this.#costUSD;
  }

  /** The last turn's fatal error message, or null if it succeeded. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** Whether the last turn was cancelled by the user (Esc / steer / spend-stop). */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  /** The current working task list (live reference; treat as read-only). */
  get tasks(): Task[] {
    return this.#tasks;
  }

  /** This session's web-source ledger (for `/sources` and diagnostics). */
  get sources(): SourceLedger {
    return this.#sources;
  }

  /** Whether the most recent turn ran a side-effecting (non-read-only) tool. */
  get didMutate(): boolean {
    return this.#turnMutated;
  }

  /** The mode the most recent turn STARTED in. Post-turn gating must judge a
   * turn by what it was — a mid-turn Shift+Tab to plan must not let a mutating
   * execute turn skip the green gate (or the UNVERIFIED honesty notice). */
  get turnMode(): Mode {
    return this.#turnMode ?? this.mode;
  }

  /** This session's working directory (a fork's, if redirected into a worktree).
   * Read by the child registry to decide whether a completed child is safe to
   * retain: a child whose cwd left the shared tree is torn down with its worktree. */
  get cwd(): string {
    return this.#deps.cwd;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    // A plan cycle's readiness gate (triage + research telemetry) is scoped to
    // one continuous stay in plan mode — leaving it retires the gate so a later
    // plan cycle starts with fresh requirements and counters.
    if (mode !== "plan") this.#planGate = undefined;
    this.#deps.bus.emit({ type: "mode-changed", sessionId: this.id, mode });
  }

  setModel(model: string): void {
    this.model = model;
    this.#deps.bus.emit({ type: "model-changed", sessionId: this.id, model });
  }

  setGoal(goal: string | null): void {
    this.goal = goal;
    this.#deps.bus.emit({ type: "goal-changed", sessionId: this.id, goal });
  }

  /** Replace the injected project-memory block (e.g. after `/init` scaffolds
   * VIBE.md or the agent saves a memory) so the next turn's system prompt
   * reflects it without a restart. The prompt is rebuilt from this each turn. */
  setProjectMemory(text: string | undefined): void {
    this.#deps.projectMemory = text;
  }

  /** Attach the long-term memory service (created asynchronously after the
   * session is constructed, once the embedder has been resolved). */
  setMemory(memory: MemoryService): void {
    this.#deps.memory = memory;
  }

  /** Attach the deterministic repo recon (computed asynchronously by the
   * engine's bootstrap). Lands on #deps so forks spawned afterwards inherit it
   * and every subsequent turn's prompt carries the REPO FACTS block. */
  setRepoProfile(profile: RepoProfile, repoMap?: string): void {
    this.#deps.repoProfile = profile;
    if (repoMap !== undefined) this.#deps.repoMap = repoMap;
  }

  /** The active repo recon, if the engine attached one. */
  get repoProfile(): RepoProfile | undefined {
    return this.#deps.repoProfile;
  }

  /** The tree-shared child registry (continuation LRU + detached tracking), once
   * the root runner has created it. The engine reaches it through here to abort +
   * await outstanding detached (background) subagents on finalize. */
  get childRegistry(): ChildRegistry | undefined {
    return this.#deps.childRegistry;
  }

  /** Point this (sub)agent session's event bus at a fresh one. Used when a
   * retained child is resumed via `continue_subagent`: its original isolated bus
   * was closed when its last run settled, so it needs a live bus to emit onto.
   * Each Session owns its own `#deps` object (fork spreads a copy), so this never
   * affects the parent's or a sibling's bus. */
  rebindBus(bus: EventBus): void {
    this.#deps.bus = bus;
  }

  /** Set the proactively-recalled context block injected into the system prompt
   * (cleared on /clear). Set once at session start by the engine when
   * `memory.proactiveRecall` is enabled. */
  setRecalledContext(text: string | undefined): void {
    this.#recalledContext = text;
  }

  abort(): void {
    // Just signal the current turn. The fresh controller is installed at the
    // top of the NEXT run()/compact() — recreating it here would discard an
    // abort that lands during a turn's pre-stream prep (model resolve, pricing,
    // compaction), letting the turn proceed against a non-aborted signal.
    this.#abort.abort();
  }

  /** The active turn's abort signal — read by post-turn steps (the green-gate,
   * verify) that run in the engine AFTER `run()` resolves but BEFORE the next
   * `run()` installs a fresh controller, so an Esc during a long gate/build
   * aborts it instead of being ignored until the per-check timeout. */
  get abortSignal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Is the active turn's signal aborted? (the user pressed Esc / steered). */
  #aborted(): boolean {
    return this.#abort.signal.aborted;
  }

  /** True when `err` represents the turn being cancelled rather than failing. */
  #isAbortError(err: unknown): boolean {
    if (this.#aborted()) return true;
    const name = (err as { name?: string })?.name;
    return name === "AbortError" || name === "NoOutputGeneratedError";
  }

  /** Run a provider call through the tree-global limiter when one is wired (so
   * fan-out can't stampede the provider); otherwise run it directly. The turn's
   * abort signal is threaded in so a queued acquire is abandoned on cancel/
   * timeout — a nested subagent stuck waiting for a slot must be able to unwind,
   * or a deep fan-out that over-subscribes the tree-global ceiling deadlocks. */
  #withLimiter<T>(fn: () => Promise<T>): Promise<T> {
    return this.#deps.limiter ? this.#deps.limiter.run(fn, this.#abort.signal) : fn();
  }

  /** Ref-count of in-flight limiter-slot suspensions. N spawn tools running in
   * ONE step each open a suspension; only the 0→1 transition releases the slot and
   * only the 1→0 transition re-acquires it, so a whole fan-out releases/re-acquires
   * the parent's single slot exactly once. */
  #limiterSuspends = 0;

  /**
   * Release this session's tree-global limiter slot for the span of `fn`, then
   * re-acquire it. A parent that spawns children holds ONE whole-turn slot for the
   * entire turn — including the tool-execution window in which it AWAITS those
   * children. But during that await the parent makes no provider call, and its
   * children (inheriting the same limiter via fork) queue on it: a hold-and-wait
   * that deadlocks a deep/recursive fan-out once the per-child wall-clock timeout
   * is disabled (`subagent.timeoutMs:0`). Handing the slot back for the child's
   * span lets a queued child acquire it — TIGHTENING the provider-concurrency
   * invariant, since the parent isn't calling the provider anyway.
   *
   * Ref-counted so N parallel spawns in one step map to exactly one release +
   * re-acquire. The re-acquire deliberately takes NO abort signal: the release/
   * acquire pairing MUST complete or `run()`'s finally over-decrements the
   * limiter's `active`; a pending abort still unwinds via the child's own abort and
   * the next `streamText` step observing the signal. No-op when no limiter is wired.
   */
  async suspendLimiterSlot<T>(fn: () => Promise<T>): Promise<T> {
    const limiter = this.#deps.limiter;
    if (!limiter) return fn();
    if (++this.#limiterSuspends === 1) limiter.releaseSlot();
    try {
      return await fn();
    } finally {
      if (--this.#limiterSuspends === 0) await limiter.acquireSlot();
    }
  }

  /**
   * Resolve the active model, failing over through `config.modelFallbacks` when
   * the primary can't be resolved (missing key / unknown provider). A successful
   * fallback SWITCHES the session's model (visible: notice + model-changed) —
   * silent per-turn substitution would misreport cost/context and surprise the
   * user harder than an explicit switch.
   */
  async #resolveWithFallback(
    registry: ProviderRegistry,
    config: Config,
  ): Promise<LanguageModel> {
    const retryOpts = {
      maxAttempts: config.retry.maxAttempts,
      baseDelayMs: config.retry.baseDelayMs,
    };
    try {
      return await withRetry(() => registry.resolveModel(this.model, config), retryOpts);
    } catch (primaryErr) {
      for (const fallback of config.modelFallbacks) {
        if (fallback === this.model) continue;
        try {
          const resolved = await withRetry(() => registry.resolveModel(fallback, config), retryOpts);
          this.#deps.bus.emit({
            type: "notice",
            level: "warn",
            message: `Model ${this.model} unavailable (${(primaryErr as Error).message}) — failing over to ${fallback}.`,
          });
          this.setModel(fallback);
          return resolved;
        } catch {
          /* try the next fallback */
        }
      }
      throw primaryErr;
    }
  }

  /** A marker of the current conversation length (for checkpoint rollback). */
  conversationMark(): { messages: number; history: number } {
    return { messages: this.#modelMessages.length, history: this.#history.length };
  }

  /**
   * Roll the conversation back to a previous mark (after `/undo` reverts files),
   * so the model context no longer claims edits that were just undone.
   */
  rewindConversation(mark: { messages: number; history: number }): void {
    if (mark.messages < this.#modelMessages.length) {
      this.#modelMessages = this.#modelMessages.slice(0, mark.messages);
    }
    if (mark.history < this.#history.length) {
      this.#history = this.#history.slice(0, mark.history);
    }
  }

  /** Reset conversation history (model context and UI history). */
  clear(): void {
    this.#modelMessages = [];
    this.#history = [];
    this.#recalledContext = undefined;
    if (this.#tasks.length) this.setTasks([]);
    this.#deps.bus.emit({
      type: "notice",
      level: "info",
      message: "Conversation cleared.",
    });
  }

  /** Number of model messages currently in context (for diagnostics/compaction). */
  get messageCount(): number {
    return this.#modelMessages.length;
  }

  /** Tokens currently held in the model context (for /status, /context): the
   * provider's real last-step input count when known, else a JSON estimate. */
  get contextTokens(): number {
    return this.#lastInputTokens || estimateTokens(this.#modelMessages);
  }

  /** Subagent recursion depth (0 = root). */
  get depth(): number {
    return this.#deps.depth ?? 0;
  }

  /** The concatenated text of the most recent assistant message. */
  lastAssistantText(): string {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const m = this.#history[i];
      if (m && m.role === "assistant") return messageText(m);
    }
    return "";
  }

  /**
   * Replace the working task list. Reuses the id of any existing task with the
   * same title so UI list keys stay stable across updates. Emits `tasks-updated`.
   */
  setTasks(incoming: { title: string; status: TaskStatus }[]): Task[] {
    const byTitle = new Map(this.#tasks.map((t) => [t.title, t]));
    this.#tasks = incoming.map((t) => ({
      id: byTitle.get(t.title)?.id ?? createId("task"),
      title: t.title,
      status: t.status,
    }));
    this.#emitTasks();
    return this.#tasks;
  }

  /** Emit the task list as a FRESH array of copies. The bus is in-process, so
   * emitting `this.#tasks` itself hands every subscriber the same mutable
   * references — the TUI's signal then sees an identical array on the next
   * patch and never re-renders (the "Tasks stuck at 0/N" bug). */
  #emitTasks(): void {
    this.#deps.bus.emit({
      type: "tasks-updated",
      sessionId: this.id,
      tasks: this.#tasks.map((t) => ({ ...t })),
    });
  }

  /**
   * Patch the task list in place: status updates addressed by 1-based position
   * (the `t<N>` short ids the model sees in CURRENT TASKS), plus appended new
   * tasks. Partial by design — no verbatim-title matching, so a weak model can
   * flip one task without re-sending (and possibly rewording) the whole list.
   * Out-of-range indices are ignored (reported by the tool layer). Emits
   * `tasks-updated`.
   */
  patchTasks(
    updates: { index: number; status: TaskStatus }[],
    add: string[] = [],
  ): { tasks: Task[]; applied: number; ignored: number[] } {
    let applied = 0;
    const ignored: number[] = [];
    for (const u of updates) {
      const task = this.#tasks[u.index - 1];
      if (task) {
        // Replace, don't mutate: an in-place status write leaves list consumers
        // holding the same object, which defeats identity-based change detection.
        this.#tasks[u.index - 1] = { ...task, status: u.status };
        applied++;
      } else {
        ignored.push(u.index);
      }
    }
    for (const title of add) {
      const trimmed = title.trim();
      if (trimmed) this.#tasks.push({ id: createId("task"), title: trimmed, status: "pending" });
    }
    this.#emitTasks();
    return { tasks: this.#tasks, applied, ignored };
  }

  /** Execute one agentic turn for `input`. Resolves when the turn ends. */
  async run(
    input: string,
    images: ImageAttachment[] = [],
    opts: { display?: string | null } = {},
  ): Promise<void> {
    const { bus, registry, toolset, config } = this.#deps;
    this.busy = true;
    this.#turnMutated = false;
    this.#turnMode = this.mode;
    this.#lastError = null;
    this.#interrupted = false;
    this.#toolCallErrors.clear();
    this.#committedSteps = [];
    // Fresh abort controller for THIS turn. Installed here (not in abort()) so a
    // cancel that arrives mid-turn aborts this turn's signal and the NEXT turn
    // still starts clean — and so a steered prompt isn't run against a stale,
    // already-aborted controller.
    this.#abort = new AbortController();

    // The user/history messages pushed for THIS turn (captured after #pushUser),
    // so an interrupt/error BEFORE any assistant reply is committed can roll them
    // back — otherwise the orphan user turn leaves two consecutive user messages
    // for the next turn (a 400 on strict providers) and pollutes `--resume`.
    let userMsgRef: ModelMessage | undefined;
    let histRef: Message | undefined;

    try {
      // If a prior turn already blew the spend limit under `stop`, refuse the new
      // turn — but do so BEFORE pushing the user message, so we don't leave an
      // orphan user turn with no assistant reply (consecutive same-role messages
      // 400 on Anthropic/others). The user sees why via a notice. Only ACTUAL
      // (non-estimated) spend blocks a new turn: an estimated base-model price
      // must never hard-stop a possibly-free local session — same invariant the
      // in-turn abort honors.
      if (config.budget.onExceed === "stop" && !this.#price?.estimated && this.#enforceBudget()) {
        bus.emit({
          type: "notice",
          level: "warn",
          message:
            `Spend limit reached ($${this.#costUSD.toFixed(4)} ≥ $${config.budget.limitUSD}); ` +
            "new turns are blocked. Raise budget.limitUSD to continue.",
        });
        return;
      }
      // Fold the volatile working state (live tasks + gathered sources) into THIS
      // turn's model-facing message so it stays current and survives compaction,
      // without polluting the cacheable system prefix. It's model-only — never
      // shown in the UI transcript (#history) or the user bubble.
      // Surface any detached (background) subagents that finished since the last
      // turn, then clear the pending list. Root session only — a subagent turn
      // must not drain the user-facing notifications out from under the root.
      const backgroundFinished =
        this.depth === 0 ? this.#deps.childRegistry?.takePendingFinished() : undefined;
      const stateReminder = formatWorkspaceState({
        tasks: this.#tasks,
        sources: this.#sources.size ? this.#sources.format() : undefined,
        ...(backgroundFinished?.length ? { backgroundFinished } : {}),
      });
      this.#pushUser(input, images, opts.display, stateReminder);
      userMsgRef = this.#modelMessages[this.#modelMessages.length - 1];
      histRef = this.#history[this.#history.length - 1];

      // Plan-readiness gate: fold this prompt into the cycle's triage so
      // present_plan can be held to what the request actually demands (fresh
      // web facts, real versions, code actually read). Lazily created — the
      // gate lives for one continuous stay in plan mode.
      if (this.mode === "plan") {
        this.#planGate ??= new PlanGate({
          greenfield: this.#deps.repoProfile?.greenfield === true,
        });
        this.#planGate.noteRequest(input);
      }
      this.#turnGate = this.mode === "plan" ? this.#planGate : undefined;

      const model = await this.#resolveWithFallback(registry, config);
      if (this.#aborted()) {
        this.#interrupted = true;
        return;
      }
      // Resolve the active model's price once per turn for live cost tracking.
      this.#price = await this.#deps.getPricing?.(this.model);
      if (this.#aborted()) {
        this.#interrupted = true;
        return;
      }
      await this.#maybeCompact(model, false);
      if (this.#aborted()) {
        this.#interrupted = true;
        return;
      }
      const skills = this.#deps.skills;
      // Subagents are offered in BOTH modes (in plan mode they're coerced
      // read-only — parallel exploration while planning), capped by recursion
      // depth. Mirrors the spawn_subagent registration gate below so the prompt
      // never advertises a tool the model can't call.
      const subagentsAvailable = this.depth < config.subagent.maxDepth;
      // Roster lines for capability routing. In plan mode children are coerced
      // read-only, so only advertise read-only agents (a write-capable one would
      // be useless). Empty → omitted entirely (plan mode with only execute agents).
      const rosterLines =
        subagentsAvailable && this.#deps.agents?.size
          ? [...this.#deps.agents.values()]
              .filter((a) => this.mode !== "plan" || a.mode === "plan")
              .map((a) => `${a.name} — ${a.description}`)
          : [];
      const repoFacts = this.#deps.repoProfile ? formatRepoFacts(this.#deps.repoProfile) : undefined;
      // The system prompt holds ONLY session-stable content, so its cache prefix
      // (and the whole conversation cached behind it) survives every turn. The
      // volatile working state — the live task list and gathered sources — rides
      // in the newest user message instead (see #pushUser + formatWorkspaceState).
      const system = composeSystemPrompt({
        mode: this.mode,
        cwd: this.#deps.cwd,
        today: formatToday(),
        goal: this.goal,
        ...(repoFacts ? { repoFacts } : {}),
        projectMemory: this.#deps.projectMemory,
        ...(this.#recalledContext ? { recalledContext: this.#recalledContext } : {}),
        // Memory doctrine mirrors the tool registration below: recall_memory is
        // always offered; save_memory only with a wired MemoryService outside
        // plan mode — the prompt must never coach a tool the model doesn't have.
        memory: { save: Boolean(this.#deps.memory) && this.mode !== "plan" },
        pluginBlocks: this.#deps.extraSystem,
        subagentsAvailable,
        ...(rosterLines.length ? { agentRoster: rosterLines } : {}),
        ...(skills?.list().length
          ? { skillDescriptions: skills.descriptions() }
          : {}),
      });
      const checker = new PermissionChecker(
        config.permissions,
        this.#deps.permissionResolver,
        config.approvalMode === "auto" ? "allow" : "ask",
        // Canonicalize path-scoped rules against THIS session's cwd (which
        // edit/write resolve against), so an absolute deny can't be dodged by a
        // relative spelling — and vice-versa.
        this.#deps.cwd,
      );
      const hooks = this.#deps.hooks;
      const base: ToolRuntimeBase = {
        cwd: this.#deps.cwd,
        sessionId: this.id,
        emit: (e: UIEvent) => bus.emit(e),
        recordToolResult: (toolCallId: string, isError: boolean) =>
          this.#toolCallErrors.set(toolCallId, isError),
        // Inject THIS session's id as the lock owner, so the claim registry can
        // tell same-agent re-entrant writes (serialize) from a different
        // subagent's concurrent write to the same file (hard-reject).
        ...(this.#deps.fileLock
          ? {
              lockFile: <T>(absPath: string, fn: () => Promise<T>) =>
                this.#deps.fileLock!(absPath, fn, this.id),
            }
          : {}),
        // Compiler feedback in the same step: edit/write append fresh
        // diagnostics for the file they just mutated (no-op when the optional
        // `typescript` dep is absent — the service resolves lazily).
        ...(this.#deps.diagnostics
          ? { diagnose: (absPath: string) => this.#deps.diagnostics!.diagnose(absPath) }
          : {}),
        checkPermission: (name: string, input: unknown, opts?: { fallback?: "allow" | "deny" | "ask" }) =>
          checker.check(name, input, opts),
        // Plan-readiness gate for present_plan (plan mode only): rejects a plan
        // whose triage-required research never happened, bounded, then warns.
        // Wired off the turn-scoped gate — a mid-turn mode switch retires
        // this.#planGate, and the in-flight turn must keep evaluating against
        // the gate it started with instead of dereferencing undefined.
        ...(this.#turnGate
          ? (() => {
              const gate = this.#turnGate;
              return { planGate: (plan: { sources?: { url: string }[] }) => gate.evaluate(plan) };
            })()
          : {}),
        ...(hooks
          ? {
              beforeTool: async (toolName: string, input: unknown) => {
                const r = await hooks.run("tool.before.execute", { toolName, input });
                // Return the (possibly hook-rewritten) input so the adapter runs
                // the tool with it; `deny`/`reason` block it.
                return { deny: r.deny, reason: r.reason, input: r.input };
              },
              afterTool: (toolName: string, output: unknown) =>
                void hooks.run("tool.after.execute", { toolName, output }),
            }
          : {}),
      };

      // ONE mutation lock for the whole turn, shared by the toolset map AND the
      // per-session tools below — a manually-registered mutating tool
      // (save_memory, run_check) must serialize with edit/write/bash, not race them.
      const serialize = createSerialLock();
      const tools = toolset.aiTools(this.mode, base, serialize);
      // The task list is available in both modes: the model can lay out tasks
      // while planning, and they carry over into execution.
      tools.update_tasks = toAISDKTool(buildTasksTool(this.#handle), base, serialize);
      // Offer spawning in both modes (plan-mode children are coerced read-only),
      // bounded by recursion depth.
      if (subagentsAvailable) {
        tools.spawn_subagent = toAISDKTool(this.#runner.spawnTool(), base, serialize);
        // Continuation: resume a retained completed subagent (only when retention
        // is enabled — otherwise every id would miss).
        if (config.subagent.retainCompleted > 0) {
          tools.continue_subagent = toAISDKTool(this.#runner.continueTool(), base, serialize);
        }
        // Background collection: check a detached child's status/result. Offered
        // only in interactive sessions — headless runs coerce `detach` to
        // synchronous, so no detached children ever exist there.
        if (this.#deps.interactive) {
          tools.check_task = toAISDKTool(this.#runner.checkTaskTool(), base, serialize);
        }
        // Deterministic task-DAG orchestration (default-on): in addition to
        // one-off spawn_subagent, offer spawn_tasks so the model can submit a
        // whole dependency-ordered plan the engine schedules.
        if (config.orchestration.enabled) {
          tools.spawn_tasks = toAISDKTool(this.#runner.spawnTasksTool(), base, serialize);
        }
      }
      // read_report: pull a finished orchestrator task's FULL report by id.
      // Offered to the planner (alongside spawn_tasks) AND to any depth>0 child
      // (a dependent task pulling its dependency's complete write-up — that child
      // may itself be beyond maxDepth, so it's gated on depth, not
      // subagentsAvailable). The store is tree-shared, created by the root runner.
      if (
        config.orchestration.enabled &&
        this.#deps.reportStore &&
        (subagentsAvailable || this.depth > 0)
      ) {
        tools.read_report = toAISDKTool(buildReadReportTool(this.#deps.reportStore), base, serialize);
      }
      // Progressive disclosure: expose use_skill when skills are available.
      if (skills?.list().length) {
        tools.use_skill = toAISDKTool(buildUseSkillTool(this.#handle), base, serialize);
      }
      // Long-term memory: let the model search prior context on demand, and —
      // when memory is wired and we're not in read-only plan mode — persist
      // durable facts for future sessions.
      tools.recall_memory = toAISDKTool(buildRecallTool(this.#handle), base, serialize);
      if (this.#deps.memory && this.mode !== "plan") {
        tools.save_memory = toAISDKTool(buildSaveMemoryTool(this.#handle), base, serialize);
      }
      // The repo's real checks as a first-class verdict tool. Execute-mode only
      // (running a build/test suite mutates the workspace) and only when recon
      // actually detected commands — never offer a tool that can only error.
      if (
        this.mode !== "plan" &&
        this.#deps.repoProfile &&
        Object.keys(this.#deps.repoProfile.commands).length
      ) {
        tools.run_check = toAISDKTool(buildRunCheckTool(this.#handle), base, serialize);
      }
      // Cross-agent coordination board: offer post_note/read_notes whenever this
      // agent is part of a multi-agent tree — a subagent worker (depth > 0) or a
      // root that can still delegate — so siblings can coordinate, but a plain
      // single-agent turn with no one to coordinate with isn't cluttered.
      if (this.#deps.blackboard && (this.depth > 0 || subagentsAvailable)) {
        tools.post_note = toAISDKTool(buildPostNoteTool(this.#handle), base, serialize);
        tools.read_notes = toAISDKTool(buildReadNotesTool(this.#handle), base, serialize);
      }

      // Per-agent tool restriction (from a named agent's frontmatter): keep only
      // the allowlist (when set) minus the denylist, applied to the whole map.
      const filter = this.#deps.toolFilter;
      if (filter && (filter.allow?.length || filter.deny?.length)) {
        for (const name of Object.keys(tools)) {
          const allowed = !filter.allow?.length || filter.allow.includes(name);
          const denied = filter.deny?.includes(name) ?? false;
          if (!allowed || denied) delete tools[name];
        }
      }

      // Per-provider tuning: reasoning/thinking budget + (Anthropic) caching of
      // the stable system prefix so repeated turns don't re-bill the full prompt.
      const tuning = buildModelTuning(this.model, config);
      // Anthropic reports cache_read_input_tokens DISJOINT from input_tokens; fold
      // it into a superset (below) so cost, the live context %, and the compaction
      // trigger all reflect the true prompt size rather than the uncached slice.
      const foldCachedIntoInput = cacheTokensDisjointFromInput(this.model);
      // First breakpoint: the system message (stable across the whole session
      // now that volatile state rides in the user turn), so its prefix is a cache
      // hit every turn. The SECOND breakpoint — the trailing conversation message
      // — is placed in `prepareStep` (markConversationTail) every step, not here,
      // so the growing within-turn tail is cached step-to-step.
      const messages: ModelMessage[] = tuning.cacheSystem
        ? [
            { role: "system", content: system, providerOptions: ANTHROPIC_CACHE_CONTROL },
            ...this.#modelMessages,
          ]
        : this.#modelMessages;
      // Third breakpoint: the tool block. Tool schemas are big and perfectly
      // stable within a turn — without a marker every step re-bills all of them.
      if (tuning.cacheTools) {
        const names = Object.keys(tools);
        const lastTool = names[names.length - 1];
        if (lastTool && tools[lastTool]) {
          (tools[lastTool] as { providerOptions?: unknown }).providerOptions = ANTHROPIC_CACHE_CONTROL;
        }
      }

      await this.#withLimiter(async () => {
      const result = streamText({
        model,
        // When caching, the system prompt rides in `messages` with a cache
        // marker; otherwise it's passed plainly.
        ...(tuning.cacheSystem ? {} : { system }),
        messages,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: this.#abort.signal,
        maxRetries: config.retry.maxAttempts,
        // Mid-turn microcompaction: before each step, project the fill and
        // offload bulky/superseded tool results (full text → session artifact,
        // preview + path stays in the prompt). prepareStep edits are EPHEMERAL
        // (never written back into response.messages), so a durable pass runs
        // again at end-of-turn — this hook just keeps a long turn under the
        // window RIGHT NOW. Failures degrade to the untrimmed prompt; a throw
        // here would fail the whole turn.
        prepareStep: async ({ messages: stepMessages }) => {
          const offload = config.compaction.offload;
          let next = stepMessages;
          try {
            if (offload.enabled && !this.#aborted()) {
              // Project this step's fill against the window. `#overheadTokens` is
              // the provider's real prompt size minus the estimate of what we
              // actually SENT last step (system + tools), so adding it to the
              // current stepMessages estimate does NOT double-count the within-turn
              // tail (that tail is already inside stepMessages).
              const projected = estimateTokens(stepMessages) + this.#overheadTokens;
              const limit = offload.threshold * this.#contextWindow;
              if (projected >= limit) {
                const plan = planOffloads(stepMessages, {
                  maxResultBytes: offload.maxResultBytes,
                  keepLiveResults: offload.keepLiveResults,
                  // Free enough to land comfortably under the threshold (chars ≈ 4/token).
                  targetChars: Math.max(0, (projected - limit * 0.85) * 4),
                  existing: new Set(this.#offloaded.keys()),
                  // Match superseded reads across abs/relative spellings of a file.
                  canonicalize: (p) => resolve(this.#deps.cwd, p),
                  // A preview stays inline, so credit only the net reduction.
                  previewChars: offload.previewBytes,
                });
                for (const ref of plan) await this.#writeOffload(ref, stepMessages);
              }
            }
            if (this.#offloaded.size) {
              next = applyOffloads(stepMessages, this.#offloaded, offload.previewBytes);
            }
          } catch (err) {
            bus.emit({
              type: "notice",
              level: "warn",
              message: `context offload skipped: ${(err as Error).message}`,
            });
            next = stepMessages; // degrade to the untrimmed prompt — never fail the turn
          }
          // Conversation cache breakpoint on the current tail, every step.
          if (tuning.cacheConversation) next = markConversationTail(next);
          // Anchor next step's overhead calc on exactly what we send this step.
          this.#lastSentEstimate = estimateTokens(next);
          return next === stepMessages ? undefined : { messages: next };
        },
        onError: ({ error }) => {
          bus.emit({
            type: "notice",
            level: "warn",
            message: `provider error: ${(error as Error)?.message ?? String(error)}`,
          });
        },
        ...(tuning.providerOptions
          ? {
              providerOptions: tuning.providerOptions as NonNullable<
                Parameters<typeof streamText>[0]["providerOptions"]
              >,
            }
          : {}),
        onStepFinish: ({ usage, providerMetadata, response }) => {
          // Buffer this completed step's messages (assistant tool_use + its tool
          // results — matched pairs, since the step FINISHED). response.messages
          // is cumulative across the turn, so REPLACE rather than append: the last
          // onStepFinish before an abort holds every completed step. On success
          // we use result.response.messages instead and ignore this buffer.
          if (response?.messages) this.#committedSteps = [...response.messages];
          const stepUsage = normalizeUsage(usage);
          // Cache WRITES are a third disjoint slice on Anthropic — invisible in
          // normalized usage, only in providerMetadata. Without folding them the
          // first (cache-creating) step under-reports both context fill and cost.
          const cacheWrites = foldCachedIntoInput
            ? Number(
                (providerMetadata as { anthropic?: { cacheCreationInputTokens?: unknown } } | undefined)
                  ?.anthropic?.cacheCreationInputTokens ?? 0,
              ) || 0
            : 0;
          // Restore the `cached ⊆ input` invariant for providers (Anthropic) that
          // report the two disjoint, so the accounting below (cost, context fill,
          // compaction) sees the full prompt size instead of only the new tokens.
          if (foldCachedIntoInput && stepUsage && (stepUsage.cachedInputTokens || cacheWrites)) {
            stepUsage.inputTokens =
              (stepUsage.inputTokens ?? 0) + (stepUsage.cachedInputTokens ?? 0) + cacheWrites;
          }
          bus.emit({
            type: "step-finished",
            sessionId: this.id,
            usage: stepUsage,
          });
          // Fire the plugin step boundary hook (was declared but never dispatched,
          // so registered handlers silently never ran). Best-effort, errors isolated.
          void this.#deps.hooks?.run("step.finish", { sessionId: this.id });
          addUsage(this.#usage, stepUsage);
          // Track the provider's real prompt size (the true context fill) and
          // surface it live — the JSON estimate omitted the system prompt + tool
          // schemas, so it read far too low.
          if (stepUsage?.inputTokens) {
            this.#lastInputTokens = stepUsage.inputTokens;
            // Anchor the mid-turn fill projection on the delta between the real
            // prompt size and the estimate of exactly what we SENT this step
            // (#lastSentEstimate). That isolates the system+tools scaffolding the
            // estimate can't see; measuring against #modelMessages instead folded
            // the within-turn tool-result tail into "overhead" and then
            // double-counted it in prepareStep, firing offloads far too early.
            const sentEstimate = this.#lastSentEstimate || estimateTokens(this.#modelMessages);
            this.#overheadTokens = Math.max(0, stepUsage.inputTokens - sentEstimate);
            bus.emit({
              type: "context-updated",
              sessionId: this.id,
              usedTokens: this.#lastInputTokens,
              contextWindow: this.#contextWindow,
            });
          }
          // Accrue cost at the price in effect for this step, so a mid-session
          // model/price change doesn't retroactively reprice earlier tokens.
          this.#costUSD += computeCost(
            stepUsage?.inputTokens ?? 0,
            stepUsage?.outputTokens ?? 0,
            this.#price,
            stepUsage?.cachedInputTokens ?? 0,
            cacheWrites,
          );
          bus.emit({
            type: "usage-updated",
            sessionId: this.id,
            usage: this.#usageSnapshot(),
          });
          this.#enforceBudget();
        },
      });

      // Build the assistant message from the stream, then commit it to BOTH the
      // model context and the UI history together. On abort/error mid-turn,
      // `result.response` rejects, so we record the partial assistant text in
      // the model context too — keeping `#history` and `#modelMessages` in
      // lockstep (otherwise the next turn's context would be missing this turn).
      const assistant = await this.#consume(result);
      let responseOk = false;
      try {
        const response = await result.response;
        this.#modelMessages.push(...response.messages);
        // prepareStep's offloads were ephemeral (the SDK re-records full tool
        // results in response.messages) — make them durable so the persisted
        // session and the NEXT turn's prompt carry the previews, not the blobs.
        this.#applyDurableOffloads();
        responseOk = true;
      } finally {
        if (responseOk) {
          // Success: the authoritative model messages already landed; record the
          // UI reply too.
          if (assistant) this.#history.push(assistant);
        } else {
          // Abort/error mid-turn: result.response rejected, so the COMPLETED
          // steps' messages (matched tool_use/tool_result pairs) were never
          // committed. Commit them first — a resumed session must KNOW about work
          // already done (e.g. a completed edit), not just see partial text. A
          // step that ends a turn has no next step, so a buffered step always ends
          // on a tool result, keeping alternation valid before the partial text.
          if (this.#committedSteps.length) {
            this.#modelMessages.push(...this.#committedSteps);
            this.#applyDurableOffloads();
          }
          if (assistant) {
            // Record the partial assistant tail to BOTH lists or NEITHER, so they
            // stay consistent for the orphan-rollback below. An EMPTY partial (an
            // empty text-delta before abort makes `assistant` truthy while its
            // text is "") goes to neither.
            const text = messageText(assistant);
            if (text) {
              this.#history.push(assistant);
              this.#modelMessages.push({ role: "assistant", content: text });
            }
          }
        }
      }
      // Notify plugins of the completed assistant message (best-effort).
      if (this.#deps.hooks && assistant) {
        const text = messageText(assistant);
        if (text) await this.#deps.hooks.run("assistant.message", { sessionId: this.id, text });
      }
      });
    } catch (err) {
      // A user cancel (Esc / steer / spend-stop) makes the stream and
      // `result.response` reject — that's not a fault. Don't paint it red or set
      // `#lastError` (which would make a steered subagent read as "failed" to its
      // parent). The stream's `abort` part already surfaced a "Turn aborted." notice.
      if (this.#isAbortError(err)) {
        this.#interrupted = true;
      } else {
        this.#lastError = (err as Error).message;
        bus.emit({
          type: "engine-error",
          sessionId: this.id,
          message: (err as Error).message,
        });
      }
    } finally {
      // Roll back an orphan user turn: if the turn ended before ANY assistant
      // reply was committed (a pre-stream abort/error, or a stream that failed
      // before emitting anything), the just-pushed user message is still the LAST
      // entry. Identity-match it so a compaction that ran mid-turn (which replaces
      // the array but keeps this message verbatim at the tail) doesn't fool the
      // check, and drop it so the next turn doesn't open with two user messages.
      if (userMsgRef && this.#modelMessages[this.#modelMessages.length - 1] === userMsgRef) {
        this.#modelMessages.pop();
        if (histRef && this.#history[this.#history.length - 1] === histRef) this.#history.pop();
      }
      this.busy = false;
      await this.#persist();
      bus.emit({ type: "turn-finished", sessionId: this.id });
      bus.emit({ type: "session-idle", sessionId: this.id });
    }
  }

  /** Force a compaction pass now (used by /compact). */
  async compact(): Promise<void> {
    // Fresh controller so a prior turn's abort doesn't pre-cancel this, and so an
    // Esc during the (possibly long) summarize can interrupt it.
    this.#abort = new AbortController();
    const model = await this.#deps.registry.resolveModel(
      this.model,
      this.#deps.config,
    );
    await this.#maybeCompact(model, true);
  }

  /**
   * Distill the session into one compact memory note (≤ ~80 words) for future
   * recall: the goal, what was accomplished, and key decisions/gotchas. Returns
   * undefined when there's nothing worth saving or the model call fails — a
   * best-effort enhancement that must never throw.
   */
  async buildDigest(): Promise<string | undefined> {
    const assistantTurns = this.#history.filter((m) => m.role === "assistant").length;
    if (assistantTurns < 1 || !this.#modelMessages.length) return undefined;
    this.#abort = new AbortController();
    const model = await this.#deps.registry
      .resolveModel(this.model, this.#deps.config)
      .catch(() => undefined);
    if (!model) return undefined;
    const transcript = this.#modelMessages
      .map((m) => `${m.role}: ${contentToText(m.content)}`)
      .join("\n")
      .slice(0, 24_000);
    try {
      const { text } = await this.#withLimiter(() =>
        generateText({
          model,
          prompt:
            "Write a durable memory note for a coding agent's FUTURE sessions on this " +
            "project. From the transcript below, produce ONE compact paragraph (≤ 80 " +
            "words) capturing: the goal, what was accomplished, key decisions WITH their " +
            "reasons, gotchas hit, and any user preferences or corrections expressed " +
            "(these matter most — future sessions must respect them). Prefer specifics " +
            "(names, paths, commands) over generalities. No preamble, no markdown " +
            "headings, no bullet list.\n\n" +
            transcript,
          abortSignal: this.#abort.signal,
        }),
      );
      const digest = text.trim().replace(/\s+/g, " ");
      // Reject not just empty but LOW-VALUE digests: a curt "No significant
      // changes." / "Nothing to note." would be saved as a durable memory and
      // later recalled as noise. Require some substance (a handful of words) and
      // drop obvious no-op replies.
      if (digest.length < 24 || /^(no (significant )?(changes|updates|actions)|nothing (to note|happened|significant))\b/i.test(digest)) {
        return undefined;
      }
      return digest;
    } catch {
      return undefined;
    }
  }

  /** Persist one tool result to a session artifact and record it as offloaded.
   * Idempotent per callId; a write failure simply skips the offload. */
  async #writeOffload(
    ref: { callId: string; toolName: string; messageIndex: number },
    messages: ModelMessage[],
  ): Promise<void> {
    if (this.#offloaded.has(ref.callId)) return;
    const msg = messages[ref.messageIndex];
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) return;
    const part = (msg.content as { type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }[]).find(
      (p) => p?.type === "tool-result" && p.toolCallId === ref.callId,
    );
    if (!part) return;
    const full = offloadResultText(part.output);
    if (!full) return;
    try {
      // Offload artifacts are machine state → the project's global state dir
      // (an in-project write here used to dirty a fresh scaffold target). The
      // recorded path is ABSOLUTE so the `read`-back pointer in the preview
      // resolves regardless of cwd.
      const abs = join(
        globalStateDir(this.#deps.cwd),
        "sessions",
        this.id,
        "tool-results",
        `${ref.callId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64)}.txt`,
      );
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, full, "utf8");
      this.#offloaded.set(ref.callId, { path: abs, toolName: ref.toolName, fullChars: full.length });
      this.#pruneOffloadArtifacts(dirname(abs));
    } catch {
      /* offloading is an enhancement — a failed write must never fail the turn */
    }
  }

  /** Enforce the per-session artifact byte budget: when the tool-results dir
   * exceeds `offload.maxArtifactBytes`, evict oldest-first the artifacts whose
   * full text is NOT part of the live working set (i.e. not currently mapped in
   * #offloaded). Their previews stay in context; only the re-readable full text
   * is reclaimed — the same graceful degradation a moved/aged artifact already
   * has. Bounds within-session growth and reclaims orphans from aborted turns. */
  #pruneOffloadArtifacts(dir: string): void {
    const cap = this.#deps.config.compaction.offload.maxArtifactBytes;
    const live = new Set([...this.#offloaded.values()].map((r) => r.path));
    pruneArtifacts(dir, cap, live);
  }

  /** Fold the ephemeral prepareStep offloads into the DURABLE message history
   * (prepareStep edits never reach response.messages). Runs at end-of-turn and
   * before compaction, so persisted sessions carry the previews. */
  #applyDurableOffloads(): void {
    if (!this.#offloaded.size) return;
    this.#modelMessages = applyOffloads(
      this.#modelMessages,
      this.#offloaded,
      this.#deps.config.compaction.offload.previewBytes,
    );
  }

  /** Summarize older context when over the threshold (or when forced). */
  async #maybeCompact(model: LanguageModel, force: boolean): Promise<void> {
    this.#applyDurableOffloads();
    const contextWindow =
      (await this.#deps.getContextWindow?.(this.model)) ??
      DEFAULT_CONTEXT_WINDOW;
    this.#contextWindow = contextWindow;
    // Surface live context-window fill so the UI can show how close we are to the
    // limit (and when auto-compaction is about to kick in). Prefer the provider's
    // real input-token count (the true context size) over the estimate, which
    // omits the system prompt + tool schemas; the estimate is just a pre-first-step
    // fallback.
    this.#deps.bus.emit({
      type: "context-updated",
      sessionId: this.id,
      usedTokens: this.#lastInputTokens || estimateTokens(this.#modelMessages),
      contextWindow,
    });
    // Drive the trigger off the provider's real prompt size (system prompt +
    // tool schemas + messages + cache) when we have it; before the first step we
    // only have the messages-only estimate, so pad it for the unseen system/tool
    // overhead (capped to a fraction of the window so tiny local-model windows
    // aren't forced to compact every turn).
    const estimate = estimateTokens(this.#modelMessages);
    const currentTokens =
      this.#lastInputTokens > 0
        ? Math.max(this.#lastInputTokens, estimate)
        : estimate + Math.min(COMPACT_OVERHEAD_MARGIN, Math.floor(contextWindow * 0.1));
    let result: Awaited<ReturnType<typeof compactMessages>>;
    try {
      result = await compactMessages(this.#modelMessages, {
        contextWindow,
        threshold: this.#deps.config.compaction.threshold,
        keep: COMPACT_KEEP_RECENT,
        force,
        currentTokens,
        summarize: (msgs) => this.#summarize(model, msgs),
      });
    } catch (err) {
      // A cancellation must propagate — Esc during a long summarize should stop
      // the turn, not be swallowed into a silent "no compaction".
      if (this.#abort.signal.aborted || (err as { name?: string })?.name === "AbortError") throw err;
      // Any other summarizer failure (transient provider error on the AUXILIARY
      // summarize call) must not fail the turn — the real work might still fit.
      // Skip compaction and proceed with the uncompacted context; a subsequent
      // provider 400 on length is a clearer signal than losing the whole turn to
      // a blip on a side-channel call. For subagents this also avoids a summarize
      // hiccup marking a fork as "failed" to its orchestrator.
      this.#deps.bus.emit({
        type: "notice",
        level: "warn",
        message: `Compaction skipped: summarizer failed (${(err as Error)?.message ?? String(err)}).`,
      });
      return;
    }
    if (!result) {
      if (force) {
        this.#deps.bus.emit({
          type: "notice",
          level: "info",
          message: "Nothing to compact yet.",
        });
      }
      return;
    }
    this.#modelMessages = result.messages;
    // The provider's last-step input count measured the PRE-compaction prompt,
    // so it now over-reports the context fill by everything we just summarized
    // away. Drop it so `contextTokens` falls back to a fresh estimate of the
    // compacted messages (the next real step refines it with the provider's
    // true count), and surface that estimate now so `/context`, `/status`, and
    // the live `ctx %` reflect the freed space immediately instead of staying
    // pinned at the old high value until the next turn.
    this.#lastInputTokens = 0;
    this.#deps.bus.emit({
      type: "context-updated",
      sessionId: this.id,
      usedTokens: estimateTokens(this.#modelMessages),
      contextWindow: this.#contextWindow,
    });
    this.#deps.bus.emit({
      type: "compacted",
      sessionId: this.id,
      freedTokens: result.freed,
    });
  }

  async #summarize(model: LanguageModel, messages: ModelMessage[]): Promise<string> {
    const raw = messages
      .map((m) => `${m.role}: ${contentToText(m.content)}`)
      .join("\n");
    // Cap the summarizer's own input: compaction fires when the context is
    // near-full, so the uncapped transcript WAS the overflowing history — the
    // summarize call itself could blow the window. Keep head + tail (the
    // opening goal and the most recent decisions matter most; the middle is
    // what summaries exist to compress).
    const cap = SUMMARY_INPUT_CAP;
    const transcript =
      raw.length > cap
        ? `${raw.slice(0, Math.floor(cap * 0.4))}\n…[${raw.length - cap} chars of mid-conversation omitted]…\n${raw.slice(-Math.floor(cap * 0.6))}`
        : raw;
    const { text } = await this.#withLimiter(() =>
      generateText({
        model,
        // A sectioned contract instead of free-text: the summary replaces real
        // history, so it must deterministically preserve the load-bearing
        // categories (what a resumed model needs to keep acting correctly).
        prompt:
          "Summarize this coding-agent conversation excerpt into EXACTLY these sections " +
          "(omit a section only if truly empty). Be concise and factual — the summary " +
          "replaces the original history, so anything you drop is gone.\n" +
          "## STATE — where things stand right now\n" +
          "## DECISIONS — choices made and why\n" +
          "## FILES TOUCHED — path: what changed\n" +
          "## VERIFIED FACTS — things confirmed by reading/running (not assumed)\n" +
          "## OPEN THREADS — unfinished work / next steps\n\n" +
          transcript,
        // Make compaction interruptible — an Esc during a long summarize shouldn't
        // be ignored (the same controller the turn/`/compact` runs under).
        abortSignal: this.#abort.signal,
      }),
    );
    return text;
  }

  async #persist(): Promise<void> {
    const store = this.#deps.store;
    if (!store) return;
    try {
      await store.save(
        {
          version: SESSION_META_VERSION,
          id: this.id,
          model: this.model,
          mode: this.mode,
          goal: this.goal,
          tasks: this.#tasks,
          usage: { ...this.#usage, costUSD: this.#costUSD },
          ...(this.#lastInputTokens > 0 ? { lastInputTokens: this.#lastInputTokens } : {}),
          ...(this.#recalledContext ? { recalledContext: this.#recalledContext } : {}),
          ...(this.#sources.size ? { sources: [...this.#sources.list()] } : {}),
          createdAt: this.#createdAt,
          updatedAt: Date.now(),
        },
        this.#modelMessages,
        this.#history,
      );
    } catch (err) {
      this.#deps.bus.emit({
        type: "notice",
        level: "warn",
        message: `Failed to persist session: ${(err as Error).message}`,
      });
    }
  }

  /** Fork a child session for a subagent (own context, shared infra). */
  fork(overrides: Partial<SessionDeps> & { model?: string }): Session {
    return new Session({
      ...this.#deps,
      // A subagent is a FRESH conversation with its own context window. Never
      // inherit the parent's seeded/resumed history, usage, cost, or tasks
      // (that would corrupt isolation and double-count cost on `--resume`), its
      // persistence store (subagents are ephemeral — persisting them pollutes
      // `/resume` and can hijack `--continue`), or its system extras/identity.
      // `...overrides` below re-applies any the caller intends (e.g. extraSystem
      // for a named agent, depth).
      initialModelMessages: undefined,
      initialHistory: undefined,
      initialTasks: undefined,
      initialUsage: undefined,
      initialCostUSD: undefined,
      store: undefined,
      extraSystem: undefined,
      // Don't inherit a parent agent's tool restriction — #forkChild re-applies
      // the *child* named agent's own filter (if any).
      toolFilter: undefined,
      createdAt: undefined,
      id: createId("sub"),
      model: overrides.model ?? this.model,
      mode: overrides.mode ?? this.mode,
      goal: overrides.goal ?? null,
      ...overrides,
    });
  }

  #pushUser(
    input: string,
    images: ImageAttachment[] = [],
    display?: string | null,
    stateReminder?: string,
  ): void {
    // The model-facing text: the user's input, then (when present) the workspace
    // state block APPENDED so the user's own words lead and the ambient state
    // trails. This block is model-only — it is deliberately absent from the UI
    // parts (#history) and the user-message event below.
    const modelText = stateReminder ? `${input}\n\n${stateReminder}` : input;
    // Multimodal user turn when images are attached; plain string otherwise so
    // existing text-only behaviour and persistence are unchanged.
    const content = images.length
      ? [
          { type: "text" as const, text: modelText },
          ...images.map((img) => ({
            type: "image" as const,
            image: img.data,
            mediaType: img.mediaType,
          })),
        ]
      : modelText;
    this.#modelMessages.push({ role: "user", content });
    const parts: Part[] = [{ type: "text", text: input }];
    for (const img of images) parts.push({ type: "text", text: `[image: ${img.path}]` });
    this.#history.push({
      id: createId("msg"),
      role: "user",
      parts,
      createdAt: Date.now(),
    });
    // `display === null` suppresses the visible user bubble (e.g. the internal
    // plan→execute handoff directive, which the model needs but the user shouldn't
    // see as a message they "sent"); otherwise show `display` (or the raw input).
    if (display !== null) {
      this.#deps.bus.emit({ type: "user-message", sessionId: this.id, text: display ?? input });
    }
  }

  /** Translate AI-SDK stream parts into UIEvents and accumulate the message. */
  async #consume(
    result: { fullStream: AsyncIterable<unknown> },
  ): Promise<Message | null> {
    const bus = this.#deps.bus;
    let assistant: Message | null = null;
    const ensure = (): Message => {
      if (!assistant) {
        assistant = {
          id: createId("msg"),
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        };
      }
      return assistant;
    };

    // Cooperative yield: a fast provider stream (or a replayed/buffered one)
    // can resolve part after part on the microtask queue, and the engine
    // shares its thread with the TUI — without an occasional macrotask hop,
    // stdin and timers starve during a long uninterrupted burst. Yield between
    // WHOLE parts so event order is untouched.
    const partGate = makeYieldGate(CONSUME_YIELD_PARTS);
    for await (const raw of result.fullStream) {
      if (partGate(1)) await new Promise((r) => setTimeout(r, 0));
      const part = raw as Record<string, any>;
      switch (part.type) {
        case "text-delta": {
          const delta: string = part.text ?? part.textDelta ?? "";
          appendText(ensure(), delta);
          bus.emit({ type: "assistant-text-delta", sessionId: this.id, delta });
          break;
        }
        case "reasoning-delta": {
          const delta: string = part.text ?? part.textDelta ?? "";
          bus.emit({ type: "reasoning-delta", sessionId: this.id, delta });
          break;
        }
        case "tool-call": {
          // Track whether this turn changed the workspace (drives auto-verify).
          // `spawn_subagent` is read-only here — it sets `#turnMutated` only if
          // the *child* actually mutated (see `#spawnTool`), so a pure read-only
          // investigation turn doesn't spuriously trigger auto-verify.
          const def = this.#deps.toolset.get(part.toolName);
          if (def && !def.readOnly) {
            this.#turnMutated = true;
          }
          // Capture the URL webfetch was asked to fetch (its output is the page
          // body, not a URL list) so the ledger records the page actually pulled.
          if (part.toolName === "webfetch") {
            const inp = (part.input ?? part.args) as { url?: unknown } | undefined;
            if (inp && typeof inp.url === "string") this.#fetchInputUrls.set(part.toolCallId, inp.url);
          }
          bus.emit({
            type: "tool-call-started",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? part.args,
          });
          break;
        }
        case "tool-result": {
          // A handled error (permission deny, plugin veto, `isError` execute
          // result) comes back as an ordinary string result, so the SDK reports
          // it here, not as `tool-error`. Recover the real status from the
          // adapter's side-channel so the UI doesn't render a denied write as a
          // successful tool call.
          const isError = this.#toolCallErrors.get(part.toolCallId) ?? false;
          const resultText = isError
            ? ""
            : typeof part.output === "string"
              ? part.output
              : offloadResultText(part.output as { type?: string; value?: unknown });
          // Count successful research/exploration toward the plan-readiness
          // gate's telemetry — the evidence trail present_plan is judged against.
          // A web_search that surfaced NOTHING isn't grounding, so a junk query
          // (zero results) can't satisfy the gate's "you researched" requirement.
          if (!isError) {
            const unproductive = part.toolName === "web_search" && /^No results for /.test(resultText.trim());
            if (!unproductive) this.#turnGate?.recordToolUse(part.toolName);
          }
          // Harvest sources: on a SUCCESSFUL research-tool result, extract the
          // URLs it surfaced and record them in the session's source ledger
          // (deduped + stably numbered), so later turns can cite them by [n].
          if (!isError && RESEARCH_TOOL_NAMES.has(part.toolName)) {
            if (part.toolName === "webfetch") {
              // Record the URL actually fetched (the tool INPUT), not links
              // harvested from the page body — those weren't pulled by the agent.
              const fetched = this.#fetchInputUrls.get(part.toolCallId);
              if (fetched) this.#sources.record({ url: fetched, via: part.toolName });
            } else {
              // web_search / crawl_docs OUTPUT is a list of result/page URLs — those
              // ARE the sources surfaced, so harvest them from the rendered text.
              for (const url of harvestUrls(resultText)) {
                this.#sources.record({ url, via: part.toolName });
              }
            }
          }
          this.#fetchInputUrls.delete(part.toolCallId);
          bus.emit({
            type: "tool-call-finished",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
            isError,
          });
          break;
        }
        case "tool-error": {
          bus.emit({
            type: "tool-call-finished",
            sessionId: this.id,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: String((part.error as Error)?.message ?? part.error),
            isError: true,
          });
          break;
        }
        case "abort": {
          bus.emit({
            type: "notice",
            level: "warn",
            message: "Turn aborted.",
          });
          break;
        }
        case "error": {
          bus.emit({
            type: "engine-error",
            sessionId: this.id,
            message: String(part.error?.message ?? part.error),
          });
          break;
        }
        default:
          break;
      }
    }
    return assistant;
  }
}

/** The concatenated text of a message's text parts (dropping non-text parts). */
function messageText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Flatten a model message's content to plain text for the summarizer, replacing
 * binary parts (images/files) with a short placeholder. Without this, an
 * `@image` attachment's `Uint8Array` would be `JSON.stringify`d into the
 * summarization prompt as megabytes of `{"0":255,…}` byte-text.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as {
          type?: string;
          text?: string;
          toolName?: string;
          input?: unknown;
          output?: unknown;
        };
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image") return "[image]";
        if (p?.type === "file") return "[file]";
        // Tool parts: render the meaningful fields, not the raw part JSON —
        // `JSON.stringify` of a tool-result wrapped every quote in escapes and
        // doubled the token cost of the summarizer/digest prompts for nothing.
        if (p?.type === "tool-call") {
          return `[called ${p.toolName ?? "tool"}(${typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {})})]`;
        }
        if (p?.type === "tool-result") {
          const out = p.output as { value?: unknown } | string | undefined;
          const text =
            typeof out === "string"
              ? out
              : typeof (out as { value?: unknown })?.value === "string"
                ? String((out as { value: string }).value)
                : JSON.stringify(out ?? "");
          return `[${p.toolName ?? "tool"} → ${text.slice(0, 2_000)}]`;
        }
        return JSON.stringify(part);
      })
      .join(" ");
  }
  return JSON.stringify(content);
}

function appendText(message: Message, delta: string): void {
  const last = message.parts[message.parts.length - 1] as Part | undefined;
  if (last && last.type === "text") {
    last.text += delta;
  } else {
    message.parts.push({ type: "text", text: delta });
  }
}

/**
 * Place the Anthropic conversation cache breakpoint on the LAST message of a
 * step's prompt. Called every step so a multi-step turn caches its growing tail
 * one step at a time — without a marker on the current tail each step re-bills
 * every accumulated tool result at full price. Copy-on-write (the stored
 * `#modelMessages` are never marked); the system message keeps its own separate
 * breakpoint, so this is the SOLE placer of the conversation marker — exactly one
 * ever exists (system + tools + this = 3 ≤ the 4-breakpoint cap). No-op when
 * there's nothing but a system message.
 */
function markConversationTail(messages: ModelMessage[]): ModelMessage[] {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0 || messages[lastIdx]?.role === "system") return messages;
  const last = messages[lastIdx]!;
  return [
    ...messages.slice(0, lastIdx),
    { ...last, providerOptions: { ...last.providerOptions, ...ANTHROPIC_CACHE_CONTROL } } as ModelMessage,
  ];
}

function normalizeUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens ?? u.promptTokens,
    outputTokens: u.outputTokens ?? u.completionTokens,
    totalTokens: u.totalTokens,
    cachedInputTokens: u.cachedInputTokens ?? u.cachedPromptTokens,
  };
}
