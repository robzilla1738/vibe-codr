import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { mkdirSync, statSync, readdirSync } from "node:fs";
import { generateText } from "ai";
import { z } from "zod";
import { generateStructuredObject } from "./structured-object.ts";

// Quiet the AI SDK's console.warn "responseFormat is not supported" spam in
// the TUI (it paints over the input footer). We handle unsupported structured
// outputs ourselves via generateStructuredObject's prompt-JSON fallback.
// Callers that want the SDK's warnings can set AI_SDK_LOG_WARNINGS back to a
// function before constructing an Engine. The global is typed by the AI SDK.
if ((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS === undefined) {
  (globalThis as { AI_SDK_LOG_WARNINGS?: false }).AI_SDK_LOG_WARNINGS = false;
}
import {
  createId,
  createLogger,
  type EngineClient,
  type EngineCommand,
  type EngineSnapshot,
  type GateSummary,
  type GitInfo,
  type GoalRunInfo,
  type Logger,
  type Mode,
  type ProviderInfo,
  type AgentInfo,
  type SkillInfo,
  type QueuedItem,
  type RepoProfile,
  type UIEvent,
} from "@vibe/shared";
import type { Config, PermissionRule } from "@vibe/config";
import { appendProjectPermission, configSecurityNotices, writeGlobalConfig } from "@vibe/config";
import {
  ProviderRegistry,
  CatalogService,
  probeOllamaContextWindow,
  probeLmStudioContextWindow,
  type ModelInfo,
  type PricingResult,
} from "@vibe/providers";
import {
  BackgroundJobs,
  FreshnessRegistry,
  Toolset,
  builtinTools,
  buildRepoMap,
  createFileLock,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from "@vibe/tools";
import { HookBus, CommandRegistry, SkillRegistry, PluginHost, parseSlash } from "@vibe/plugins";
import { EventBus } from "./event-bus.ts";
import { Session, isReviewClean } from "./session.ts";
import { BUILTIN_COMMANDS } from "./commands.ts";
import {
  type PermissionReply,
  type PermissionResolver,
  grantPathScope,
  scopeString,
} from "./permissions.ts";
import { loadAgents, scaffoldAgent, setAgentModel, type NamedAgent } from "./agents.ts";
import { resolveRepoProfile } from "./build/profile.ts";
import { bunExec } from "./build/exec.ts";
import { appendLedger, manifestHash, commandsHash } from "./build/ledger.ts";
import { runGate, pickChecks, formatGateFailure, formatGateOutcome } from "./build/gate.ts";
import { scanStubs, formatStubFindings } from "./build/stubscan.ts";
import { isWebApp } from "./build/codeintel.ts";
import { browserVerify, formatBrowserVerify } from "./build/browser-verify.ts";
import { gitPrepare, gitCommitGreen } from "./build/gitops.ts";
import { type Diagnostics, TsDiagnostics } from "./diagnostics.ts";
import { CompositeDiagnostics } from "./lsp/composite.ts";
import {
  loadCommandFiles,
  loadCommandsFrom,
  loadSkills,
  loadSkillsFrom,
  globalCommandsDir,
  globalSkillsDir,
} from "./loaders.ts";
import { LoopCancelledError, LoopController, parseLoopArgs } from "./loop.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { MemoryService } from "./memory-service.ts";
import { createLimiter, type Limiter } from "./limiter.ts";
import { createBlackboard } from "./blackboard.ts";
import { registerConfigHooks } from "./config-hooks.ts";
import { loadProjectMemory, vibeConfigDir } from "./memory.ts";
import { globalStateDir } from "./state-dir.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { McpHub, type McpConnect } from "./mcp.ts";
import { readGitInfo, spawnGit, type GitRunResult } from "./git-info.ts";
import { withRetry } from "./retry.ts";
import { expandMentions, type ImageAttachment } from "./mentions.ts";
import {
  captionImages,
  captionsToContextBlock,
  shouldRelay,
  type CaptionResult,
} from "./vision-relay.ts";
import { cleanProactiveRecallSeed } from "./proactive-recall.ts";
import {
  handleSlash,
  handleApprovals,
  setMainModel,
  setSubagentModel,
  type EngineHandle,
} from "./engine-commands.ts";

/** Hard ceiling on session.idle (Stop-equivalent) continuations per user prompt.
 * A hook that always asks to continue caps here, then the engine warns and
 * settles idle — the headless terminal signal (engine-idle) must never be held
 * open indefinitely by a buggy hook. */
const MAX_IDLE_CONTINUES = 3;

/** Bounded end-of-turn nudges when plan mode researched but never called
 * present_plan (free-form chat plans skip the approval card). One is enough to
 * re-steer; a second would just burn tokens if the model still won't present. */
const MAX_PLAN_PRESENT_NUDGES = 1;

/** Consecutive clean self-assessments a /goal run needs before it may finish.
 * The first "met" verdict buys a dedicated adversarial verify turn, not the
 * finish line — only a clean assessment AFTER that verify turn ends the run
 * (the same converge-on-N-clean-passes discipline the audit ledger uses). */
const MAX_GOAL_CLEAN_PASSES = 2;

/** Evidence cap for the goal self-assessment prompt (diff portion). */
const GOAL_ASSESS_DIFF_CAP = 8_000;

/** Cap on verify-command output fed back to the model (matches the legacy
 * runVerify MAX_OUTPUT). */
const VERIFY_MAX_OUTPUT = 8_000;

/** Build manifests whose appearance/change signals the project's check set may
 * have shifted (a scaffolder ran) — used by the gate's no-checks refresh guard. */
const GATE_MANIFEST_FILES = [
  "package.json",
  "tsconfig.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "composer.json",
];

/**
 * A cheap fingerprint of `cwd` for the gate's no-runnable-checks refresh: the
 * build manifests (name:mtime) PLUS the sorted set of top-level entry names. The
 * refresh compares it turn-over-turn so it can tell "the check set may have
 * changed" (a scaffolder wrote a manifest, OR a test dir/file appeared —
 * signature changed → re-scan) from "this repo simply has no checks" (signature
 * stable → skip the repeat full recon that would otherwise run every mutating
 * turn). Including the top-level entry SET catches checks that arrive via a
 * non-manifest file (a new `tests/` dir, `test_app.py`) without re-scanning every
 * turn — the guard block is only reached when there are no runnable checks yet.
 * Pure + injectable for testing.
 */
/** Deterministic override on the goal self-assessment: a model verdict of
 * "met" can never stand on a non-green gate verdict. Failing, missing, or
 * aborted checks are hard gaps, not judgment calls.
 *
 * `opts.checksAvailable`: when true, a missing gate report (`undefined`) is
 * treated like `unverified` — the repo has real checks, so "met" cannot pass
 * without a green run. When false/omitted, `undefined` is a free pass (no
 * checks to run; pure unit tests and check-less workspaces). Pure + exported
 * for unit testing. */
export function applyGateToVerdict(
  verdict: { met: boolean; gaps: string[]; reason: string },
  gate: "green" | "red" | "unverified" | "aborted" | undefined,
  opts: { checksAvailable?: boolean } = {},
): { met: boolean; gaps: string[]; reason: string } {
  if (!verdict.met || gate === "green") return verdict;
  // No gate report: free-pass only when there is nothing to check.
  if (gate === undefined && !opts.checksAvailable) return verdict;
  const detail =
    gate === "red"
      ? "project checks failing (gate red)"
      : gate === "aborted"
        ? "project checks aborted"
        : "project checks unverified";
  return {
    met: false,
    gaps: [...verdict.gaps, detail],
    reason:
      gate === "red"
        ? "the gate is red — checks must pass before the goal can be met"
        : "the gate is unverified — checks must run green before the goal can be met",
  };
}

export function manifestSignature(cwd: string): string {
  const parts: string[] = [];
  for (const m of GATE_MANIFEST_FILES) {
    try {
      parts.push(`${m}:${statSync(join(cwd, m)).mtimeMs}`);
    } catch {
      /* absent → contributes nothing (its later appearance flips the sig) */
    }
  }
  try {
    // The top-level entry name set — a new file/dir (a test dir, a manifest, a
    // source file in a new language) flips the sig even if no manifest mtime did.
    // Exclude clearly-incidental churn (dotfiles/OS cruft, logs, scratch notes)
    // so a `scratch.log`/`.DS_Store` doesn't re-recon a check-less repo every turn
    // — only entries that could plausibly make CHECKS detectable count.
    const relevant = readdirSync(cwd)
      .filter((e) => !/^\.|\.(log|tmp|temp|swp|swo|bak|orig|md|txt|lock|cache|DS_Store)$/i.test(e))
      .sort();
    parts.push(`entries:${relevant.join(",")}`);
  } catch {
    /* unreadable cwd → manifests alone drive the sig */
  }
  return parts.join("|");
}

export interface EngineOptions {
  config: Config;
  cwd?: string;
  registry?: ProviderRegistry;
  toolset?: Toolset;
  hooks?: HookBus;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  catalog?: CatalogService;
  projectMemory?: string;
  permissionResolver?: PermissionResolver;
  /** Override the MCP transport (tests inject a fake connector). */
  mcpConnect?: McpConnect;
  /**
   * Whether a UI can answer permission prompts. When false (headless/`-p`),
   * `ask` decisions auto-allow instead of hanging. Defaults to false.
   */
  interactive?: boolean;
  /** Persisted session to resume (from SessionStore.load). */
  resume?: PersistedSession;
  /** Explicit `--model` / `--mode` flags that should override a resumed session's
   * saved values (an explicit user flag beats the persisted meta). */
  modelOverride?: string;
  modeOverride?: Mode;
  logger?: Logger;
}

export function sandboxStateDirs(cwd: string): string[] {
  return [
    vibeConfigDir(),
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    join(cwd, ".vibe"),
    // Per-project machine state (sessions/plans/checkpoints) now lives here.
    globalStateDir(cwd),
  ];
}

/**
 * Top-level engine: owns the active session, the event bus, the provider
 * registry, and the toolset. Implements `EngineClient` so any UI can drive it.
 */
export class Engine implements EngineClient {
  readonly registry: ProviderRegistry;
  readonly toolset: Toolset;
  readonly hooks: HookBus;
  readonly commands: CommandRegistry;
  readonly skills: SkillRegistry;
  readonly catalog: CatalogService;

  #bus = new EventBus();
  /** Background shell jobs (+ detected localhost servers), owned here so the
   * registry is reachable from the engine (the toolset would otherwise create its
   * own hidden one). `onChange` pushes a `jobs-changed` event to the TUI. */
  #jobs = new BackgroundJobs({ onChange: () => this.#emitJobs() });
  /** Last computed working-tree git state, seeded into the snapshot. */
  #gitState: GitInfo | undefined;
  #config: Config;
  #cwd: string;
  /** Resolved OS-sandbox policy (config + live env + state dirs), threaded to the
   * toolset, background jobs, the build gate, and verify. Its warning (if any) is
   * emitted ONCE at bootstrap. */
  #sandbox: SandboxPolicy;
  #projectMemory: string | undefined;
  #session: Session;
  #log: Logger;
  /** FIFO work backlog. `onCancel` fires when the item is REMOVED without
   * running (abort / dequeue / `/queue clear` / `/loop stop`) — a queued loop
   * iteration holds a promise the LoopController awaits, and dropping the item
   * without settling it would leave the loop permanently hung yet "active". */
  #pending: {
    id: string;
    label: string;
    run: () => Promise<unknown>;
    onCancel?: (reason: string) => void;
    /** Which machinery queued this item. Goal-run turns carry "goal" so the
     * sweep/stack-guard match on provenance, not on the label text — a USER
     * prompt that happens to start with "goal: " must never be swept. */
    origin?: "goal" | "loop";
  }[] = [];
  #active: QueuedItem | null = null;
  #draining = false;
  #drainPromise: Promise<void> | undefined;
  #idleResolvers: (() => void)[] = [];
  #agents = new Map<string, NamedAgent>();
  /** One per-file write lock shared across the whole session tree (parent +
   * every subagent), so concurrent agents can't corrupt the same file. */
  #fileLock = createFileLock();
  /** Per-tree stale-write guard (one per Session tree, owned by the engine).
   * Threaded into every fork via `handle.deps.freshness`; cleared in
   * `finalize` so a worker-thread reuse can't leak a prior tree's tracking
   * into the next one. See `FreshnessRegistry` for the per-session storage
   * + tree-lifetime teardown design. */
  #freshness = new FreshnessRegistry();
  /** Tree-global adaptive concurrency gate in front of every provider call
   * (initialized in the constructor once config is available). */
  #limiter!: Limiter;
  /** Shared coordination board for parallel subagents, shared across the tree. */
  #blackboard = createBlackboard();
  /** Diagnostics-in-the-loop seam (lazy; no-op without the optional deps) —
   * edit/write append its diagnostics so errors surface in the same step. Bare
   * `TsDiagnostics` when `lsp.enabled` is off (default-safe path unchanged); a
   * multi-language `CompositeDiagnostics` (TS fast path + LSP) when on. Assigned
   * in the constructor once config is available. */
  #diagnostics!: Diagnostics;
  #loop: LoopController | undefined;
  /** The session running the current loop iteration, so a stop can abort it. */
  #loopSession: Session | undefined;
  #permissionResolver: PermissionResolver | undefined;
  #interactive: boolean;
  #alwaysAllow = new Set<string>();
  #pendingPermissions = new Map<
    string,
    (d: "once" | "always" | "always-project" | "deny", feedback?: string) => void
  >();
  #store: SessionStore;
  #checkpoints: CheckpointManager;
  #mcp: McpHub;
  #memory: MemoryService | undefined;
  /** Whether proactive recall has already injected context this session (once). */
  #proactiveRecallDone = false;
  /** Memoized finalize promise (digest + teardown runs once). */
  #finalizing: Promise<void> | undefined;
  #shutdownRequested = false;
  /** The last plan the model presented via present_plan (for handoff on execute). */
  #lastPlan: string | undefined;
  /** Armed when a handoff directive must ride the next user prompt: deny-rearm
   * after a vetoed plan-execute turn, and restore from engine state on --resume.
   * Live approve surfaces (card Enter / /execute) do NOT use this — they enqueue
   * the execute turn immediately with `{handoff:true}` bound to that job. */
  #pendingHandoff = false;
  #verifyAttempts = 0;
  /** Bounded red→fix→re-gate rounds for the green-gate, per user prompt (reset
   * on submit-prompt alongside #verifyAttempts). */
  #gateRounds = 0;
  /** Bounded plan-task continuation turns per user prompt (shares the gate's
   * maxRounds budget shape; reset with the other prompt budgets). */
  #taskContinueRounds = 0;
  /** Bounded session.idle (Stop-equivalent) continuations per user prompt: a
   * hook returning {continue:true} injects a follow-up turn, but only this many
   * before the engine warns and settles idle regardless (a buggy always-continue
   * hook can never loop forever). Reset on each real user prompt. */
  #idleContinueRounds = 0;
  /** Bounded present_plan nudges per plan cycle when non-trivial research
   * happened but the model ended on free-form chat without present_plan. */
  #planPresentNudgeRounds = 0;
  /** True while a plan-execution chain is live: armed when the plan→execute
   * handoff turn starts, cleared by the next REAL user prompt (or when the
   * seeded list finishes/caps out). Scopes the completion check to plan runs. */
  #planExecutionActive = false;
  /**
   * True while an engine-owned fix turn (gate-fix / review-fix / verify-fix)
   * is queued but not yet started. Set when the fix is enqueued; cleared when
   * the job begins so THAT turn's own `#afterTurn` can re-drive task/goal
   * continuations. Prevents a GREEN parent from advancing plan/goal chains
   * alongside a still-pending review-fix (double-fire / premature "met").
   */
  #fixPending = false;
  /**
   * Durable stop latch: set by the engine `abort` command (Esc) so post-turn
   * work (gate/review) and idle-continue hooks honor the interrupt even when
   * `Session.run` has already returned (its own `interrupted` only covers the
   * in-flight model turn). Cleared on the next real user prompt.
   */
  #userStop = false;
  /** True while a `/goal` autonomous run is live: armed by `set-goal` with
   * text, cleared on verified-met, round-exhaust, `/goal clear`, or abort.
   * Unlike #planExecutionActive it deliberately survives a mid-run typed
   * prompt — a north-star goal outlives any single prompt, so a steer folds
   * into the run instead of killing it (submit-prompt re-grants the round
   * counters below so the steered run gets fresh runway). */
  #goalRunActive = false;
  /** Which pipeline phase the goal run is in: "plan" (the read-only planning
   * turn is queued/running — assessment is suppressed, #beginGoalExecution runs
   * next), "execute" (task-driven execution + outer assessment), or undefined
   * (no run, or the legacy planFirst:false blended path). Persisted so --resume
   * re-enters the right phase. */
  #goalPhase: "plan" | "execute" | undefined;
  /** Bounded goal-continuation turns for the current run (config goal.maxRounds);
   * zeroed when a run is (re)armed and on each genuine user prompt. The SAME
   * counter also charges goal-run task continuations (#maybeContinueTasks) —
   * one unified budget, so plan-chain rounds can't multiply the ceiling. */
  #goalContinueRounds = 0;
  /** Consecutive clean self-assessments since the model first claimed the goal
   * met; any gap found resets convergence to zero. */
  #goalCleanPasses = 0;
  /** Why an inactive run stopped (short, human) when it can be re-armed with
   * `/goal resume` — Esc, an errored turn, a stuck-red gate, budget exhaust.
   * Cleared on arm/resume/clear; surfaced in the ★ header and bare `/goal`. */
  #goalPauseReason: string | undefined;
  /** True once a run finished verified-met (the ★ goal stays until cleared). */
  #goalMet = false;
  /** Bumped on every arm/resume/pause/stop. The assessment await in
   * #maybeContinueGoal spans seconds — a pause AND re-arm both landing inside
   * it would otherwise let a pre-pause verdict drive the resumed run's first
   * continuation (reachable only by an embedder calling send() directly; the
   * TUI's /goal resume is serialized behind the drain). */
  #goalRunEpoch = 0;
  /** Manifest fingerprint at the last no-runnable-checks gate refresh. A repo
   * that legitimately has no checks would otherwise re-run full recon on EVERY
   * mutating turn; we only re-scan when a build manifest actually changed (which
   * is exactly the scaffold signal the refresh exists for). */
  #lastGateReconSig: string | undefined;
  /** The last green-gate verdict produced during the current prompt's work
   * (across fix rounds), surfaced on `engine-idle` so a headless one-shot can
   * exit non-zero on a persistently-red gate. Reset per user prompt. */
  #lastGateOutcome: "green" | "red" | "unverified" | "aborted" | undefined;
  /** Bounded adversarial-diff-review→fix rounds, per user prompt (reset on submit). */
  #reviewRounds = 0;
  /** The pre-edit checkpoint id for the CURRENT turn. Set in #handlePrompt;
   * undefined when no checkpoint was taken. */
  #turnCheckpointId: string | undefined;
  /** The pre-edit checkpoint captured at the FIRST turn of the current user
   * prompt — the base the diff reviewer diffs against, so a red→fix→green
   * sequence reviews the CUMULATIVE change, not just the last fix turn. Cleared
   * with the round budgets on a fresh user prompt; internal fix turns keep it. */
  #promptBaselineId: string | undefined;
  /** Whether the vision relay is active for this session — determined once
  (after the first prompt's catalog load) and set on the session so the system
  prompt includes the vision relay instructions from the very first turn. */
  #visionRelayDetermined = false;
  /** Branch-mode commit-on-green: gitPrepare's verdict, cached once per session
   * (null = not yet attempted). A refusal disables branch commits for the session
   * and never re-checks (the work branch is checked out ONCE, then we stay on it). */
  #branchPrepared: boolean | null = null;
  /** Lazily-built delegation handle for the slash-command module. */
  #commandHandle: EngineHandle | undefined;

  constructor(opts: EngineOptions) {
    this.#config = opts.config;
    this.#limiter = createLimiter({
      max: opts.config.subagent.providerConcurrency,
      // Floor the AIMD ceiling at the max nesting depth (+1 for the root).
      // Hold-and-wait is structurally eliminated — a parent RELEASES its
      // tree-global slot while awaiting spawned children (Session.
      // suspendLimiterSlot around the child-await funnel) — so this floor and
      // the per-subagent wall-clock timeout (which unwedges a stuck acquire via
      // the abort-aware limiter) are defense-in-depth, not the primary escape.
      min: opts.config.subagent.maxDepth + 1,
      onChange: (limit) => this.#log.debug(`provider concurrency ceiling → ${limit}`),
    });
    this.#cwd = opts.cwd ?? process.cwd();
    // Resolve the OS sandbox once from config + the real state dirs. Writable
    // roots (under workspace-write) always include cwd + tmp; add the app's own
    // state dirs so its writes (config, caches, .vibe sessions) never get denied.
    const stateDirs = sandboxStateDirs(this.#cwd);
    for (const dir of stateDirs) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort; sandbox resolution still reports/degrades normally */
      }
    }
    this.#sandbox = resolveSandboxPolicy(opts.config.sandbox, {
      cwd: this.#cwd,
      stateDirs,
    });
    // The registry was created before the policy resolved (field initializer);
    // apply it so background jobs run under the same backstop as foreground bash.
    this.#jobs.setSandbox(this.#sandbox);
    this.#projectMemory = opts.projectMemory;
    this.#interactive = opts.interactive ?? false;
    // Use the caller's resolver if given (tests); otherwise bridge `ask`
    // decisions to the UI via permission-request / resolve-permission.
    this.#permissionResolver = opts.permissionResolver ?? ((req) => this.#askPermission(req));
    this.#store = new SessionStore(this.#cwd);
    // Lazy getter: #session is assigned below, but a checkpoint is only ever
    // taken later (during a turn), so the id is available by then. Scopes /undo
    // to this session on the shared cwd-keyed checkpoints file.
    this.#checkpoints = new CheckpointManager(this.#cwd, () => this.#session?.id);
    this.#mcp = new McpHub({
      registerTool: (def) => this.toolset.register(def),
      unregisterTool: (name) => this.toolset.unregister(name),
      ...(opts.mcpConnect ? { connect: opts.mcpConnect } : {}),
    });
    this.registry = opts.registry ?? new ProviderRegistry();
    // Default toolset is config-driven so web search picks up the TinyFish key
    // and respects `search.enabled`.
    this.toolset =
      opts.toolset ??
      new Toolset(
        builtinTools({
          search: {
            enabled: opts.config.search.enabled,
            ...(opts.config.search.apiKey ? { apiKey: opts.config.search.apiKey } : {}),
          },
          webfetch: {
            allowPrivateHosts: opts.config.webfetch.allowPrivateHosts,
            allowHosts: opts.config.webfetch.allowHosts,
            timeoutMs: opts.config.webfetch.timeoutMs,
            maxBytes: opts.config.webfetch.maxBytes,
          },
          jobs: this.#jobs,
          sandbox: this.#sandbox,
        }),
      );
    // Surface tool-name collisions (MCP/plugin tools shadowing a built-in, or a
    // duplicate registration) as a user-visible notice instead of silently
    // last-write-wins.
    this.toolset.onConflict = (message) => this.#notice(message, "warn");
    this.hooks =
      opts.hooks ??
      new HookBus((name, err) =>
        this.#notice(`Plugin hook "${name}" failed: ${err.message}`, "warn"),
      );
    this.commands = opts.commands ?? new CommandRegistry();
    this.skills = opts.skills ?? new SkillRegistry();
    this.catalog = opts.catalog ?? new CatalogService();
    this.#log = opts.logger ?? createLogger("engine");
    // Multi-language diagnostics only when enabled; otherwise the unchanged
    // TS-only path (so disabling LSP restores the exact prior behavior). The
    // workspace-root getter is read lazily at first server spawn.
    this.#diagnostics = opts.config.lsp.enabled
      ? new CompositeDiagnostics(opts.config.lsp, () => this.#cwd, this.#log)
      : new TsDiagnostics();
    const resume = opts.resume;
    this.#session = new Session({
      config: opts.config,
      registry: this.registry,
      toolset: this.toolset,
      bus: this.#bus,
      cwd: this.#cwd,
      sandbox: this.#sandbox,
      // An explicit CLI --model/--mode wins over the resumed session's saved
      // value; otherwise the resumed value wins, falling back to config.
      model: opts.modelOverride ?? resume?.meta.model ?? opts.config.model,
      mode: opts.modeOverride ?? resume?.meta.mode ?? opts.config.mode,
      goal: resume?.meta.goal ?? null,
      projectMemory: opts.projectMemory,
      permissionResolver: this.#permissionResolver,
      onHardBudgetStop: () => {
        this.#userStop = true;
        this.#pauseGoalRun("spend limit reached", {
          notice:
            "Goal run paused — spend limit reached. Raise budget.limitUSD, then /goal resume.",
          level: "warn",
        });
      },
      agents: this.#agents,
      fileLock: this.#fileLock,
      // Per-tree stale-write guard, threaded into every fork via
      // `...this.#deps` (mirrors the file-lock pattern). The session base
      // picks it up and passes it to `ctx.freshness` for `read`/`edit`/`write`.
      freshness: this.#freshness,
      limiter: this.#limiter,
      blackboard: this.#blackboard,
      diagnostics: this.#diagnostics,
      skills: this.skills,
      hooks: this.hooks,
      store: this.#store,
      // Interactivity governs whether subagent `detach` runs in the background
      // (headless coerces it to synchronous — see OrchestratorRunner).
      interactive: this.#interactive,
      getContextWindow: (model) => this.#resolveContextWindow(model),
      getPricing: (model) => this.#resolvePricing(model),
      ...(resume
        ? {
            id: resume.meta.id,
            createdAt: resume.meta.createdAt,
            initialModelMessages: resume.modelMessages,
            initialHistory: resume.history,
            ...(resume.meta.tasks ? { initialTasks: resume.meta.tasks } : {}),
            ...(resume.meta.recalledContext
              ? { initialRecalledContext: resume.meta.recalledContext }
              : {}),
            ...(resume.meta.sources?.length ? { initialSources: resume.meta.sources } : {}),
            ...(resume.meta.usage
              ? {
                  initialUsage: resume.meta.usage,
                  ...(resume.meta.usage.costUSD !== undefined
                    ? { initialCostUSD: resume.meta.usage.costUSD }
                    : {}),
                  // BUG-103: seed actual vs total separately so estimated spend
                  // never hard-stops after --resume. Pre-fix metas lack
                  // actualCostUSD — treat missing as 0 (re-accumulate actual).
                  ...(resume.meta.usage.actualCostUSD !== undefined
                    ? { initialActualCostUSD: resume.meta.usage.actualCostUSD }
                    : {}),
                  ...(resume.meta.usage.costEstimated ? { initialCostEstimated: true } : {}),
                }
              : {}),
            ...(resume.meta.lastInputTokens
              ? { initialLastInputTokens: resume.meta.lastInputTokens }
              : {}),
          }
        : {}),
    });
    // A resumed session that already carries a recalled block must not run
    // proactive recall again (it would stack a second, possibly divergent one).
    if (resume?.meta.recalledContext) this.#proactiveRecallDone = true;

    // Watch our own (fan-out) event stream to capture a presented plan: persist
    // it under the global state dir's plans/ and remember it for the plan→execute
    // handoff. A separate subscriber, so it never steals events from the
    // TUI/headless renderer.
    void this.#watchInternalEvents();
  }

  async #watchInternalEvents(): Promise<void> {
    for await (const event of this.#bus.subscribe()) {
      if (event.type === "plan-presented") await this.#onPlanPresented(event);
    }
  }

  /** Engine-side per-session state that must survive --resume but belongs to
   * the ENGINE, not the conversation: the armed plan handoff and the live goal
   * run (flag, phase, counters). Lives in the project's GLOBAL state dir
   * (machine state never dirties the cwd). */
  #engineStatePath(): string {
    return join(globalStateDir(this.#cwd), "sessions", this.#session.id, "engine.json");
  }

  /** Serializes #persistEngineState writes: the callers are fire-and-forget
   * (`void this.#persistEngineState()`), and two overlapping writes to the same
   * engine.json could otherwise land out of order, persisting a stale flag. */
  #persistEngineStateChain: Promise<void> = Promise.resolve();

  #persistEngineState(): Promise<void> {
    const write = async () => {
      try {
        await mkdir(dirname(this.#engineStatePath()), { recursive: true });
        // Fields are read at write time, so the LAST queued write always
        // persists the newest state.
        await Bun.write(
          this.#engineStatePath(),
          JSON.stringify({
            pendingHandoff: this.#pendingHandoff,
            goalRunActive: this.#goalRunActive,
            goalPhase: this.#goalPhase ?? null,
            goalContinueRounds: this.#goalContinueRounds,
            goalCleanPasses: this.#goalCleanPasses,
            goalPauseReason: this.#goalPauseReason ?? null,
            goalMet: this.#goalMet,
          }),
        );
      } catch {
        /* best-effort — losing this on a crash only loses one convenience flag */
      }
    };
    this.#persistEngineStateChain = this.#persistEngineStateChain.then(write);
    return this.#persistEngineStateChain;
  }

  /** Restore engine-side state + the last presented plan on --resume. */
  async #restoreEngineState(): Promise<void> {
    try {
      const state = (await Bun.file(this.#engineStatePath()).json()) as {
        pendingHandoff?: boolean;
        goalRunActive?: boolean;
        goalPhase?: "plan" | "execute" | null;
        goalContinueRounds?: number;
        goalCleanPasses?: number;
        goalPauseReason?: string | null;
        goalMet?: boolean;
      };
      if (state.pendingHandoff) this.#pendingHandoff = true;
      // Phase / pause / met are restored even when the run is NOT active: a
      // PAUSED run re-armed with `/goal resume` re-enters at this phase, and
      // the ★ header keeps showing paused/met across a restart.
      this.#goalPhase = state.goalPhase ?? undefined;
      this.#goalPauseReason = state.goalPauseReason ?? undefined;
      this.#goalMet = state.goalMet ?? false;
      if (state.goalRunActive) {
        this.#goalRunActive = true;
        this.#goalContinueRounds = state.goalContinueRounds ?? 0;
        this.#goalCleanPasses = state.goalCleanPasses ?? 0;
      }
    } catch {
      /* absent/corrupt → nothing to restore */
    }
    // Global path first, then the pre-relocation in-project path.
    for (const path of [
      this.#planPath(),
      join(this.#cwd, ".vibe", "plans", `${this.#session.id}.md`),
    ]) {
      try {
        const plan = await Bun.file(path).text();
        // Strip the "# Plan — <id>" header the writer prepends.
        this.#lastPlan = plan.replace(/^# Plan — [^\n]*\n+/, "").trim() || undefined;
        break;
      } catch {
        /* try the next location */
      }
    }
  }

  /** Path of the persisted presented-plan file for this session. */
  #planPath(): string {
    return join(globalStateDir(this.#cwd), "plans", `${this.#session.id}.md`);
  }

  /** Delete the persisted plan once its handoff has been consumed, so a later
   * --resume doesn't reload it into #lastPlan and re-arm a spent approval. Also
   * clears the persisted pendingHandoff flag. Best-effort. */
  async #discardPersistedPlan(): Promise<void> {
    try {
      await rm(this.#planPath(), { force: true });
    } catch {
      /* best-effort — a leftover plan file is only re-armed if approved again */
    }
    void this.#persistEngineState();
  }

  /** Persist an approved-able plan and remember it for the execute handoff.
   * Grounding metadata rides along: sources are appended to the persisted file,
   * and an ungrounded plan (the gate's rejection budget ran out) is stamped. */
  async #onPlanPresented(event: {
    plan: string;
    sources?: { url: string; title?: string }[];
    ungrounded?: boolean;
  }): Promise<void> {
    this.#lastPlan = event.plan;
    try {
      const sourceBlock = event.sources?.length
        ? `\n\n## Sources\n${event.sources.map((s) => `- ${s.url}${s.title ? ` — ${s.title}` : ""}`).join("\n")}`
        : "";
      const banner = event.ungrounded
        ? "\n\n> ⚠ UNGROUNDED — presented without the research this request required.\n"
        : "";
      await mkdir(dirname(this.#planPath()), { recursive: true });
      await Bun.write(
        this.#planPath(),
        `# Plan — ${this.#session.id}\n${banner}\n${event.plan}${sourceBlock}\n`,
      );
      this.#bus.emit({
        type: "notice",
        level: "info",
        message: `Plan saved to ${this.#planPath()}`,
      });
    } catch {
      // Best-effort persistence — never let it disrupt the turn.
    }
  }

  /**
   * Resolve a presented plan from the approval modal:
   * - `accept` → switch to execute, seed the task list from the plan's checklist,
   *   and kick off a turn against the approved plan (via the existing handoff);
   * - `edit` → re-enter plan mode with the user's feedback so the model revises it;
   * - `keep-planning` → dismiss the card and stay in plan mode.
   */
  #resolvePlan(
    decision: "accept" | "edit" | "keep-planning",
    edit?: string,
    approvals?: "auto",
  ): void {
    if (decision === "edit") {
      const feedback = edit?.trim();
      if (!feedback) return;
      // Revision feedback means RE-PLAN. The TUI dismisses the card on a mode
      // switch away from plan, but a scripted/plugin resolve-plan can still
      // arrive out of plan mode — re-enter plan mode first, otherwise the
      // feedback would run as an execute turn (and, with a deferred approval
      // armed, kick off implementation of the plan being revised).
      if (this.#session.mode !== "plan") {
        if (this.#pendingHandoff) {
          this.#pendingHandoff = false;
          void this.#persistEngineState();
        }
        this.#setModeGated("plan");
      }
      this.#enqueue(queueLabel(feedback), () => this.#handlePrompt(feedback));
      return;
    }
    if (decision === "keep-planning") {
      // Also revoke a deferred approval a mode switch may have armed while the
      // card was up — "keep planning" must mean NOTHING starts implementation.
      if (this.#pendingHandoff) {
        this.#pendingHandoff = false;
        void this.#persistEngineState();
      }
      // And make the words true: if a mode switch left the session in
      // execute/yolo, return to plan mode — "kept planning" while the next
      // message would run an execute turn is a lie (the TUI dismisses the card
      // on mode change, but a scripted resolve-plan can still land here).
      if (this.#session.mode !== "plan") this.#setModeGated("plan");
      this.#bus.emit({
        type: "notice",
        level: "info",
        message: "Kept planning — the plan wasn't started.",
      });
      return;
    }
    // accept — the plan card's immediate-run surface.
    // An active goal run owns the task spine (#startGoalRun clears #lastPlan, but
    // a card presented DURING a mid-run plan excursion could re-arm it): accepting
    // it would #seedTasksFromPlan over the run's tasks and enqueue a competing
    // execute-plan driver. Refuse; the user clears the run first.
    if (this.#goalRunActive) {
      this.#notice("A goal run owns the task list — /goal clear before accepting a plan.", "warn");
      return;
    }
    // The double-accept guard (a double-click, a scripted/plugin re-send) lives
    // here: #approvePlan clears #lastPlan synchronously, so a second
    // resolve-plan{accept} fails this guard instead of seeding the task list twice
    // + firing two execute turns.
    if (!this.#lastPlan) return;
    this.#approvePlan(approvals);
  }

  /**
   * The engine-owned mode transition, in ONE place: set the mode, then ALWAYS
   * re-gate approvals to `ask` (forgetting prior `always` grants). Every surface
   * that changes mode — the `set-mode` command and the plan-card accept — funnels
   * through here so "requesting a mode lands in gated ask" can't drift between
   * them. Deliberate YOLO is a `set-approvals auto` sent AFTER this, never an
   * inherited `auto`.
   */
  #setModeGated(mode: Mode): void {
    this.#session.setMode(mode);
    handleApprovals(this.#getCommandHandle(), "ask", true);
    this.#applyPlanModel(mode);
  }

  /** The execution model to restore when a `planModel`-driven switch ends. */
  #planModelPrev: string | undefined;

  /**
   * Dedicated planning model (config.planModel): entering plan mode visibly
   * switches the session to it, leaving plan mode restores the execution model.
   * A manual `/model` while planning wins — the restore only fires when the
   * session is still on the plan model.
   */
  #applyPlanModel(mode: Mode): void {
    const planModel = this.#config.planModel;
    if (!planModel) return;
    if (mode === "plan") {
      if (this.#session.model !== planModel) {
        this.#planModelPrev = this.#session.model;
        this.#session.setModel(planModel);
        this.#notice(`Planning on ${planModel} (execution stays on ${this.#planModelPrev}).`);
      } else {
        // Already on the plan model — an explicit `/model <planModel>` or a
        // session resumed mid-plan. There is nothing to restore, so a stale
        // prev from an earlier stay must not linger and clobber that choice.
        this.#planModelPrev = undefined;
      }
    } else if (this.#session.model === planModel) {
      // Leaving plan while on the planning model: restore the execution model.
      // #planModelPrev covers the in-session switch; config.model covers resume
      // (prev is an engine field and is never persisted).
      const target = this.#planModelPrev ?? this.#config.model;
      this.#planModelPrev = undefined;
      if (target !== planModel) this.#session.setModel(target);
    }
  }

  /**
   * The SINGLE plan-approval routine for live user surfaces (plan-card Enter,
   * `/execute`, YOLO). Switches to gated EXECUTE, seeds the task list from the
   * plan checklist, and enqueues the handoff turn NOW. Bare Shift+Tab deliberately
   * does NOT call this (it refuses silent approve while a plan is waiting).
   * `#pendingHandoff` is only for deny-rearm / --resume — not this path.
   */
  #approvePlan(approvals?: "auto"): void {
    // Whether execution should run un-gated (YOLO): an explicit override from
    // the plan card's `Y`, or the user already being in auto-approvals when they
    // accepted (e.g. Shift+Tab'd to yolo while the card was up). Captured BEFORE
    // #setModeGated resets approvals to the gated baseline.
    const wantAuto = approvals === "auto" || this.#config.approvalMode === "auto";
    this.#setModeGated("execute");
    if (wantAuto) handleApprovals(this.#getCommandHandle(), "auto", true);
    const plan = this.#lastPlan;
    this.#lastPlan = undefined;
    // Immediate accept supersedes any deferred approval (deny-rearm / resume) —
    // otherwise the user's NEXT message would fire a second handoff.
    if (this.#pendingHandoff) {
      this.#pendingHandoff = false;
      void this.#persistEngineState();
    }
    if (plan) this.#seedTasksFromPlan(plan);
    // #handlePrompt's handoff directive names the seeded tasks by id and
    // states the update contract, so the kickoff itself stays minimal.
    this.#enqueue("execute plan", () =>
      this.#handlePrompt("Proceed with the approved plan.", { handoff: true }),
    );
  }

  /**
   * Enqueue an engine-owned fix turn (gate-fix / review-fix / verify-fix).
   * Marks `#fixPending` until the job *starts* so the parent turn's `#afterTurn`
   * skips task/goal continuations (mirrors RED), while the fix turn itself can
   * re-drive them once it settles.
   */
  #enqueueFix(label: string, run: () => Promise<unknown>): void {
    this.#fixPending = true;
    this.#enqueue(label, async () => {
      // Clear before the fix runs so its own #afterTurn is not suppressed.
      this.#fixPending = false;
      await run();
    });
  }

  /** Seed the task list from a plan's checklist (`- [ ] step`) or numbered steps.
   * The indent is bounded ({0,3} spaces) so deeply nested sub-bullets don't
   * register as top-level steps and evict real ones when the list is capped.
   * Only UNCHECKED boxes seed: a `- [x]` in the parsed text is narration of
   * work already done (investigation summaries are full of them), and seeding
   * it as `pending` would drive continuation rounds toward phantom work. */
  #seedTasksFromPlan(plan: string): void {
    const lines = plan.split("\n");
    let items = lines
      .map((l) => /^[ \t]{0,3}[-*]\s+\[ ?\]\s+(.+)$/.exec(l)?.[1])
      .filter((t): t is string => !!t);
    if (!items.length) {
      items = lines
        .map((l) => /^[ \t]{0,3}\d+\.\s+(.+)$/.exec(l)?.[1])
        .filter((t): t is string => !!t);
    }
    const titles = items
      .map((t) => t.replace(/\*\*/g, "").replace(/`/g, "").trim())
      .filter(Boolean);
    if (!titles.length) return;
    // Cap the seeded list, but never silently drop the tail: once #maybeContinueTasks
    // sees the seeded tasks complete it declares the plan done, so any untracked
    // step past the cap would be quietly abandoned. Seed the first 11 plus a
    // catch-all that forces the model back to the full plan for the remainder.
    const CAP = 12;
    let seeded = titles;
    if (titles.length > CAP) {
      const remaining = titles.length - (CAP - 1);
      seeded = [
        ...titles.slice(0, CAP - 1),
        `Complete the remaining ${remaining} plan steps (see the full plan)`,
      ];
      this.#notice(
        `Plan has ${titles.length} steps — task list capped at ${CAP}; ` +
          `the last task tracks the remaining ${remaining}.`,
        "info",
      );
    }
    this.#session.setTasks(seeded.map((title) => ({ title, status: "pending" as const })));
  }

  /**
   * Load project-local resources from disk: named agents, custom slash command
   * files, skills, and plugins (which may register more of any of these).
   * Safe to call once before the first run.
   */
  async bootstrap(): Promise<void> {
    // Surface a sandbox-unavailable warning ONCE, here (not in the constructor —
    // no subscriber exists yet then, so the notice would be dropped). Off mode
    // has no warning; an unenforceable requested mode always does.
    if (this.#sandbox.warning) this.#notice(this.#sandbox.warning, "warn");
    // Surface any sensitive fields dropped from an untrusted project config
    // (hooks/plugins/approvalMode-auto/provider baseURL) — the user should know
    // their repo-local settings were ignored, and why.
    for (const notice of configSecurityNotices(this.#config)) this.#notice(notice, "warn");
    for (const [name, agent] of await loadAgents(this.#cwd)) {
      this.#agents.set(name, agent);
    }
    // Skills/commands load in most-local-wins order (the registries are
    // last-write-wins by name, matching how memory precedence works):
    // user-global (~/.config/vibe-codr/{skills,commands}) first, then plugins,
    // then project-local (.vibe/) LAST — so a project file of the same name
    // overrides both a global one and anything a plugin registered.
    for (const cmd of await loadCommandsFrom(globalCommandsDir())) {
      this.commands.register(cmd);
    }
    for (const skill of await loadSkillsFrom(globalSkillsDir())) {
      this.skills.register(skill);
    }

    const extraSkillDirs: string[] = [];
    const host = new PluginHost({
      hooks: this.hooks,
      commands: this.commands,
      skills: this.skills,
      registerTool: (def) => this.toolset.register(def),
      unregisterTool: (name) => this.toolset.unregister(name),
      registerProvider: (def) => this.registry.register(def),
      unregisterProvider: (id) => this.registry.unregister(id),
      addSkillDir: (path) => extraSkillDirs.push(path),
      removeSkillDir: (path) => {
        const i = extraSkillDirs.indexOf(path);
        if (i >= 0) extraSkillDirs.splice(i, 1);
      },
      logger: this.#log,
    });
    await host.load(this.#config.plugins);

    for (const dir of extraSkillDirs) {
      for (const skill of await loadSkillsFrom(dir)) {
        this.skills.register(skill);
      }
    }

    for (const cmd of await loadCommandFiles(this.#cwd)) {
      this.commands.register(cmd);
    }
    for (const skill of await loadSkills(this.#cwd)) {
      this.skills.register(skill);
    }

    // Declarative config hooks (shell/HTTP) layered onto the in-process HookBus.
    if (this.#config.hooks.length) {
      registerConfigHooks(this.#config.hooks, this.hooks, {
        onWarn: (m) => this.#notice(m, "warn"),
      });
    }

    // Long-term memory: resolve the (optional) embedder and attach the service
    // to the live session. Degrades to lexical recall when no embedder is
    // available, so this never blocks or fails startup.
    this.#memory = await MemoryService.create(this.#cwd, this.#config, this.registry, this.#log);
    this.#session.setMemory(this.#memory);

    // Deterministic repo recon: ONE batched probe (ledger-bootstrapped) whose
    // profile rides every prompt + subagent kickoff in the tree, so no agent
    // ever guesses this repo's build/test commands. Never throws — worst case
    // is an empty profile and everything behaves as before.
    await this.#runRecon();

    // Connect MCP servers last so their tools join the same registry.
    await this.#mcp.start(this.#config.mcp.servers);

    // Restore engine-side per-session state (armed plan handoff + the last
    // presented plan + a live goal run) so a --resume picks up exactly where
    // things left off.
    await this.#restoreEngineState();

    // A goal run that was live at shutdown resumes here: the goal text and
    // conversation context came back with the session, so re-enter the loop —
    // an assessment-driven continuation (or the plan turn, if shutdown landed
    // mid-planning), never a fresh drive turn.
    if (this.#goalRunActive) {
      const goal = this.#session.goal;
      if (!goal) {
        this.#goalRunActive = false;
        this.#goalPhase = undefined;
        void this.#persistEngineState();
      } else {
        const phaseLabel =
          this.#goalPhase === "plan"
            ? "planning"
            : `round ${this.#goalContinueRounds}/${this.#config.goal.maxRounds}`;
        this.#notice(`Resuming goal run (${phaseLabel}): ${goal}`);
        this.#emitGoalRun();
        if (this.#goalPhase === "plan") {
          // The SHARED guarded enqueue — a resumed plan turn that throws must
          // pause the run exactly like a fresh one (an unguarded enqueue here
          // once wedged the run permanently: armed, phase "plan", nothing
          // queued, and #maybeContinueGoal early-returns on the plan phase).
          this.#enqueueGoalPlanTurn(goal);
        } else {
          // Queue the re-entry (not a bare call): whenIdle then covers the
          // assessment + whatever it enqueues, and the goal origin keeps it
          // sweepable by /goal clear like every other run turn.
          this.#enqueue("goal: resume", () => this.#maybeContinueGoal(), { origin: "goal" });
        }
      }
    }

    // Seed the header's git context (branch/dirty/ahead-behind/worktree) so it's
    // in the first snapshot; cheap, and only at startup.
    await this.#emitGit();

    // A session that STARTS in plan mode (config/--mode/resume) gets the
    // dedicated planning model too — otherwise only a runtime mode switch would.
    this.#applyPlanModel(this.#session.mode);
  }

  /** Recon the working directory and attach the profile + symbol map to the
   * live session (forks inherit both). Fills `verify.command` from detected
   * commands when the user hasn't set one, so auto-verify and `/verify` work
   * out of the box. Best-effort; recon failure degrades to no profile. */
  async #runRecon(): Promise<void> {
    if (!this.#config.build.enabled || !this.#config.build.recon.enabled) return;
    try {
      const { profile, ledgerFilled } = await resolveRepoProfile(this.#cwd, {
        ledger: this.#config.build.recon.ledger,
      });
      // The symbol map is built once here (mtime-cached upstream, so a rebuild
      // on the next session is incremental) and injected into subagent kickoffs.
      // The profile itself lives on the session (session.repoProfile) — the one
      // place the whole tree, run_check, and the green-gate read it from.
      const map = profile.greenfield
        ? undefined
        : await buildRepoMap(this.#cwd).catch(() => undefined);
      this.#session.setRepoProfile(profile, map?.text || undefined);
      if (!this.#config.verify.command) {
        const detected = [profile.commands.typecheck, profile.commands.test].filter(Boolean);
        if (detected.length) {
          this.#config.verify.command = detected.join(" && ");
          this.#log.info(`verify.command filled from recon: ${this.#config.verify.command}`);
        }
      }
      if (ledgerFilled.length) {
        this.#log.info(`recon: ledger filled ${ledgerFilled.join(", ")} from a prior green run`);
      }
    } catch (err) {
      this.#log.debug(`recon skipped: ${(err as Error).message}`);
    }
  }

  events(): AsyncIterable<UIEvent> {
    return this.#bus.subscribe();
  }

  snapshot(): EngineSnapshot {
    return {
      ...this.#session.snapshot(),
      ...(this.#session.goal ? { goalRun: this.#goalRunInfo() } : {}),
      commandNames: this.#commandNames(),
      subagentModel: this.#config.subagent.model,
      reasoning: this.#config.reasoning.effort,
      ...(this.#gitState ? { git: this.#gitState } : {}),
    };
  }

  /** Every invocable slash name — built-ins, custom/plugin commands, and skills
   * (which run as `/skillname`) — for the input's "recognized command" cue.
   * Skills with `userInvocable: false` stay off the palette (background only). */
  #commandNames(): string[] {
    return [
      ...BUILTIN_COMMANDS.map((c) => c.name),
      ...this.commands.list().map((c) => c.name),
      ...this.skills.userVisible().map((s) => s.name),
    ];
  }

  /**
   * Finalize the session: write a cross-run digest to long-term memory (when
   * `memory.sessionDigest` is on), then tear down (hooks, loop, MCP, memory,
   * bus). Idempotent and awaitable — the CLI awaits it before process exit so an
   * in-flight digest completes; the `shutdown` command also triggers it.
   */
  finalize(): Promise<void> {
    this.#finalizing ??= this.#doFinalize();
    return this.#finalizing;
  }

  async #doFinalize(): Promise<void> {
    // Quiesce first: drop everything still queued (a loop iteration, goal round,
    // or typed-ahead prompt) and abort the in-flight turn. Without this, a
    // dequeued item would run a full model turn AFTER teardown — against a closed
    // bus (emits become no-ops) and a closed MCP hub. Cancel callbacks fire so
    // origin-tagged loop/goal items settle cleanly. buildDigest below installs a
    // fresh AbortController, so aborting here doesn't poison the digest.
    this.#shutdownRequested = true;
    const dropped = this.#pending;
    this.#pending = [];
    for (const item of dropped) item.onCancel?.("shutdown");
    if (dropped.length) this.#emitQueue();
    this.#session.abort();
    this.#loopSession?.abort();
    this.#loop?.stop("shutdown");
    // Unblock any in-flight permission prompts before waiting for the current
    // queue item to unwind. Resource teardown must happen only after the drainer
    // has exited; otherwise active turns can emit to a closed bus or call closed
    // MCP transports.
    this.#settlePendingPermissions("shutdown");
    await this.#drainPromise;
    try {
      // Digests are for INTERACTIVE sessions: a headless `-p` one-shot must not
      // pay an extra model call (cost + latency) on every scripted invocation.
      if (this.#config.memory.sessionDigest && this.#memory && this.#interactive) {
        const digest = await this.#session.buildDigest();
        if (digest) {
          const saved = await this.#memory.save({ fact: digest, tags: ["session-digest"] });
          this.#log.info(
            saved.deduped
              ? "session digest already stored — duplicate skipped"
              : `wrote session digest to ${saved.path}`,
          );
        }
      }
    } catch (err) {
      this.#log.debug(`session digest skipped: ${(err as Error).message}`);
    }
    void this.hooks.run("session.end", { sessionId: this.#session.id });
    // Abort + await any outstanding DETACHED (background) subagents: a
    // detached child gets `parentSignal: undefined` so the spawning turn ending
    // can't kill it, so finalize is the ONLY thing that reaps it — otherwise a
    // background child could still emit to the bus or use MCP while teardown is
    // closing those resources. Mirrors the job-reaper below. No-op when the tree
    // never spawned a detached child.
    const registry = this.#session.childRegistry;
    if (registry) {
      registry.abortAllDetached();
      // Finalize hang: `awaitAllDetached()` without a bound waits indefinitely
      // for a wedged background child whose promise never settles. An abort was
      // already signaled above, so anything still settling is hung — not
      // finishing — and would otherwise block graceful exit forever. The bound
      // is generous so normal async unwind completes; if it hits, teardown
      // carries on (a pride-straggler is reaped when the process exits; it can
      // no longer touch resources that already tore down above).
      await registry.awaitAllDetached(5_000);
    }
    // Reap surviving background jobs (dev servers etc.) — the process is going
    // away; leaving them orphaned made every `bash background:true` a leak. Await
    // the SIGKILL escalation so a child that ignores SIGTERM can't outlive us.
    await this.#jobs.killAllAndWait();
    await this.#mcp.close();
    // Kill any spawned language servers (and their worker grandchildren) — a
    // no-op for the bare TS path, which has nothing to dispose.
    this.#diagnostics.dispose?.();
    this.#memory?.close();
    this.#bus.close();
    // Drop the per-tree stale-write tracking so a worker-thread reuse can't
    // leak the prior tree's records into the next one. Called after
    // `bus.close()` so any in-flight tool's read/edit/write has settled.
    this.#freshness.clear();
  }

  /** Resolves when the queue (running + pending work) has fully drained. */
  whenIdle(): Promise<void> {
    if (!this.#draining && this.#pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleResolvers.push(resolve));
  }

  /** Emit the initial session-start event (call once after subscribing). */
  start(): void {
    this.#bus.emit({
      type: "session-start",
      sessionId: this.#session.id,
      model: this.#session.model,
      mode: this.#session.mode,
    });
    void this.hooks.run("session.start", { sessionId: this.#session.id });
  }

  send(command: EngineCommand): void {
    switch (command.type) {
      case "submit-prompt": {
        // A fresh user prompt resets the auto-verify retry budget AND the
        // green-gate / diff-review round budgets (all bounded per user prompt),
        // plus the diff-review baseline — same reset a slash-command-initiated
        // prompt gets via the handle's resetTurnBudgets().
        this.#resetPromptBudgets();
        // A typed prompt during a goal run is a STEER, not a stop: #goalRunActive
        // stays armed (deliberately not part of #resetPromptBudgets — goal
        // continuation turns call that reset themselves for fresh gate budgets,
        // and must never zero their own round counter), but the counters restart
        // so the steered run gets fresh runway and must re-converge. Persist the
        // re-grant (a kill during the steer turn would otherwise resume with the
        // PRE-steer counts from engine.json — possibly disarming instantly) and
        // say what happened: the round notices visibly jump back to 1/N.
        if (this.#goalRunActive) {
          this.#goalContinueRounds = 0;
          this.#goalCleanPasses = 0;
          void this.#persistEngineState();
          this.#emitGoalRun();
          this.#notice("Steer folded into the goal run — round budget refreshed.", "info");
        }
        // Capture any armed plan handoff NOW and bind it to THIS prompt's job, so
        // it can't be stolen by an unrelated prompt that was queued ahead of it
        // (the flag used to be read at turn-run time — see #handlePrompt).
        const handoff = this.#pendingHandoff;
        this.#pendingHandoff = false;
        if (handoff) void this.#persistEngineState();
        this.#enqueue(queueLabel(command.text), () => {
          // A fresh top-level prompt starts a fresh coordination context: the
          // blackboard is per-fan-out scratch (claims, transient decisions), NOT
          // durable state — the task list and long-term memory carry that.
          // Clearing here (not on loop iterations, verify-fix turns, or the plan
          // handoff, which don't route through submit-prompt) stops a stale note
          // like "taking auth.ts" from turn 1 leaking into an unrelated fan-out
          // many turns later.
          // Invariant: a DETACHED spawn_tasks batch outlives the turn that
          // spawned it and its children keep posting claims/decisions across
          // turn boundaries — clearing mid-run would yank the board out from
          // under a live fan-out. Skip the clear while any detached child is
          // still running (the stale-note guard resumes the moment the last one
          // settles). The clear runs when THIS prompt's turn STARTS — inside the
          // queued job, not at enqueue time — because at enqueue time a prior
          // turn may still be mid-flight: its attached fan-out isn't counted by
          // runningDetachedCount, and a detached batch it is ABOUT to spawn
          // hasn't registered yet, so an eager clear used to wipe live
          // coordination state (e.g. a decision posted moments before the
          // batch's children kick off and read the board). FIFO guarantees that
          // by job start the prior turn has finished and anything detached it
          // started is registered.
          if (!this.#session.childRegistry?.runningDetachedCount()) {
            this.#blackboard.clear();
          }
          return this.#handlePrompt(command.text, { handoff });
        });
        break;
      }
      case "set-mode": {
        // Leaving plan mode for execute right after a presented plan = approval.
        // Shift+Tab (and other bare set-mode clients) MUST NOT silently approve:
        // only an explicit start (plan-card Enter / /execute slash) starts work.
        // A bare set-mode with a live plan stays in plan and notices — the user
        // must accept the card or type /execute.
        const approvingPlan =
          this.#session.mode === "plan" &&
          command.mode === "execute" &&
          this.#lastPlan !== undefined;
        if (approvingPlan && command.start) {
          // Explicit approve+start (card Enter / /execute): run immediately.
          this.#approvePlan();
        } else if (approvingPlan) {
          // Bare set-mode (Shift+Tab): do NOT auto-approve. Stay in plan so the
          // card remains the approval surface; chip would otherwise dismiss it
          // via mode-changed and leave a deferred "next message" trap.
          this.#notice(
            "A plan is waiting for approval — press Enter on the plan card (or type /execute) to start. Shift+Tab does not approve.",
            "info",
          );
        } else {
          // Requesting a mode ALWAYS lands in the gated baseline (approvals →
          // ask, `always` grants forgotten) — an ENGINE-owned invariant, not a UI
          // courtesy. Every client (typed /plan → /execute, Shift+Tab, scripts
          // embedding the engine) leaves plan in gated EXECUTE, never inheriting
          // a lingering `auto` from a prior YOLO; and an explicit re-request of
          // the current mode re-arms the gate. Deliberate YOLO is a
          // `set-approvals auto` sent AFTER this (exactly what the TUI's yolo
          // target does), so it survives.
          this.#setModeGated(command.mode);
          if (command.mode === "plan" && this.#pendingHandoff) {
            // Returning to plan mode revokes a pending approval: a handoff that
            // survived into plan would prepend "proceed with implementing it now"
            // to a read-only turn — a directive the mode can't honor.
            this.#pendingHandoff = false;
            void this.#persistEngineState();
          }
          if (command.mode === "plan") {
            // Plan-execution chains must stop when the user re-enters plan: the
            // continuation would enqueue read-only "finish the tasks" turns that
            // can't complete work. Goal runs already pause below.
            if (this.#planExecutionActive) {
              this.#planExecutionActive = false;
              this.#notice("Plan execution paused — switched back to plan mode.", "info");
            }
            if (this.#goalRunActive) {
              // Switching to plan mode mid-run would make every goal continuation a
              // read-only plan turn (#ensureExecuteModeForGoal only runs at
              // start/resume) — tasks can't complete, so the run burns its whole
              // round budget on deterministic not-met rounds. Honor the intent: pause
              // the run (resume re-ensures execute mode).
              this.#pauseGoalRun("switched to plan mode");
            }
          }
        }
        break;
      }
      case "set-approvals":
        // Immediate (not queued), mirroring set-mode — the mode toggle must
        // take effect at once so the next turn sees the new approval policy.
        // Quiet only when the sender says so (the Shift+Tab cycle, where the
        // mode chip is the feedback); a typed `/approvals <v>` gets its confirm.
        // Quiet YOLO while a plan is waiting is almost always the Shift+Tab
        // cycle after a refused bare set-mode (engine stayed in plan). Ignore
        // it so plan-card Enter does not inherit unattended YOLO by accident.
        // Explicit `/approvals auto` (not quiet) and Ctrl+Y (approvals on accept)
        // still work.
        if (
          command.quiet &&
          command.mode === "auto" &&
          this.#session.mode === "plan" &&
          this.#lastPlan !== undefined
        ) {
          break;
        }
        handleApprovals(this.#getCommandHandle(), command.mode, command.quiet ?? false);
        break;
      case "set-model":
        // Persist too, so the choice is remembered across sessions (the menu and
        // any direct sender route here; `/model …` goes through the slash router).
        void setMainModel(this.#getCommandHandle(), command.model);
        break;
      case "set-subagent-model":
        // The interactive model picker (and `/model sub …`) route here; persisted.
        void setSubagentModel(this.#getCommandHandle(), command.model);
        break;
      case "set-agent-model":
        void this.#setAgentModel(command.name, command.model);
        break;
      case "create-agent":
        void this.#createAgent(command.name);
        break;
      case "set-goal":
        // Setting a goal is not passive metadata: it arms an autonomous run
        // that plans, works, self-assesses, and keeps continuing (bounded)
        // until the goal is verified met. Clearing stops that run.
        this.#session.setGoal(command.goal);
        if (command.goal) this.#startGoalRun(command.goal);
        else this.#stopGoalRun("cleared by user");
        break;
      case "resume-goal": {
        // Re-arm a PAUSED run with the stored goal (fresh round budget), at the
        // phase it paused in — a restart-from-scratch is `set-goal` (`/goal
        // <text>`), not this.
        const storedGoal = this.#session.goal;
        if (!storedGoal) {
          this.#notice("No goal set — /goal <text> sets one and starts a run.");
        } else if (this.#goalRunActive) {
          this.#notice(
            `Goal run already active (round ${this.#goalContinueRounds}/${this.#config.goal.maxRounds}).`,
          );
        } else {
          this.#resumeGoalRun(storedGoal);
        }
        break;
      }
      case "abort":
        // Durable stop: Session.interrupted only latches during Session.run, so
        // Esc during post-turn gate/review would otherwise leave chains free to
        // re-enqueue. #userStop is cleared on the next real user prompt.
        this.#userStop = true;
        this.#fixPending = false;
        // An abort also pauses a live goal run: the interrupted guard already
        // blocks the NEXT continuation, but the flag must drop too so a later
        // unrelated prompt can't resurrect the run. The ★ goal itself stays
        // set (the user paused the work, they didn't clear the north star).
        // #pauseGoalRun persists the disarm (a kill-then---resume must not
        // resurrect an Esc'd run) and SAYS SO — the start notice promised
        // "typing steers it", so a silent state flip here would leave the
        // user steering a run that no longer exists.
        this.#pauseGoalRun("interrupted (Esc)", {
          notice:
            "Goal run paused by the interrupt — the ★ goal stays set. /goal resume re-arms it; /goal clear drops it.",
        });
        // Drop everything still waiting, then cancel the in-flight turn — which
        // may be a loop iteration running on an ephemeral session (`#loopSession`
        // is set only for the duration of that iteration), not the main session.
        if (this.#pending.length) {
          const dropped = this.#pending;
          this.#pending = [];
          for (const p of dropped) p.onCancel?.("aborted");
          this.#emitQueue();
        }
        // Resolve any on-screen permission prompt as `deny` so the cancelled
        // tool doesn't run — and so a stale card, if clicked later, can't fulfil
        // an already-settled promise and slip a side-effecting call past the
        // abort. Emit `permission-settled` so the UI drops the card too: an abort
        // from a non-user source (steer / budget-stop / loop-stop) would
        // otherwise leave it lingering into the next turn.
        this.#settlePendingPermissions("aborted");
        (this.#loopSession ?? this.#session).abort();
        // Also stop detached (background) children: Esc means stop the run, not
        // only the foreground turn. Their private AbortControllers are not wired
        // to the session abort — without this they'd keep writing until finalize.
        this.#session.childRegistry?.abortAllDetached();
        break;
      case "dequeue": {
        // Remove one waiting prompt without running it (cancel a queued item).
        const removed = this.#pending.filter((p) => p.id === command.id);
        if (removed.length) {
          this.#pending = this.#pending.filter((p) => p.id !== command.id);
          for (const p of removed) p.onCancel?.("dequeued");
          this.#emitQueue();
          // Dequeuing a goal-run turn would otherwise leave the run armed with
          // nothing queued — dead until an unrelated prompt's #afterTurn
          // unexpectedly revived it. Removing the run's next turn means pause.
          if (removed.some((p) => p.origin === "goal")) {
            this.#pauseGoalRun("its queued turn was removed");
          }
        }
        break;
      }
      case "steer": {
        // Jump a waiting prompt to the front and interrupt the running turn, so
        // the drain picks it up next — "steer" the agent now. Other queued items
        // keep their order behind it; nothing is dropped.
        const idx = this.#pending.findIndex((p) => p.id === command.id);
        const [item] = idx >= 0 ? this.#pending.splice(idx, 1) : [];
        if (item) {
          this.#pending.unshift(item);
          this.#emitQueue();
          // Interrupt whatever turn is actually in flight (a loop iteration runs
          // on `#loopSession`, not the main session) so the drain picks up the
          // steered item next.
          (this.#loopSession ?? this.#session).abort();
        }
        break;
      }
      case "run-slash":
        // `/queue` inspects/clears the queue, so it must run immediately rather
        // than wait behind the work it is meant to describe. `/loop stop` too:
        // queued behind an already-enqueued iteration it could not sweep the
        // tick ahead of it, so one more full model turn ran after "stop". It
        // only mutates loop/queue state (never the conversation), so running it
        // at dispatch is safe.
        if (command.name === "queue") this.#handleQueueCommand(command.args);
        else if (command.name === "loop" && command.args.trim() === "stop")
          this.#handleLoop(command.args);
        else this.#enqueue(`/${command.name}`, () => this.#handleSlash(command.name, command.args));
        break;
      case "compact":
        this.#enqueue("/compact", () => this.#session.compact());
        break;
      case "resolve-permission": {
        const resolve = this.#pendingPermissions.get(command.id);
        if (resolve) {
          this.#pendingPermissions.delete(command.id);
          resolve(command.decision, command.feedback);
        }
        break;
      }
      case "resolve-plan":
        this.#resolvePlan(command.decision, command.edit, command.approvals);
        break;
      case "shutdown":
        // Kick off the awaitable finalize (session digest + teardown). The CLI
        // also awaits finalize() before process exit so the digest completes.
        void this.finalize();
        break;
    }
  }

  /**
   * Permission bridge: emit a `permission-request` and await the UI's
   * `resolve-permission`. Auto-allows when non-interactive (nothing can answer)
   * and remembers `always` decisions for the rest of the session.
   */
  async #askPermission(req: {
    toolName: string;
    input: unknown;
    explicit?: boolean;
  }): Promise<PermissionReply> {
    // Non-interactive (headless/`-p`/CI): a frictionless DEFAULT ask auto-allows
    // so scripted runs aren't wedged waiting for a human, but an EXPLICIT gate
    // (`{action:"ask"}` a user deliberately authored) fails CLOSED — there is no
    // human to approve, and silently upgrading an authored gate to `allow` would
    // let e.g. `{tool:"git_push", action:"ask"}` push unattended.
    if (!this.#interactive) return !req.explicit;
    // `always` is remembered per (tool + content scope), NOT per tool name: an
    // "always allow" on `bash {command:"git status"}` must not also green-light
    // `bash {command:"rm -rf /"}`. Tools with no natural scope fall back to the
    // tool name (the whole tool is remembered).
    const key = this.#alwaysAllowKey(req.toolName, req.input);
    if (this.#alwaysAllow.has(key)) return true;
    // Bail if the turn is already aborted — no point emitting a card the abort
    // just settled.
    const signal = (this.#loopSession ?? this.#session).abortSignal;
    if (signal.aborted) return { allowed: false };
    const id = createId("perm");
    // The ask is abort-aware: steer / budget-stop / loop-stop abort the session
    // WITHOUT going through #settlePendingPermissions (only the `abort`/`shutdown`
    // cases do). Without this, a tool parked here blocks the tool-execute promise,
    // the SDK turn can't unwind, and the whole FIFO queue freezes behind a card
    // the abort was meant to kill. On abort we deny THIS id and emit
    // permission-settled so the UI drops the dead card — mirroring
    // #settlePendingPermissions for the single parked prompt.
    let onAbort: (() => void) | undefined;
    const reply = await new Promise<{
      decision: "once" | "always" | "always-project" | "deny";
      feedback?: string;
    }>((resolve) => {
      this.#pendingPermissions.set(id, (decision, feedback) => resolve({ decision, feedback }));
      onAbort = () => {
        if (!this.#pendingPermissions.delete(id)) return;
        this.#bus.emit({
          type: "permission-settled",
          sessionId: this.#session.id,
          ids: [id],
          reason: "aborted",
        });
        resolve({ decision: "deny" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#bus.emit({
        type: "permission-request",
        sessionId: this.#session.id,
        id,
        toolName: req.toolName,
        input: req.input,
      });
    }).finally(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    // Both `always` and `always-project` grant for the rest of THIS session
    // (in-memory). `always-project` ADDITIONALLY persists a scoped allow rule
    // into the project config so the grant survives future sessions.
    if (reply.decision === "always" || reply.decision === "always-project") {
      this.#alwaysAllow.add(key);
    }
    if (reply.decision === "always-project") {
      await this.#persistProjectGrant(req.toolName, req.input);
    }
    if (reply.decision !== "deny") return true;
    // A denial with typed feedback travels to the model as the deny reason —
    // "denied by user — use staging instead" steers; a bare denial just blocks.
    return { allowed: false, ...(reply.feedback ? { feedback: reply.feedback } : {}) };
  }

  /** Memory key for an `always`-allow decision: tool name plus its content scope
   * (command/path/url) so "always" is remembered for THIS call shape, not the
   * whole tool. `\x00` can't appear in a tool name or scope, so it's an
   * unambiguous separator. A PATH scope is keyed by its REALPATH-CANONICAL
   * ABSOLUTE form (`grantPathScope` — symlink-dereferenced where the target
   * exists, lexical resolve otherwise): the SAME normalization the permission
   * checker's allow side judges a path against, so the SAME file approved as
   * "src/x.ts" isn't re-prompted when the model next spells it "./src/x.ts" or
   * through a symlinked ancestor. Command/URL/synthetic scopes have no
   * equivalent normalization and stay spelling-EXACT, so an "always allow git
   * status" never green-lights a differently-spelled command. Both the WRITE
   * (grant) and READ (check) sides go through here, so they key identically. */
  #alwaysAllowKey(toolName: string, input: unknown): string {
    const scope = grantPathScope(toolName, input, this.#cwd) ?? scopeString(toolName, input);
    return scope === undefined ? toolName : `${toolName}\x00${scope}`;
  }

  /** Persist an "always (this project)" grant as a scoped `{tool, matchExact?,
   * action:"allow"}` rule in the project config. The scope is derived from the
   * SAME key derivation `#alwaysAllowKey` uses — realpath-canonical absolute
   * path for path tools, the command/URL/synthetic string for command-bearing
   * tools, and no scope (bare tool name) for a tool with no natural scope — so
   * the persisted rule mirrors the in-memory grant EXACTLY.
   * `appendProjectPermission` validates the merged config before writing, so a
   * malformed merge is rejected without bricking the config; any failure
   * degrades to a warn notice (the in-memory grant already applies, so the
   * session isn't blocked). */
  async #persistProjectGrant(toolName: string, input: unknown): Promise<void> {
    // EVERY scoped grant persists as `matchExact` — the user approved ONE
    // concrete call, and the in-memory grant is exact string equality, so the
    // persisted rule must be too. A `match` would compile a literal `*` in the
    // approved command/path into `.*`: approving `rm build/*` would auto-allow
    // `rm build/../secret.env` next session, and a file literally named
    // `a*.ts` would grant every `a…ts` sibling. A PATH grant additionally uses
    // the REALPATH-canonical form (`grantPathScope`): the checker's allow side
    // confines a path to its real target, so a lexical spelling persisted under
    // a symlinked ancestor (macOS `/var`→`/private/var`) would NEVER re-match —
    // the grant silently re-prompted every fresh session. The realpath form is
    // the exact primary form `check()` compares allow rules against, so it
    // re-matches every spelling of the same file.
    const scope = grantPathScope(toolName, input, this.#cwd) ?? scopeString(toolName, input);
    const rule: PermissionRule =
      scope === undefined
        ? { tool: toolName, action: "allow" }
        : { tool: toolName, matchExact: scope, action: "allow" };
    try {
      await appendProjectPermission(this.#cwd, rule);
    } catch (err) {
      // The in-memory grant already applies (added before this call), so a failed
      // persist never blocks the session — just warn that it won't survive resume.
      this.#notice(
        `Couldn't persist the project grant for ${toolName} (kept for this session): ${(err as Error).message}`,
        "warn",
      );
    }
  }

  /** Auto-resolve every pending permission prompt as `deny` (no human answered)
   * and tell the UI which ids settled via `permission-settled`. Emitting AFTER
   * the resolve keeps the deny the source of truth; the event lets the UI drop
   * the dead card so it can't linger past an abort/shutdown — blocking Esc/plan
   * shortcuts or, if clicked later, writing a false "allowed" notice for a tool
   * that never ran. The `resolve-permission` (user-answer) path is separate: it
   * removes exactly its own id and already clears its card in the UI. */
  #settlePendingPermissions(reason: "aborted" | "shutdown"): void {
    if (this.#pendingPermissions.size === 0) return;
    const ids = [...this.#pendingPermissions.keys()];
    for (const resolve of this.#pendingPermissions.values()) resolve("deny");
    this.#pendingPermissions.clear();
    this.#bus.emit({ type: "permission-settled", sessionId: this.#session.id, ids, reason });
  }

  /** Snapshot of the queue for first paint / `/queue`. */
  queueState(): { active: QueuedItem | null; pending: QueuedItem[] } {
    return {
      active: this.#active,
      pending: this.#pending.map(({ id, label }) => ({ id, label })),
    };
  }

  /** `/queue` (show pending) and `/queue clear` (drop everything waiting). */
  #handleQueueCommand(args: string): void {
    if (args.trim() === "clear") {
      const dropped = this.#pending;
      if (dropped.length) {
        this.#pending = [];
        for (const p of dropped) p.onCancel?.("queue cleared");
        this.#emitQueue();
      }
      this.#notice(
        dropped.length ? `Cleared ${dropped.length} queued item(s).` : "Queue is already empty.",
      );
      // Same shape as the dequeue handler: dropping the goal run's queued turn
      // means pause — otherwise the run sits armed with nothing queued until an
      // unrelated prompt's #afterTurn unexpectedly revives it.
      if (dropped.some((p) => p.origin === "goal")) {
        this.#pauseGoalRun("the queue was cleared");
      }
      return;
    }
    const { active, pending } = this.queueState();
    const lines: string[] = [];
    if (active) lines.push(`● running: ${active.label}`);
    pending.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.label}`);
    });
    this.#notice(
      lines.length
        ? `Queue:\n${lines.join("\n")}`
        : "Queue is empty. Type ahead while a turn runs to queue prompts; /queue clear drops them.",
    );
  }

  #emitQueue(): void {
    this.#bus.emit({
      type: "queue-changed",
      active: this.#active,
      pending: this.#pending.map(({ id, label }) => ({ id, label })),
    });
  }

  /** Once per session (when `memory.proactiveRecall` is on), search long-term
   * memory seeded by the first prompt + goal and inject the top hits as a
   * prior-notes block. Uses a cleaned seed + strict relevance floor so path
   * tokens and weak website digests cannot hijack the live turn. Best-effort;
   * never throws. */
  async #maybeProactiveRecall(prompt: string): Promise<void> {
    if (this.#proactiveRecallDone) return;
    if (!this.#config.memory.proactiveRecall || !this.#memory) return;
    this.#proactiveRecallDone = true;
    try {
      const seed = cleanProactiveRecallSeed(this.#session.goal, prompt);
      if (!seed.trim()) return;
      const hits = await this.#memory.search(seed, 3, { mode: "proactive" });
      if (!hits.length) return;
      const block = hits
        .map((h) => `- ${h.text.replace(/\s+/g, " ").trim().slice(0, 300)}`)
        .join("\n");
      this.#session.setRecalledContext(block);
      // Do not claim "relevant" — the floor is heuristic; the model must still
      // prefer the live user request (and any attached images) over these notes.
      const snippets = hits.map((h) => h.text.replace(/\s+/g, " ").trim().slice(0, 60));
      const preview = snippets.join(" · ");
      this.#notice(
        `Recalled ${hits.length} prior note(s) (ignore if unrelated to this request): ${preview}${snippets.some((s) => s.length >= 60) ? "…" : ""}`,
        "info",
      );
    } catch {
      // Recall is a best-effort enhancement; never let it block the turn.
    }
  }

  /** Re-read project memory from disk and push it into the live session, so a
   * mid-session change (e.g. `/init`, a saved memory, an edited VIBE.md) is
   * reflected in the next turn's system prompt without a restart. */
  async #refreshProjectMemory(): Promise<void> {
    this.#projectMemory = await loadProjectMemory(this.#cwd);
    this.#session.setProjectMemory(this.#projectMemory);
  }

  /** Run one loop iteration; expands a leading custom /command if present. */
  async #runLoopIteration(prompt: string): Promise<string> {
    let text = prompt;
    const slash = parseSlash(prompt);
    if (slash) {
      const cmd = this.commands.get(slash.name);
      if (cmd) {
        const r = cmd.run(slash.args);
        if (r.kind === "prompt") text = r.text;
        else if (r.kind === "notice") {
          // The command failed to expand (e.g. its file vanished mid-session) —
          // surface that and skip the tick instead of prompting the model with
          // the raw slash line.
          this.#notice(r.message, "warn");
          return r.message;
        }
      } else if (
        // BUG-075: built-ins live in handleSlash, not CommandRegistry. Without
        // this branch `/loop 1h /diff` sent the raw slash string to the model.
        BUILTIN_COMMANDS.some((c) => c.name === slash.name) ||
        this.skills.get(slash.name)
      ) {
        return new Promise<string>((resolve, reject) => {
          this.#enqueue(
            `loop: /${slash.name}`,
            async () => {
              this.#loopSession = this.#session;
              try {
                await this.#handleSlash(slash.name, slash.args);
                resolve(this.#session.lastAssistantText() || `/${slash.name}`);
              } catch (err) {
                reject(err as Error);
              } finally {
                this.#loopSession = undefined;
              }
            },
            { onCancel: (reason) => reject(new LoopCancelledError(reason)), origin: "loop" },
          );
        });
      }
    }
    // Route the iteration through the same FIFO queue and prompt handler as user
    // turns so a loop tick inherits conversation history, repo facts,
    // diagnostics, checkpoints, and the post-turn gate. `#loopSession` aliases
    // the active session while the tick runs so `/loop stop` / shutdown target
    // the turn that's actually in flight.
    return new Promise<string>((resolve, reject) => {
      this.#enqueue(
        `loop: ${queueLabel(text)}`,
        async () => {
          this.#loopSession = this.#session;
          try {
            await this.#handlePrompt(text);
            resolve(this.#session.lastAssistantText());
          } catch (err) {
            // Without this reject, a job that throws before resolve() would leave
            // the LoopController awaiting forever — a silent, permanent hang.
            reject(err as Error);
          } finally {
            this.#loopSession = undefined;
          }
        },
        // The iteration was dropped from the queue without running (Esc-abort,
        // dequeue, /queue clear). Settle the promise — otherwise the
        // LoopController awaits run() forever and the loop dies silently while
        // still reporting active. The rejection surfaces as a loop-stopped
        // event with this reason. `origin:"loop"` lets the stop sweep match on
        // provenance, not label text — a typed prompt starting "loop: " is a
        // user turn, never a tick.
        { onCancel: (reason) => reject(new LoopCancelledError(reason)), origin: "loop" },
      );
    });
  }

  /** Evaluate a loop's --until condition with a cheap structured call. Rides
   * the same resilience rails as every other provider call — retry on
   * transients, the tree-global limiter, and a hard deadline so a wedged
   * provider can't stall the loop forever (it used to have none of these).
   * Feeds gate + a short dirty-tree glimpse so "tests pass" / "clean tree"
   * conditions are not judged from assistant prose alone. */
  async #evaluateCondition(
    result: string,
    condition: string,
  ): Promise<{ done: boolean; reason: string }> {
    const model = await withRetry(
      () => this.registry.resolveModel(this.#session.model, this.#config),
      { maxAttempts: this.#config.retry.maxAttempts, baseDelayMs: this.#config.retry.baseDelayMs },
    );
    let workspace = "";
    try {
      const git = await this.#git(["status", "--porcelain", "-b"]);
      if (git.ok && git.stdout.trim()) {
        const text = git.stdout.trim();
        const capped = text.length > 1_500 ? `${text.slice(0, 1_500)}\n…(truncated)` : text;
        workspace = `\nWorkspace git status:\n${capped}\n`;
      }
    } catch {
      /* not a repo / git unavailable */
    }
    const gateLine = `Last gate outcome: ${this.#lastGateOutcome ?? "none"}\n`;
    // generateStructuredObject: native generateObject when the model supports
    // response_format JSON, prompt-JSON fallback otherwise — so /loop --until
    // does not die on ollama/local models that reject structured outputs.
    const supportsStructuredOutput = await this.#supportsStructuredOutput(this.#session.model);
    return await this.#limiter.run(
      () =>
        generateStructuredObject({
          model,
          schema: z.object({ done: z.boolean(), reason: z.string() }),
          abortSignal: AbortSignal.timeout(60_000),
          maxRetries: this.#config.retry.maxAttempts,
          supportsStructuredOutput,
          prompt:
            `You are checking whether a stop condition has been satisfied.\n` +
            `Condition: ${condition}\n\nMost recent agent result:\n${result}\n\n` +
            `${gateLine}${workspace}` +
            `Return done=true only if the condition is clearly satisfied by the evidence. ` +
            `If the condition depends on tests/checks/git cleanliness, prefer the gate and ` +
            `workspace signals over the agent's self-report. When unsure, done=false.`,
        }),
      AbortSignal.timeout(90_000),
    );
  }

  /**
   * Best-effort catalog probe: does this model support native structured JSON
   * response format? Undefined until the catalog loads (treat as "try native").
   * Local ollama tags without a catalog hit default false — they almost never
   * support response_format and would only emit AI SDK warnings + fail assess.
   */
  async #supportsStructuredOutput(model: string): Promise<boolean | undefined> {
    try {
      const cap = await this.catalog.supportsStructuredOutput(model);
      if (cap !== undefined) return cap;
    } catch {
      /* catalog optional */
    }
    // Local Ollama / LM Studio without a catalog hit: skip native generateObject
    // (avoids the AI SDK "responseFormat is not supported" warning flooding the
    // TUI and the "assessment unavailable" path on free-form local models).
    if (
      (model.startsWith("ollama/") && !model.includes("cloud")) ||
      model.startsWith("lmstudio/")
    ) {
      return false;
    }
    return undefined;
  }

  /**
   * Resolve a model's price (USD per 1M tokens). A config `pricing[model]`
   * override wins; otherwise fall back to the live catalog. A partial override
   * (e.g. only `input`) is completed from the catalog — including its
   * long-context `tiers`, which only the catalog knows (a FULL config pin stays
   * authoritative and flat: the user negotiated that rate for every prompt size).
   */
  async #resolvePricing(model: string): Promise<PricingResult | undefined> {
    const override = this.#config.pricing[model];
    // A full config pin is authoritative (a real negotiated rate, not estimated).
    if (override?.input !== undefined && override?.output !== undefined) {
      return override;
    }
    const catalog = await this.catalog.pricing(model);
    if (!override) return catalog; // may carry `estimated` from a base-model match
    return {
      input: override.input ?? catalog?.input,
      output: override.output ?? catalog?.output,
      cacheRead: override.cacheRead ?? catalog?.cacheRead,
      cacheWrite: override.cacheWrite ?? catalog?.cacheWrite,
      tiers: catalog?.tiers,
      estimated: catalog?.estimated,
    };
  }

  /**
   * Resolve a model's real context window (tokens): a config `contextWindow`
   * override wins, then a live probe of the local server (Ollama `/api/show`,
   * LM Studio `/api/v0/models`) that reports the SERVED window, then the
   * models.dev catalog. Falls through to undefined, where the session applies its
   * 128k default — safe for big cloud models, dangerous for small LOCAL ones,
   * which is exactly why local providers are probed here.
   */
  async #resolveContextWindow(model: string): Promise<number | undefined> {
    const override = this.#config.contextWindow[model];
    if (override) return override;
    if (model.startsWith("ollama/")) {
      const probed = await probeOllamaContextWindow(
        model,
        this.#config.providers?.ollama?.baseURL,
        this.#config.providers?.ollama?.apiKey,
      );
      if (probed) return probed;
    }
    if (model.startsWith("lmstudio/")) {
      const probed = await probeLmStudioContextWindow(
        model,
        this.#config.providers?.lmstudio?.baseURL,
      );
      if (probed) return probed;
    }
    return this.catalog.contextWindow(model);
  }

  /** Whether the model accepts image input (undefined if unknown). */
  #supportsImages(model: string): Promise<boolean | undefined> {
    return this.catalog.supportsImages(model);
  }

  /** List models for configured providers, enriched with models.dev metadata. */
  async listModels(): Promise<ModelInfo[]> {
    const live = await this.registry.listConfiguredModels(this.#config);
    return this.catalog.enrich(live);
  }

  /** Every known provider + whether it's configured, for the `/providers` menu.
   * Configured (usable) providers sort first, then alphabetically. */
  listProviders(): ProviderInfo[] {
    return this.registry
      .list()
      .map((d) => ({
        id: d.id,
        configured: this.registry.isConfigured(d.id, this.#config),
        keyless: d.auth.keyless ?? false,
        env: d.auth.env,
      }))
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
  }

  /** Named subagents + their model/mode, for the `/agents` menu. */
  listAgents(): AgentInfo[] {
    return [...this.#agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
      model: a.model ?? null,
      mode: a.mode ?? "execute",
    }));
  }

  /** Available skills (name + description), for the `/skills` menu.
   * Hides `userInvocable: false` background skills; marks user-only
   * (`disableModelInvocation`) skills so the menu can still slash-invoke them. */
  listSkills(): SkillInfo[] {
    return this.skills.userVisible().map((s) => ({
      name: s.name,
      description: s.disableModelInvocation ? `[user-only] ${s.description}` : s.description,
    }));
  }

  /** MCP server roster for the macOS bridge / `/mcp` picker. */
  listMcp(): Array<{
    name: string;
    connected: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
    configured: boolean;
  }> {
    const configured = Object.keys(this.#config.mcp.servers);
    const byName = new Map(this.#mcp.status().map((s) => [s.name, s]));
    const names = [...new Set([...configured, ...byName.keys()])].sort();
    return names.map((name) => {
      const s = byName.get(name);
      return {
        name,
        configured: configured.includes(name),
        connected: s?.connected ?? false,
        toolCount: s?.toolCount ?? 0,
        resourceCount: s?.resourceCount ?? 0,
        promptCount: s?.promptCount ?? 0,
        ...(s?.error ? { error: s.error } : {}),
      };
    });
  }

  /** Reload `.vibe/agents/*.md` into `#agents` after a write. */
  async #reloadAgents(): Promise<void> {
    const next = await loadAgents(this.#cwd);
    this.#agents.clear();
    for (const [name, agent] of next) this.#agents.set(name, agent);
  }

  /** Set (or clear) a named agent's model, persist it, and reload the roster. */
  async #setAgentModel(name: string, model: string | null): Promise<void> {
    const base = this.#agents.get(name);
    if (!base) {
      this.#notice(`No agent named "${name}".`, "warn");
      return;
    }
    try {
      const path = await setAgentModel(this.#cwd, base, model);
      await this.#reloadAgents();
      this.#notice(
        model ? `Agent "${name}" → ${model}` : `Agent "${name}" model cleared (inherits).  ${path}`,
      );
    } catch (err) {
      this.#notice(`Failed to set agent model: ${(err as Error).message}`, "error");
    }
  }

  /** Scaffold a new named-agent file and reload the roster. */
  async #createAgent(name: string): Promise<void> {
    const clean = name
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    if (!clean) {
      this.#notice("Usage: /agents new <name>", "warn");
      return;
    }
    try {
      const { path, created } = await scaffoldAgent(this.#cwd, clean);
      await this.#reloadAgents();
      this.#notice(
        created
          ? `Created agent "${clean}" — edit ${path} to customize its prompt/model/tools.`
          : `Agent "${clean}" already exists (${path}).`,
      );
    } catch (err) {
      this.#notice(`Failed to create agent: ${(err as Error).message}`, "error");
    }
  }

  #notice(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.#bus.emit({ type: "notice", level, message });
  }

  /** Persist a patch to the user-global config; surface a failure as a notice. */
  async #persistConfig(patch: Record<string, unknown>): Promise<void> {
    try {
      await writeGlobalConfig(patch);
    } catch (err) {
      this.#notice(`Couldn't save config to disk: ${(err as Error).message}`, "warn");
    }
  }

  /**
   * Build the delegation handle handed to the slash-command module
   * (`engine-commands.ts`). All private state stays here; the handle exposes
   * only the live accessors + operations those handlers touch (see EngineHandle).
   */
  #buildCommandHandle(): EngineHandle {
    const engine = this;
    return {
      get config() {
        return engine.#config;
      },
      get session() {
        return engine.#session;
      },
      get cwd() {
        return engine.#cwd;
      },
      get commands() {
        return engine.commands;
      },
      get skills() {
        return engine.skills;
      },
      get catalog() {
        return engine.catalog;
      },
      get toolset() {
        return engine.toolset;
      },
      get registry() {
        return engine.registry;
      },
      get agents() {
        return engine.#agents;
      },
      get memory() {
        return engine.#memory;
      },
      get checkpoints() {
        return engine.#checkpoints;
      },
      get store() {
        return engine.#store;
      },
      get sandbox() {
        return engine.#sandbox;
      },
      notice: (message, level) => engine.#notice(message, level),
      emit: (event) => engine.#bus.emit(event),
      send: (command) => engine.send(command),
      clearAlwaysAllow: () => engine.#alwaysAllow.clear(),
      persistConfig: (patch) => engine.#persistConfig(patch),
      handlePrompt: async (text, opts) => {
        await engine.#handlePrompt(text, opts);
      },
      resetTurnBudgets: () => engine.#resetPromptBudgets(),
      runVerifyCommand: (command) => engine.#runVerifyCommand(command),
      refreshProjectMemory: () => engine.#refreshProjectMemory(),
      createAgent: (name) => engine.#createAgent(name),
      handleLoop: (args) => engine.#handleLoop(args),
      listModels: () => engine.listModels(),
      resolveContextWindow: (model) => engine.#resolveContextWindow(model),
      resolvePricing: (model) => engine.#resolvePricing(model),
      mcpStatus: () => engine.#mcp.status(),
      lspStatus: () => engine.#diagnostics.status?.() ?? [],
      jobsStatus: () => engine.#jobs.snapshot(),
      git: (args) => engine.#git(args),
      goalRun: () => engine.#goalRunInfo(),
      pauseGoalRun: (reason, notice) => engine.#pauseGoalRun(reason, notice ? { notice } : {}),
    };
  }

  /** Lazily-built, cached command handle (built once, reused). */
  #getCommandHandle(): EngineHandle {
    return (this.#commandHandle ??= this.#buildCommandHandle());
  }

  /** Route a slash command through the slash-command module. */
  #handleSlash(name: string, args: string): Promise<void> {
    return handleSlash(this.#getCommandHandle(), name, args);
  }

  #handleLoop(args: string): void {
    if (args.trim() === "stop") {
      if (this.#loop) {
        // Sweep a tick that's already queued behind an active turn FIRST: the
        // controller's own stop() only aborts the in-flight `#loopSession`, so
        // without this the queued iteration would still run one full model
        // turn (side effects included) after the user said stop.
        const queued = this.#pending.filter((p) => p.origin === "loop");
        if (queued.length) {
          this.#pending = this.#pending.filter((p) => p.origin !== "loop");
          for (const p of queued) p.onCancel?.("loop stopped");
          this.#emitQueue();
        }
        this.#loop.stop();
        this.#loop = undefined;
      } else {
        this.#notice("No active loop.");
      }
      return;
    }
    if (this.#loop) {
      this.#notice("A loop is already running. Run /loop stop first.", "warn");
      return;
    }
    const parsed = parseLoopArgs(args, { defaultMax: this.#config.loop.defaultMax });
    if (!parsed) {
      this.#notice(
        "Usage: /loop [interval] <prompt|/command> [--until <condition>] [--max N] [--unlimited]\n" +
          "Defaults: /loop defaults · /loop default max 20 · /config loop default max unlimited",
        "warn",
      );
      return;
    }
    // Surface parse warnings (a mistyped flag/interval kept as prompt text)
    // BEFORE the "Loop started" notice — the user must see that a bound or
    // interval they typed was NOT applied while there's time to /loop stop.
    for (const w of parsed.warnings ?? []) this.#notice(w, "warn");
    const loop = new LoopController({
      id: createId("loop"),
      ...parsed,
      maxUntilEvalFailures: this.#config.loop.maxUntilEvalFailures,
      run: (p) => this.#runLoopIteration(p),
      ...(parsed.until
        ? { evaluate: (r: string, c: string) => this.#evaluateCondition(r, c) }
        : {}),
      onStop: () => this.#loopSession?.abort(),
      emit: (e) => this.#bus.emit(e),
    });
    this.#loop = loop;
    void loop.whenDone().then(() => {
      if (this.#loop === loop) this.#loop = undefined;
    });
    loop.start();
    const maxLabel = parsed.unlimited
      ? parsed.maxDefaulted
        ? "unlimited (default)"
        : "unlimited"
      : parsed.max != null
        ? `max ${parsed.max}${parsed.maxDefaulted ? " (default)" : ""}`
        : "unlimited";
    this.#notice(
      `Loop started (every ${Math.round(parsed.intervalMs / 1000)}s)` +
        (parsed.until ? `, until: ${parsed.until}` : "") +
        `, ${maxLabel}` +
        ". Run /loop stop to cancel.",
    );
  }

  /**
   * Append a unit of work to the queue and ensure the drainer is running.
   * Work runs strictly one at a time (FIFO) so history stays consistent; extra
   * prompts submitted while busy become a visible, cancelable backlog.
   */
  #enqueue(
    label: string,
    run: () => Promise<unknown>,
    opts: { onCancel?: (reason: string) => void; origin?: "goal" | "loop" } = {},
  ): void {
    this.#pending.push({
      id: createId("q"),
      label,
      run,
      ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    // Only surface the queue when something is actually waiting behind active
    // work; a lone item drains immediately and would otherwise just flicker.
    if (this.#draining) this.#emitQueue();
    void this.#drain();
  }

  /** Run queued work to completion, emitting queue state as it changes. */
  async #drain(): Promise<void> {
    if (this.#draining) return this.#drainPromise;
    this.#draining = true;
    this.#drainPromise = this.#runDrain();
    return this.#drainPromise;
  }

  async #runDrain(): Promise<void> {
    // Everything after this point runs inside try/finally: a throw from
    // #emitQueue, the idle-continue frame, or any non-item path must NOT leave
    // #draining stuck true (that would silently wedge every future #enqueue).
    // The finally clears the latch and fires the terminal engine-idle signal so
    // the invariant "engine-idle ALWAYS fires on every path" holds even on throw.
    try {
      // Outer loop: after the queue drains, the Stop-equivalent session.idle hook
      // may inject one more turn (bounded). When it enqueues work, re-drain; when
      // it declines (or the budget caps), fall through to the terminal signal so
      // engine-idle ALWAYS fires eventually on every path.
      do {
        do {
          while (this.#pending.length) {
            const item = this.#pending.shift()!;
            this.#active = { id: item.id, label: item.label };
            this.#emitQueue();
            try {
              await item.run();
            } catch (err) {
              this.#log.error("turn failed", err);
              this.#bus.emit({
                type: "engine-error",
                sessionId: this.#session.id,
                message: (err as Error).message,
              });
            }
          }
          this.#active = null;
          this.#emitQueue();
          // Yield a macrotask so subscribers flush their buffered events before we
          // report idle — callers awaiting whenIdle() then see a delivered stream.
          // (New work may also have been queued during this gap; the loop re-checks.)
          await new Promise((resolve) => setTimeout(resolve, 0));
        } while (this.#pending.length);
        // A prompt may have been enqueued DURING the session.idle hook's async
        // await (an HTTP/shell config hook, or any async in-process handler): the
        // inner loop already exited (it saw #pending empty before the idle
        // consultation started), so #enqueue's void #drain() was a no-op against
        // #draining still true, and a {continue:false} hook would strand the
        // queued item forever — the finally would clear #draining and emit
        // engine-idle with the prompt still sitting in #pending. Re-check #pending
        // AFTER the idle consultation: if items arrived during its await, loop back
        // and drain them instead of settling idle. The session.idle hook re-fires
        // on the next pass (correctly — the queue was never truly idle).
      } while ((await this.#maybeContinueOnIdle()) || this.#pending.length);
    } catch (err) {
      // A throw outside the per-item catch (e.g. a bus subscriber or session.idle
      // #onError callback) must not wedge the queue — log and fall through to the
      // finally so the latch clears and engine-idle still fires.
      this.#log.error("drain loop failed", err);
    } finally {
      this.#draining = false;
      this.#drainPromise = undefined;
      this.#active = null;
      // The queue is fully drained — the prompt AND every follow-up turn it spawned
      // (gate-fix / review-fix / verify-fix / idle-continue) are done. Signal the
      // true terminal point so a headless one-shot stops HERE, not on the first
      // per-turn `session-idle` (which would cut off follow-up output and race
      // finalize()).
      this.#bus.emit({
        type: "engine-idle",
        sessionId: this.#session.id,
        ...(this.#lastGateOutcome ? { gate: this.#lastGateOutcome } : {}),
      });
      for (const resolve of this.#idleResolvers.splice(0)) resolve();
    }
  }

  /**
   * Stop-equivalent idle consultation. Awaits the `session.idle` hook (fired on
   * every queue-drain, same as before — now it can also steer). A handler that
   * returns `{continue:true, reason?}` injects ONE synthetic follow-up turn built
   * from `reason`, routed through the SAME queue as a normal prompt so /loop,
   * abort, and persistence semantics hold; the drainer then re-drains. Returns
   * true to keep going, false to settle idle.
   *
   * HARD-BOUNDED by #idleContinueRounds (reset per real user prompt): once the
   * budget is spent, warn and settle regardless — a buggy always-continue hook
   * can never wedge the terminal engine-idle signal. A throwing hook is isolated
   * by the HookBus (no continue field) → returns false → idle settles.
   */
  async #maybeContinueOnIdle(): Promise<boolean> {
    if (this.#shutdownRequested) return false;
    // A user-aborted turn (Esc) or a cost-budget STOP must settle idle, never be
    // resurrected by a `session.idle {continue:true}` hook — mirrors the
    // !interrupted guards guarding the task-continuation path in #afterTurn.
    // (session.run resets #interrupted on the injected turn, so this guard must
    // read it BEFORE that turn is enqueued.) #userStop covers Esc after run()
    // returns (gate/review), which never latches session.interrupted.
    if (this.#session.interrupted || this.#userStop) return false;
    const result = await this.hooks.run("session.idle", { sessionId: this.#session.id });
    if (!result.continue) return false;
    if (this.#idleContinueRounds >= MAX_IDLE_CONTINUES) {
      this.#notice(
        `A session.idle hook keeps asking to continue, but the ${MAX_IDLE_CONTINUES}-turn ` +
          "budget for this prompt is exhausted — settling idle.",
        "warn",
      );
      return false;
    }
    this.#idleContinueRounds += 1;
    const reason = result.reason?.trim();
    const prompt = reason
      ? reason
      : "A session.idle hook requested another turn — continue the work you were doing.";
    this.#enqueue("session.idle continue", () => this.#handlePrompt(prompt));
    return true;
  }

  /** `opts.display` replaces the user-bubble text for engine-authored turns
   * (goal-run rounds show a compact `★ goal — …` line instead of repeating a
   * near-identical multi-line directive up to maxRounds times); the full text
   * still reaches the model untouched. */
  async #handlePrompt(
    text: string,
    opts: { handoff?: boolean; display?: string } = {},
  ): Promise<"denied" | undefined> {
    // A prompt hook can veto the turn outright — run it FIRST, on the raw incoming
    // text, BEFORE any handoff rewrite / plan-state mutation and BEFORE the
    // checkpoint snapshot. A deny must leave EVERYTHING untouched: a denied handoff
    // keeps the approved plan (#lastPlan + the persisted plan file) intact so a
    // later /execute still works, and a denied normal prompt seeds NO no-op
    // checkpoint. The hook rewrites the raw text; the handoff directive below is
    // then built around the (possibly rewritten) text exactly as before.
    const hooked = await this.hooks.run("user.prompt.submit", { text });
    if (hooked.deny) {
      this.#notice("Prompt blocked by a user.prompt.submit hook.", "warn");
      // A DEFERRED plan handoff was consumed off #pendingHandoff at enqueue and
      // bound to this job (see submit-prompt). A deny here would otherwise lose
      // the approval entirely — #lastPlan was already spent at approval time, so
      // only a full --resume could resurrect it. Re-arm the flag (as the doc
      // comment above promises) so the user's next message retries the handoff.
      if (opts.handoff) {
        this.#pendingHandoff = true;
        void this.#persistEngineState();
        this.#notice("Plan approval preserved — your next message will retry the handoff.", "info");
      }
      // Callers that must know no turn ran (the goal run's closures — a vetoed
      // turn would otherwise leave the run armed with nothing queued and skip
      // no state) read this; the void-returning paths ignore it.
      return "denied";
    }
    text = hooked.text;
    // Plan→execute handoff: prepend an explicit approval directive so the model
    // doesn't read its own present_plan "stop here" as an instruction to halt. This
    // directive is internal — the model needs it, but it must NOT render as a user
    // message (the user approved via the plan card, they didn't "type" this). So we
    // send it with `display: null` (no user bubble) and show a clean notice instead.
    // The flag is passed in (bound to this specific job at enqueue time) rather
    // than read from shared state, so a queued prompt can't consume another
    // turn's handoff.
    const isHandoff = opts.handoff ?? false;
    if (isHandoff) {
      // Arm the plan-execution completion check (see #maybeContinueTasks):
      // from here until the next real user prompt, unfinished seeded tasks at
      // turn end re-enqueue bounded continuation turns instead of stopping.
      this.#planExecutionActive = true;
      this.#lastPlan = undefined;
      // Consume the persisted plan too, so --resume can't resurrect an
      // already-executed plan and re-fire its handoff (the plan file otherwise
      // repopulates #lastPlan on restore, re-arming a spent approval).
      void this.#discardPersistedPlan();
      const taskContract = this.#taskContractText();
      text =
        "The plan you presented was approved by the user — proceed with implementing it " +
        `now (your earlier "stop here" no longer applies).${taskContract}${text.trim() ? `\n\n${text}` : ""}`;
      this.#notice("Executing the approved plan…");
    }
    // Snapshot the workspace before an edit turn so /undo can roll it back — and
    // remember its id as the base the diff reviewer diffs THIS turn against.
    this.#turnCheckpointId = undefined;
    if (this.#config.checkpoints.enabled && this.#session.mode === "execute") {
      // Capture the conversation length too, so /undo can rewind history to
      // before this turn (otherwise the model still "remembers" undone edits).
      const cp = await this.#checkpoints.snapshot(
        queueLabel(text),
        this.#session.conversationMark(),
      );
      if (cp) {
        this.#turnCheckpointId = cp.id;
        // The FIRST checkpointed turn of a user prompt sets the diff-review
        // baseline; subsequent internal fix turns keep it, so the review sees the
        // cumulative red→fix→green change, not just the last fix turn's diff.
        if (this.#promptBaselineId === undefined) this.#promptBaselineId = cp.id;
        this.#bus.emit({ type: "checkpoint-created", id: cp.id, label: cp.label });
      }
    }
    // Proactive recall (default-on, opt-out): once per session, seed a "relevant past context"
    // block from long-term memory using the first prompt + goal, injected into
    // the system prompt. Best-effort — a failure must not block the turn.
    await this.#maybeProactiveRecall(text);
    // Determine vision relay active status ONCE (session-stable). The system
    // prompt must be byte-stable across turns, so this is set before the first
    // session.run — the VISION RELAY section rides in the system prompt from
    // the very first turn, telling the model to use relay descriptions instead
    // of trying to read image files with tools.
    if (!this.#visionRelayDetermined) {
      this.#visionRelayDetermined = true;
      const relayConfig = this.#config.vision.relay;
      if (relayConfig.enabled && relayConfig.relayModel) {
        await this.catalog.ensureLoaded();
        const ok = await this.#supportsImages(this.#session.model);
        this.#session.visionRelayActive = ok === false;
      }
    }
    // Expand `@file` mentions: text files become context blocks, images become
    // attachments for vision models. Unresolvable mentions pass through.
    const expanded = await expandMentions(text, this.#cwd);
    for (const note of expanded.notices) this.#notice(note, "info");
    // Vision relay: when the primary model does NOT support image input and a
    // relay model is configured, caption each image via the relay and inject the
    // text descriptions into the prompt — the primary model "sees" through the
    // relay. When the primary model DOES support images (or the relay is off),
    // images pass through unchanged.
    let relayedText = expanded.text;
    let relayedImages: ImageAttachment[] = expanded.images;
    if (expanded.images.length) {
      let ok = await this.#supportsImages(this.#session.model);
      const relayConfig = this.#config.vision.relay;
      // When the relay is enabled but the catalog hasn't loaded yet (first
      // prompt of a new session), supportsImages returns undefined and
      // shouldRelay returns false — the relay would silently not fire.
      // Await the catalog and retry so the relay works from the very first
      // prompt. Subsequent calls are instant (#metadata is populated).
      if (ok === undefined && relayConfig.enabled && relayConfig.relayModel) {
        await this.catalog.ensureLoaded();
        ok = await this.#supportsImages(this.#session.model);
      }
      if (shouldRelay(relayConfig, expanded.images.length > 0, ok)) {
        // The relay runs here — before session.run — so the captioned text lands
        // in the user message the primary model actually sees. Images are
        // replaced by their text descriptions; the raw bytes never reach the
        // primary model.
        this.#notice(
          `Vision relay: captioning ${expanded.images.length} image${expanded.images.length === 1 ? "" : "s"} via ${relayConfig.relayModel} (primary model ${this.#session.model} does not support image input).`,
          "info",
        );
        const result = await captionImages(
          expanded.images,
          relayConfig,
          () => this.registry.resolveModel(relayConfig.relayModel!, this.#config),
          this.#session.abortSignal,
          this.#log,
        );
        const block = captionsToContextBlock(result.captions);
        relayedText = block ? `${expanded.text}\n\n${block}` : expanded.text;
        relayedImages = []; // primary model gets text, not bytes
        if (result.allSucceeded) {
          this.#notice(`Vision relay: all ${result.captions.length} image(s) captioned successfully.`, "info");
        } else {
          const degraded = result.captions.filter((c) => c.degraded).length;
          this.#notice(
            `Vision relay: ${result.captions.length - degraded} captioned, ${degraded} degraded (see context for details).`,
            "warn",
          );
        }
      } else if (ok === false) {
        this.#notice(`${this.#session.model} may not accept image input; sending anyway.`, "warn");
      }
    }
    await this.#session.run(
      relayedText,
      relayedImages,
      isHandoff ? { display: null } : opts.display !== undefined ? { display: opts.display } : {},
    );
    await this.#afterTurn();
    // The turn may have touched the working tree — refresh the header's git state.
    void this.#emitGit();
  }

  /**
   * Post-turn verification dispatch (same call site + gating as the old
   * `#maybeVerify`). The engine-owned GREEN-GATE is the primary path: when build
   * intelligence is on and the recon profile has runnable check commands, run
   * the repo's REAL checks, then commit-on-green + adversarially review the diff.
   * With build/gate disabled — or when no trustworthy check command exists — it
   * falls back to the legacy `verify.command`/`verify.auto` loop verbatim, and
   * only surfaces the "not machine-verified" honesty notice when NOTHING checked
   * the work (never silently green).
   */
  async #afterTurn(): Promise<void> {
    // Esc (or a durable user-stop) after the model turn must not re-arm chains.
    if (this.#userStop || this.#session.interrupted) return;

    const build = this.#config.build;
    if (!(build.enabled && build.gate.enabled)) {
      // Build intelligence off (or gate disabled): legacy verify behavior.
      const wasGateable = this.#turnIsGateable();
      const verify = await this.#maybeVerify();
      // This pass considered the turn for verification — consume sticky dirt.
      // Leave it set when not gateable so a later execute turn still verifies
      // detached edits (e.g. dirt arrived while we were in plan mode).
      if (wasGateable) this.#session.clearBackgroundDirty();
      // A verify-fix is already queued (or verify exhausted red) — don't also
      // advance plan/goal chains; the fix turn re-enters #afterTurn when done.
      if (verify.fixEnqueued || this.#fixPending) return;
      if (verify.exhaustedFail) {
        if (this.#lastGateOutcome !== "red") this.#lastGateOutcome = "red";
      }
      if (!this.#session.interrupted && !this.#userStop) {
        this.#maybeNudgePresentPlan();
        this.#maybeContinueTasks(false);
      }
      await this.#maybeContinueGoal();
      return;
    }
    // The gate runs on the same terms the legacy verify did: only after a
    // mutating execute turn the user didn't interrupt. Loop iterations route
    // through #handlePrompt too, so a mutating loop tick is verified the same
    // way as a typed prompt. backgroundDirty covers detached children that
    // mutated after the spawn turn already finished.
    if (!this.#turnIsGateable()) {
      // A plan-execution turn that produced no edit (the model narrated or asked
      // instead of working) must not silently strand the chain — nudge the
      // unfinished tasks. Skip when the user interrupted (Esc means stop), and
      // #maybeContinueTasks no-ops outside an active plan chain.
      if (!this.#session.interrupted && !this.#userStop) {
        this.#maybeNudgePresentPlan();
        this.#maybeContinueTasks(false);
      }
      await this.#maybeContinueGoal();
      return;
    }
    // About to gate — sticky background dirt has been honored for this pass.
    this.#session.clearBackgroundDirty();

    let profile = this.#session.repoProfile;
    let runnable = profile ? pickChecks(profile, build.gate.checks) : [];
    // The recon profile is captured at session start — a turn that just
    // SCAFFOLDED a project (create-next-app in an empty dir) leaves it stale
    // with no runnable checks, which used to make the gate silently no-op for
    // the rest of the session ("Gate: UNVERIFIED" while `next build` was
    // sitting right there, red). A mutating turn with no runnable checks is
    // exactly that signature, so re-derive the profile before giving up.
    if (!runnable.length) {
      // Only re-scan when a build manifest actually changed since the last empty
      // refresh — otherwise a repo that genuinely has no checks would re-run full
      // recon (+ repo-map) on every mutating turn. A scaffolding turn writes a
      // manifest (package.json, Cargo.toml, …), flipping the signature.
      const sig = manifestSignature(this.#cwd);
      if (sig !== this.#lastGateReconSig) {
        this.#lastGateReconSig = sig;
        await this.#runRecon();
        profile = this.#session.repoProfile;
        runnable = profile ? pickChecks(profile, build.gate.checks) : [];
      }
    }
    let outcome: GateSummary["outcome"] | "skipped" = "skipped";
    if (!profile || !runnable.length) {
      // No trustworthy check command for the gate. Fall back to a configured
      // legacy verify command if one exists (recon fills verify.command); only
      // when NOTHING machine-verified the work do we say so — never silently green.
      const verify = await this.#maybeVerify();
      if (verify.fixEnqueued || this.#fixPending) return;
      if (verify.exhaustedFail) {
        if (this.#lastGateOutcome !== "red") this.#lastGateOutcome = "red";
      } else if (!verify.ran || !verify.ok) {
        // Don't let a later UNVERIFIED turn MASK an earlier RED within the same
        // prompt (e.g. a fix turn that deletes the build script): a red build must
        // keep reporting red at engine-idle so headless/CI still exits non-zero.
        // A genuine red→green fix DOES overwrite (handled in the gate branch).
        if (this.#lastGateOutcome !== "red") this.#lastGateOutcome = "unverified";
        if (!verify.ran) {
          this.#notice(
            "Gate: UNVERIFIED — no build/test/typecheck command was detected (even after re-scanning), " +
              "so this turn's work was not machine-verified. Adding a build or test script to the " +
              "project manifest makes future turns verifiable.",
            "info",
          );
        }
      }
    } else {
      outcome = await this.#runGate(profile);
      // Record the verdict (green/red/unverified/aborted) as the prompt's latest
      // gate state — the terminal one after fix rounds is what engine-idle reports.
      this.#lastGateOutcome = outcome;
    }
    // RED already enqueued its own fix turn; aborted = user interrupt; a dirty
    // review / verify-fix leaves #fixPending set — all skip task/goal continue
    // so the fix turn's own #afterTurn re-runs both (no double-fire, no premature
    // goal-met alongside an unfixed review).
    if (outcome === "red" || outcome === "aborted" || this.#fixPending) return;
    if (this.#userStop || this.#session.interrupted) return;
    this.#maybeContinueTasks(outcome === "green");
    await this.#maybeContinueGoal();
  }

  /**
   * Hard plan-presentation contract: a non-trivial plan cycle (web/versions/code
   * triage) that ends without a successful present_plan never arms the approval
   * card — free-form chat plans are soft and models often announce "next I'll
   * start…". One bounded engine follow-up forces present_plan; after that we
   * stop nagging (weak models that can't drive the tool still won't loop).
   */
  #maybeNudgePresentPlan(): void {
    if (this.#session.mode !== "plan") {
      this.#planPresentNudgeRounds = 0;
      return;
    }
    if (this.#userStop || this.#session.interrupted) return;
    if (!this.#session.needsPresentPlan) {
      // Presented (or trivial) — clear so a later revision cycle can nudge again.
      this.#planPresentNudgeRounds = 0;
      return;
    }
    if (this.#planPresentNudgeRounds >= MAX_PLAN_PRESENT_NUDGES) return;
    this.#planPresentNudgeRounds += 1;
    const prompt =
      "You researched or drafted a multi-step plan but never called present_plan — " +
      "free-form chat does not open the approval card. " +
      "Call present_plan NOW with a concrete `- [ ]` checklist, verification, " +
      "and harvested sources (when the request needed web/version research). " +
      'Do NOT implement, load skill init/setup workflows, or announce "next steps" work. ' +
      "After present_plan succeeds, STOP and wait for the user to approve.";
    this.#enqueue("present plan", () => this.#handlePrompt(prompt));
  }

  /**
   * Plan-execution completion check: after a turn, unfinished seeded tasks mean
   * the approved plan is NOT done — the turn ending is not the work ending. Any
   * unfinished task (pending OR in_progress) re-enqueues a bounded continuation
   * naming the unfinished ids. It does NOT auto-complete in_progress stragglers
   * on a green gate: greenness proves the build/tests pass, which is orthogonal
   * to whether a given task's own work was actually done — a model that set a
   * task in_progress and stopped early on an unrelated-green tree would be
   * falsely reported done. The continuation instead asks the model to finish the
   * task or mark it complete if it truly already is. Scoped to plan-execution
   * chains (armed by the handoff, cleared by the next real user prompt) so an
   * unrelated request never gets nagged about a stale list.
   */
  #maybeContinueTasks(_green: boolean): void {
    if (!this.#planExecutionActive) return;
    if (this.#userStop || this.#session.interrupted) return;
    if (this.#session.mode === "plan") {
      // Read-only plan can't finish mutating work — disarm rather than burn
      // continuation rounds on impossible turns.
      this.#planExecutionActive = false;
      return;
    }
    const tasks = this.#session.tasks;
    if (!tasks.length) {
      // Empty list = nothing to drive; clear so goal assessment isn't blocked.
      this.#planExecutionActive = false;
      return;
    }
    const unfinished = tasks
      .map((t, i) => ({ ref: `t${i + 1}`, index: i + 1, title: t.title, status: t.status }))
      .filter((t) => t.status !== "completed");
    if (!unfinished.length) {
      this.#planExecutionActive = false;
      return;
    }
    // During a goal run, task continuations charge the run's UNIFIED budget
    // (#goalContinueRounds vs goal.maxRounds) — two stacked budgets would let a
    // 25-round ceiling balloon to ~25×gate.maxRounds turns. The `goal: ` label
    // keeps them coverable by the goal sweep and the queued-goal-turn guard.
    const inGoalRun = this.#goalRunActive;
    const max = inGoalRun ? this.#config.goal.maxRounds : this.#config.build.gate.maxRounds;
    const rounds = inGoalRun ? this.#goalContinueRounds : this.#taskContinueRounds;
    if (rounds >= max) {
      this.#planExecutionActive = false;
      // In a goal run the warn is the goal loop's job: #maybeContinueGoal runs
      // next in the same #afterTurn, sees the same exhausted counter, and emits
      // its round-exhaust warn — a second one here would double-report.
      if (!inGoalRun) {
        this.#notice(
          `Plan tasks still unfinished after ${max} continuation round${max === 1 ? "" : "s"} — ` +
            `needs your attention: ${unfinished.map((t) => t.ref).join(", ")}.`,
          "warn",
        );
      }
      return;
    }
    if (inGoalRun) {
      this.#goalContinueRounds += 1;
      void this.#persistEngineState();
      this.#emitGoalRun();
      this.#notice(
        `Goal round ${this.#goalContinueRounds}/${max} — unfinished tasks: ` +
          `${unfinished.map((t) => t.ref).join(", ")}.`,
      );
    } else {
      this.#taskContinueRounds += 1;
    }
    const list = unfinished.map((t) => `${t.ref} (${t.status}): ${t.title}`).join("\n");
    const display = inGoalRun
      ? `★ goal — round ${this.#goalContinueRounds}/${max}: unfinished tasks ${unfinished.map((t) => t.ref).join(", ")}`
      : undefined;
    const continuePrompt =
      `The approved plan is not finished — these tasks remain:\n${list}\n` +
      "For each: if it is already fully done, mark it completed now " +
      '(update_tasks({updates:[{id:"t<N>",status:"completed"}]})); otherwise finish it, ' +
      "marking it in_progress when you start and completed the moment you verify it. " +
      "Do not stop until every task is completed and the project's checks pass.";
    this.#enqueue(
      inGoalRun ? "goal: continue tasks" : "continue plan tasks",
      () => {
        // A goal-run task round is a fresh prompt-sized unit of work (same as
        // goal continuations): fresh gate/review budgets, then re-arm the chain
        // the reset just disarmed. Non-goal plan chains keep the legacy shared
        // budget (bounded by gate.maxRounds inside one user prompt).
        if (inGoalRun) {
          this.#resetPromptBudgets();
          this.#planExecutionActive = true;
          return this.#runGoalTurn(continuePrompt, display ?? "★ goal — continuing tasks");
        }
        return this.#handlePrompt(continuePrompt);
      },
      inGoalRun ? { origin: "goal" } : {},
    );
  }

  /** The seeded-task update contract, shared verbatim by the plan→execute
   * handoff and the goal run's execute turn so the two can't drift. Empty when
   * no tasks are seeded. */
  #taskContractText(): string {
    const tasks = this.#session.tasks;
    return tasks.length
      ? `\nIt was seeded as this task list:\n${tasks.map((t, i) => `t${i + 1} ${t.title}`).join("\n")}\n` +
          'Before starting each task call update_tasks({updates:[{id:"t<N>",status:"in_progress"}]}), and mark it ' +
          "completed the moment you verify it — exactly one task in_progress at a time. Do not stop until every " +
          "task is completed and the project's checks pass."
      : "";
  }

  /** Arm a `/goal` autonomous run and enqueue its first turn. Routing through
   * #handlePrompt (not a bespoke runner) buys everything a typed prompt gets
   * for free: the `user-message` event that flips the TUI to the working view,
   * checkpoints, the green-gate, diff review, and #afterTurn — where
   * #maybeContinueGoal keeps the run going.
   *
   * Default pipeline (goal.planFirst): a dedicated read-only PLAN turn that
   * investigates and seeds the task list, then #beginGoalExecution launches the
   * task-contract EXECUTE turn. planFirst:false keeps the legacy single blended
   * drive turn. */
  #startGoalRun(goal: string): void {
    // Replacing a live run: nothing queued for the OLD goal may survive — a
    // stale continuation would run a full turn steering toward the replaced
    // goal (its prompt bakes the old text in) and interleave two drivers.
    this.#sweepQueuedGoalTurns("goal replaced");
    this.#ensureExecuteModeForGoal();
    // Discard any leftover presented plan: a stale card accepted mid-run would
    // pass the #resolvePlan guard, re-seed the task spine the run owns, and
    // interleave a second "execute plan" driver. The run seeds its own tasks.
    this.#lastPlan = undefined;
    // The run owns the task spine. A leftover list (an earlier plan's tasks)
    // would otherwise read as "the plan turn seeded these" in
    // #beginGoalExecution and hijack the contract — and its unfinished rows
    // would drive deterministic not-met rounds toward abandoned work.
    if (this.#session.tasks.length) {
      this.#session.setTasks([]);
      this.#notice(
        "Cleared the pre-existing task list — the goal run seeds and owns its own.",
        "info",
      );
    }
    this.#goalRunActive = true;
    this.#goalRunEpoch += 1;
    this.#goalMet = false;
    this.#goalPauseReason = undefined;
    this.#goalContinueRounds = 0;
    this.#goalCleanPasses = 0;
    const planFirst = this.#config.goal.planFirst;
    this.#goalPhase = planFirst ? "plan" : undefined;
    this.#resetPromptBudgets();
    void this.#persistEngineState();
    this.#emitGoalRun();
    this.#notice(
      `Goal set: ${goal}\nStarting an autonomous run — ` +
        (planFirst ? "plan first, then execute the plan task by task, " : "the agent works, ") +
        "self-assessing and continuing until the goal is verified met. " +
        "/goal clear (or Esc) stops it; typing steers it.",
    );
    if (planFirst) {
      this.#enqueueGoalPlanTurn(goal);
    } else {
      this.#enqueue(
        `goal: ${queueLabel(goal)}`,
        () => this.#runGoalTurn(this.#goalDrivePrompt(goal), `★ goal — working: ${goal}`),
        { origin: "goal" },
      );
    }
  }

  /** A goal run must run in EXECUTE mode — plan-mode turns are read-only and
   * could never accomplish a mutating goal. Flip directly via #setModeGated
   * (NOT send({type:"set-mode"}): its approvingPlan branch would silently
   * approve a lingering presented plan). Preserve YOLO the same way
   * #approvePlan does: capture before the gate reset, restore after. */
  #ensureExecuteModeForGoal(): void {
    if (this.#session.mode !== "plan") return;
    const wantAuto = this.#config.approvalMode === "auto";
    this.#setModeGated("execute");
    if (wantAuto) handleApprovals(this.#getCommandHandle(), "auto", true);
    this.#notice("Goal run requires execute mode — switched.");
  }

  /** Run an engine-internal fix turn (gate-fix / review-fix / verify-fix). A
   * hook-denied fix turn never reaches #afterTurn — during a goal run that
   * would strand the run armed with nothing queued, so the deny pauses it
   * (a no-op outside a run). */
  async #runFixTurn(text: string): Promise<void> {
    const result = await this.#handlePrompt(text);
    if (result === "denied") {
      this.#pauseGoalRun("a prompt hook blocked the fix turn", { level: "warn" });
    }
  }

  /** Run one goal-run turn with the full stop-invariant guard: a turn VETOED
   * by a user.prompt.submit hook (no turn ran, no #afterTurn — the run would
   * sit armed with nothing queued) or a turn that THREW (the drain only logs
   * it) both pause the run instead of wedging it. Every goal closure that
   * sends a prompt routes through here. */
  async #runGoalTurn(text: string, display: string): Promise<"denied" | undefined> {
    let result: "denied" | undefined;
    try {
      result = await this.#handlePrompt(text, { display });
    } catch (err) {
      // The throw can come from anywhere in the turn pipeline (pre-run prep OR
      // #afterTurn — e.g. a gate crash), so the reason stays non-committal.
      this.#pauseGoalRun("the turn failed", { level: "warn" });
      throw err;
    }
    if (result === "denied") {
      this.#pauseGoalRun("a prompt hook blocked the turn", { level: "warn" });
    }
    return result;
  }

  /** Enqueue the read-only PLAN turn. #runGoalTurn carries the stop-invariant
   * guard (thrown or hook-denied turns pause the run instead of leaving it
   * armed with nothing queued — a denied plan turn must ALSO not march into
   * the execute phase on a fabricated task spine). Shared by #startGoalRun,
   * the bootstrap resume, and `/goal resume`, so no entry path can wedge the
   * run permanently in the plan phase. */
  #enqueueGoalPlanTurn(goal: string): void {
    this.#enqueue(
      `goal: plan ${queueLabel(goal)}`,
      async () => {
        const result = await this.#runGoalTurn(
          this.#goalPlanPrompt(goal),
          `★ goal — planning: ${goal}`,
        );
        if (result !== "denied") this.#beginGoalExecution(goal);
      },
      { origin: "goal" },
    );
  }

  /** Re-arm a paused run with the stored goal: fresh round budget, re-entering
   * at the phase it paused in (a lost task spine demotes execute back to plan
   * — e.g. after /clear wiped the list, re-planning is the only honest entry). */
  #resumeGoalRun(goal: string): void {
    this.#ensureExecuteModeForGoal();
    // Consume the stale stop signals a pause left behind — the interrupted /
    // lastError guards in #maybeContinueGoal would otherwise re-pause the
    // re-armed run before its first turn (the Esc/error already DID its job:
    // it paused the run the user is now explicitly resuming).
    this.#session.acknowledgeStop();
    this.#goalRunActive = true;
    this.#goalRunEpoch += 1;
    this.#goalMet = false;
    this.#goalPauseReason = undefined;
    this.#goalContinueRounds = 0;
    this.#goalCleanPasses = 0;
    if (this.#config.goal.planFirst) {
      if (this.#goalPhase === undefined)
        this.#goalPhase = this.#session.tasks.length ? "execute" : "plan";
      else if (this.#goalPhase === "execute" && !this.#session.tasks.length)
        this.#goalPhase = "plan";
    }
    // Re-entering PLAN with a leftover partial seed (an Esc landed mid-plan-turn
    // after some update_tasks calls): clear it — #beginGoalExecution reads any
    // non-empty list as "the re-plan seeded this" and would skip the fallback,
    // executing the interrupted plan's fragment as the spine.
    if (this.#goalPhase === "plan" && this.#session.tasks.length) this.#session.setTasks([]);
    this.#resetPromptBudgets();
    void this.#persistEngineState();
    this.#emitGoalRun();
    this.#notice(
      `Goal run resumed (${this.#goalPhase === "plan" ? "re-planning" : "continuing"}, fresh round budget): ${goal}`,
    );
    if (this.#goalPhase === "plan") this.#enqueueGoalPlanTurn(goal);
    else this.#enqueue("goal: resume", () => this.#maybeContinueGoal(), { origin: "goal" });
  }

  /** The live goal-run state, as a FRESH copy per call (bus subscribers and the
   * snapshot must never share a mutable reference). */
  #goalRunInfo(): GoalRunInfo {
    return {
      active: this.#goalRunActive,
      phase: this.#goalPhase ?? null,
      round: this.#goalContinueRounds,
      max: this.#config.goal.maxRounds,
      pausedReason: this.#goalPauseReason ?? null,
      met: this.#goalMet,
    };
  }

  #emitGoalRun(): void {
    this.#bus.emit({ type: "goal-run", sessionId: this.#session.id, run: this.#goalRunInfo() });
  }

  /** Pause a live run (the ★ goal stays set; `/goal resume` re-arms it): disarm
   * + persist the disarm (a kill-then---resume must not resurrect it), sweep
   * queued run turns, record why, and tell the user. Every non-terminal way a
   * run stops flows through here so no path can leave the run armed-but-idle
   * or disarmed-but-silent. */
  #pauseGoalRun(reason: string, opts: { notice?: string; level?: "info" | "warn" } = {}): void {
    if (!this.#goalRunActive) return;
    this.#goalRunActive = false;
    this.#goalRunEpoch += 1;
    this.#goalPauseReason = reason;
    void this.#persistEngineState();
    this.#sweepQueuedGoalTurns(`goal run paused — ${reason}`);
    this.#emitGoalRun();
    this.#notice(
      opts.notice ??
        `Goal run paused — ${reason}. The ★ goal stays set: /goal resume re-arms it, /goal clear drops it.`,
      opts.level ?? "info",
    );
  }

  /** PLAN→EXECUTE seam: verify the plan turn actually seeded tasks (fall back
   * to parsing its text, then to a single goal-titled task), then launch the
   * execute turn under the shared task contract with plan-execution
   * continuation armed — #maybeContinueTasks drives the list to completion and
   * #maybeContinueGoal stays the outer verifier. */
  #beginGoalExecution(goal: string): void {
    // Esc mid-plan (abort case) or an errored plan turn (lastError branch in
    // #maybeContinueGoal, which ran inside the plan turn's #afterTurn) already
    // disarmed the run — nothing to launch.
    if (!this.#goalRunActive) return;
    if (!this.#session.tasks.length) {
      // The model narrated a plan without calling update_tasks — seed from its
      // text (same checklist/numbered parser as plan approval), or track the
      // whole goal as one task so the execute loop always has a spine.
      this.#seedTasksFromPlan(this.#session.lastAssistantText());
      if (!this.#session.tasks.length) {
        this.#session.setTasks([{ title: goal, status: "pending" }]);
        this.#notice(
          "Plan turn produced no checklist — tracking the goal as a single task.",
          "info",
        );
      }
    }
    this.#goalPhase = "execute";
    void this.#persistEngineState();
    this.#emitGoalRun();
    this.#enqueue(
      `goal: execute ${queueLabel(goal)}`,
      () => {
        this.#resetPromptBudgets();
        // Arm task-driven continuation for THIS chain (reset just cleared it).
        // Deliberately NOT opts.handoff — that path consumes #lastPlan and
        // deletes the persisted plan file, which would destroy a user's real
        // pending plan.
        this.#planExecutionActive = true;
        return this.#runGoalTurn(
          this.#goalExecutePrompt(goal),
          `★ goal — executing the plan (${this.#session.tasks.length} tasks)`,
        );
      },
      { origin: "goal" },
    );
  }

  /** Sweep queued `goal:` continuation turns so nothing runs after a stop
   * (mirrors the /loop-stop sweep — a queued item would otherwise still execute
   * one full model turn). A steer can leave a continuation queued behind it, so
   * every path that ends a run must sweep, not just /goal clear. */
  #sweepQueuedGoalTurns(reason: string): void {
    const queued = this.#pending.filter((p) => p.origin === "goal");
    if (!queued.length) return;
    this.#pending = this.#pending.filter((p) => p.origin !== "goal");
    for (const p of queued) p.onCancel?.(reason);
    this.#emitQueue();
  }

  /** Stop a goal run for good (the goal itself is being dropped): disarm and
   * forget phase/pause/met state, and sweep queued continuations. */
  #stopGoalRun(reason: string): void {
    const was = this.#goalRunActive;
    this.#goalRunActive = false;
    this.#goalRunEpoch += 1;
    this.#goalPhase = undefined;
    this.#goalPauseReason = undefined;
    this.#goalMet = false;
    void this.#persistEngineState();
    this.#sweepQueuedGoalTurns(reason);
    this.#emitGoalRun();
    if (reason === "cleared by user")
      this.#notice(was ? "Goal cleared — run stopped." : "Goal cleared.");
    else if (was) this.#notice(`Goal run stopped — ${reason}.`);
  }

  /** The PLAN turn directive: investigate, produce a checklist, seed tasks —
   * and explicitly do not implement. A turn that stays read-only never trips
   * `session.didMutate`, so it skips the gate exactly like a plan-mode turn
   * would — read-only discipline by prompt, without plan mode's approval
   * card / gate-rejection / approvals-reset seams (hostile to autonomy). The
   * `- [ ]` format is mandated so #seedTasksFromPlan can parse the text as a
   * fallback when the model narrates instead of calling update_tasks. */
  #goalPlanPrompt(goal: string): string {
    return (
      `Your north-star goal is: ${goal}\n\n` +
      "This turn is PLANNING ONLY — thorough investigation, zero implementation.\n" +
      "1. INVESTIGATE: read the relevant files (several, not one), search for existing patterns, " +
      "and ground every step in what the code actually does. For stack/version choices use " +
      "package_info; for external facts use web_search + webfetch of authoritative pages. Never guess.\n" +
      "2. SUCCESS CRITERIA: list 3–7 checkable criteria the goal is met only when ALL are true " +
      "(commands that must pass, behaviors that must exist, files that must change, anti-slop: " +
      "no stubs/placeholders/TODO left in touched code).\n" +
      "3. PLAN: produce a complete step-by-step markdown checklist (`- [ ] step`) covering the " +
      "goal end to end — concrete files/areas per step, key decisions with one-line rationales, " +
      "and explicit verification steps (typecheck/tests/lint/manual). Seed it via update_tasks.\n" +
      "4. Do NOT modify any files, run mutating commands, or start implementing in this turn."
    );
  }

  /** The EXECUTE turn directive: drive the seeded task list to completion
   * under the same contract the plan→execute handoff uses. */
  #goalExecutePrompt(goal: string): string {
    return (
      `The plan for your north-star goal ("${goal}") is seeded as the task list — execute it now, ` +
      `end to end.${this.#taskContractText()}\n` +
      "Quality bar (anti-slop):\n" +
      "- Match existing project style, naming, and libraries — no speculative abstractions or drive-by refactors.\n" +
      '- No stubs, placeholders, fake handlers, TODO/FIXME left in code you touched, or "implement later" gaps.\n' +
      "- Mark a task completed only after you verified it (run checks or inspect the real result) — never on intent alone.\n" +
      "- Keep typecheck/tests/lint green; re-run after changes. Be exhaustive on edge cases; do not stop while any " +
      "part of the goal or success criteria is unmet."
    );
  }

  /** The legacy single-turn directive (goal.planFirst: false): plan and execute
   * in one blended turn, task list as the visible spine. */
  #goalDrivePrompt(goal: string): string {
    return (
      `Your north-star goal is: ${goal}\n\n` +
      "Treat this as a complete engagement, not a single answer. Plan the work first (investigate real " +
      "code, list 3–7 checkable success criteria, seed a `- [ ]` task list via update_tasks), then " +
      "execute end to end — mark each task in_progress when you start it and completed only when " +
      "verified. Anti-slop: match project style, no stubs/placeholders/TODO in touched code, keep " +
      "checks green, no drive-by refactors. Do not stop while any part of the goal is unmet."
    );
  }

  /**
   * Goal-run completion check, called from every #afterTurn exit that isn't a
   * red-gate fix cycle. Self-assesses the goal with a cheap structured call and
   * either re-enqueues a bounded continuation naming the gaps, or — once the
   * model claims "met" — spends one dedicated adversarial verify turn and only
   * finishes after MAX_GOAL_CLEAN_PASSES consecutive clean assessments. Skipped
   * while a plan-execution chain is mid-flight (one continuation driver at a
   * time; the chain's own #afterTurn re-runs this when it settles) and after an
   * interrupt (Esc means stop — never resurrect).
   */
  async #maybeContinueGoal(): Promise<void> {
    if (!this.#goalRunActive) return;
    if (this.#planExecutionActive) return;
    if (this.#fixPending) return;
    if (this.#session.interrupted || this.#userStop) return;
    // A turn that ERRORED (provider down, missing key) must pause the run, not
    // burn the round budget on doomed retries — session.run swallows the error
    // into lastError and returns normally, so #afterTurn still lands here.
    if (this.#session.lastError) {
      this.#pauseGoalRun("the last turn errored", {
        notice:
          "Goal run paused — the last turn errored. The ★ goal stays set; fix the provider, then " +
          "/goal resume to re-arm it.",
        level: "warn",
      });
      return;
    }
    // The PLAN turn's own #afterTurn must not assess — #beginGoalExecution runs
    // right after it and launches the execute phase. (An ERRORED plan turn is
    // caught by the lastError branch just above — one pause path for both.)
    if (this.#goalPhase === "plan") return;
    const goal = this.#session.goal;
    if (!goal) {
      // The goal vanished under a live run (nothing routes here today — clears
      // go through #stopGoalRun — but a future setGoal(null) caller must not
      // leave the run armed): full disarm, persisted and swept like any stop.
      this.#goalRunActive = false;
      this.#goalRunEpoch += 1;
      this.#goalPhase = undefined;
      void this.#persistEngineState();
      this.#sweepQueuedGoalTurns("goal cleared");
      this.#emitGoalRun();
      return;
    }
    // A goal turn is already waiting (a steered prompt ran between an earlier
    // continuation's enqueue and its drain) — don't stack another; the queued
    // turn re-enters this check when it finishes.
    if (this.#pending.some((p) => p.origin === "goal")) return;
    const max = this.#config.goal.maxRounds;
    if (this.#goalContinueRounds >= max) {
      this.#pauseGoalRun("round budget exhausted", {
        notice:
          `Goal not confirmed met after ${max} continuation round${max === 1 ? "" : "s"} — needs your ` +
          "attention. The ★ goal stays set: /goal resume re-arms the run, /goal clear drops it.",
        level: "warn",
      });
      return;
    }
    // Unfinished seeded tasks are a deterministic "not met" — no model call.
    // This keeps pressure on the task list (the plan's visible spine) and saves
    // an assessment per round while the work is obviously incomplete.
    const unfinished = this.#session.tasks
      .map((t, i) => ({ ref: `t${i + 1}`, title: t.title, status: t.status }))
      .filter((t) => t.status !== "completed");
    const epoch = this.#goalRunEpoch;
    // When the repo has runnable checks (or the gate is on and recon found
    // commands), a missing gate report is NOT a free pass for "met".
    const profile = this.#session.repoProfile;
    const checksAvailable =
      this.#config.build.enabled &&
      this.#config.build.gate.enabled &&
      !!profile &&
      pickChecks(profile, this.#config.build.gate.checks).length > 0;
    const verdict = unfinished.length
      ? {
          met: false,
          gaps: unfinished.map((t) => `${t.ref} (${t.status}): ${t.title}`),
          reason: "seeded tasks unfinished",
        }
      : applyGateToVerdict(await this.#assessGoal(goal), this.#lastGateOutcome, {
          checksAvailable,
        });
    // The assessment await is a window (up to its 90s deadline): an Esc, a
    // /goal clear, or any pause landing inside it disarms the run — acting on
    // the verdict would launch one more autonomous turn the user just stopped.
    // The epoch check also kills a pause-AND-re-arm landing inside the window
    // (a direct-send resume): the resumed run must never inherit a pre-pause
    // verdict as its first continuation.
    if (!this.#goalRunActive || this.#session.interrupted || epoch !== this.#goalRunEpoch) return;
    // Model-supplied reasons arrive with their own punctuation — normalize so
    // the round notice's period doesn't double up.
    const reason = verdict.reason.trim().replace(/\.+$/, "");
    if (verdict.met) {
      this.#goalCleanPasses += 1;
      if (this.#goalCleanPasses >= MAX_GOAL_CLEAN_PASSES) {
        this.#goalRunActive = false;
        this.#goalPhase = undefined;
        this.#goalMet = true;
        this.#goalPauseReason = undefined;
        void this.#persistEngineState();
        this.#emitGoalRun();
        const tasks = this.#session.tasks;
        const taskSummary = tasks.length ? `, ${tasks.length}/${tasks.length} tasks completed` : "";
        const gateSummary = this.#lastGateOutcome ? `, gate ${this.#lastGateOutcome}` : "";
        this.#notice(
          `Goal met after ${this.#goalContinueRounds} round${this.#goalContinueRounds === 1 ? "" : "s"}` +
            `${taskSummary}${gateSummary} — verified across ${MAX_GOAL_CLEAN_PASSES} consecutive clean passes.` +
            (reason ? ` ${reason}.` : ""),
        );
        return;
      }
      // First clean pass buys an adversarial verify turn, not the finish line.
      this.#goalContinueRounds += 1;
      void this.#persistEngineState();
      this.#emitGoalRun();
      this.#notice(
        `Goal round ${this.#goalContinueRounds}/${max} — verifying the claimed completion.`,
      );
      this.#enqueue(
        `goal: verify ${queueLabel(goal)}`,
        () => {
          // Each goal round is a fresh prompt-sized unit of work: it gets its own
          // gate/review/verify budgets (this is why the goal counters live OUTSIDE
          // #resetPromptBudgets — the reset must not zero the run's own bounds).
          // Preserve the last gate verdict: verify turns are often non-mutating
          // and would otherwise free-pass "met" via undefined gate.
          this.#resetPromptBudgets({ preserveGate: true });
          if (this.#session.tasks.some((t) => t.status !== "completed"))
            this.#planExecutionActive = true;
          return this.#runGoalTurn(
            `You reported the north-star goal met: "${goal}". Now verify it is TRULY met, adversarially — ` +
              "re-read the goal and every success criterion, re-check the work against them with evidence " +
              "(run or inspect the project's checks; re-read the files you changed), and hunt for gaps, " +
              "regressions, unhandled edge cases, and anti-slop failures: stubs, placeholders, TODO/FIXME " +
              "in touched code, empty handlers, mismatched style, or claims without proof. Any task still " +
              "in_progress or pending is NOT done — finish it, or mark it completed only if verified. If " +
              "ANY gap exists, fix it now. Only stop when nothing remains.",
            `★ goal — adversarial verify (round ${this.#goalContinueRounds}/${max})`,
          );
        },
        { origin: "goal" },
      );
      return;
    }
    this.#goalCleanPasses = 0; // any gap resets convergence
    this.#goalContinueRounds += 1;
    void this.#persistEngineState();
    this.#emitGoalRun();
    this.#notice(`Goal round ${this.#goalContinueRounds}/${max} — ${reason || "continuing"}.`);
    const gaps = verdict.gaps.length
      ? `\nRemaining gaps:\n${verdict.gaps.map((g) => `- ${g}`).join("\n")}`
      : "";
    const roundLabel = `★ goal — round ${this.#goalContinueRounds}/${max}: ${reason || "continuing"}`;
    this.#enqueue(
      `goal: ${queueLabel(goal)}`,
      () => {
        this.#resetPromptBudgets({ preserveGate: true });
        // Re-arm task-driven continuation when the list still has work (a steer's
        // submit-prompt reset disarms it; this is how the chain resumes after).
        if (this.#session.tasks.some((t) => t.status !== "completed"))
          this.#planExecutionActive = true;
        return this.#runGoalTurn(
          `The north-star goal is not yet met: "${goal}".${gaps}\n` +
            "Continue the work — address the gaps, keep the task list current, and do not stop while " +
            "any part of the goal is unmet or the project's checks fail.",
          roundLabel,
        );
      },
      { origin: "goal" },
    );
  }

  /** Self-assess whether the goal is met, from the last assistant text, the
   * task list, and a capped working-tree diff. Same resilience rails as the
   * /loop --until evaluator (retry, tree-global limiter, hard deadline); an
   * assessment failure reads as "not met, no new gaps" so the run continues
   * bounded rather than dying on a provider blip (same treat-failure-as-not-yet
   * shape as LoopController's condition check). */
  async #assessGoal(goal: string): Promise<{ met: boolean; gaps: string[]; reason: string }> {
    try {
      const tasks = this.#session.tasks;
      const taskBlock = tasks.length
        ? `\nTask list:\n${tasks.map((t, i) => `t${i + 1} [${t.status}] ${t.title}`).join("\n")}`
        : "";
      let diff = "";
      try {
        diff = await this.#fallbackReviewDiff();
      } catch {
        // Not a repo / git unavailable — assess from the transcript alone.
      }
      if (diff.length > GOAL_ASSESS_DIFF_CAP) {
        diff = `${diff.slice(0, GOAL_ASSESS_DIFF_CAP)}\n…(diff truncated)`;
      }
      const model = await withRetry(
        () => this.registry.resolveModel(this.#session.model, this.#config),
        {
          maxAttempts: this.#config.retry.maxAttempts,
          baseDelayMs: this.#config.retry.baseDelayMs,
        },
      );
      // Same structured-object path as #evaluateCondition: ollama/local models
      // that lack response_format JSON must not brick /goal assessment (the
      // "assessment unavailable — continuing" + AI SDK warning data point).
      const supportsStructuredOutput = await this.#supportsStructuredOutput(this.#session.model);
      return await this.#limiter.run(
        () =>
          generateStructuredObject({
            model,
            schema: z.object({ met: z.boolean(), gaps: z.array(z.string()), reason: z.string() }),
            abortSignal: AbortSignal.timeout(60_000),
            maxRetries: this.#config.retry.maxAttempts,
            supportsStructuredOutput,
            prompt:
              `You are a pessimistic auditor. Default to met=false unless the evidence is overwhelming.\n` +
              `Goal: ${goal}\n\nAgent's latest report:\n${this.#session.lastAssistantText()}\n` +
              `${taskBlock}\nGate: ${this.#lastGateOutcome ?? "unverified"}\n` +
              `${diff ? `\nWorking-tree diff (may be truncated):\n${diff}\n` : ""}\n` +
              "Return met=true ONLY if every part of the goal is clearly, verifiably done with evidence " +
              "in the report/diff/gate — not because the agent claimed it. If uncertain, incomplete, " +
              "stubbed, untested, or only partially addressed → met=false. " +
              "Never return met=true if the gate is red or unverified when checks should have run. " +
              "Flag anti-slop gaps (stubs, placeholders, TODO left in changed code, missing verification). " +
              "List each concrete remaining gap in `gaps` (empty if none) and a one-sentence `reason`.",
          }),
        AbortSignal.timeout(90_000),
      );
    } catch {
      return { met: false, gaps: [], reason: "assessment unavailable — continuing" };
    }
  }

  /** Reset every per-user-prompt budget + the diff-review baseline. Called once
   * at the start of a genuine user-initiated prompt (typed submit-prompt, or a
   * slash command that expands into a prompt) — NEVER by an engine-internal fix
   * turn (gate-fix / review-fix / verify-fix), so the "bounded per user prompt"
   * invariant holds and a fix cycle can't reset its own budget mid-flight.
   *
   * Goal-round callers pass `{ preserveGate: true }` so an adversarial verify
   * (non-mutating → not gateable) still sees the last green/red verdict instead
   * of treating `undefined` as a free pass for "met". */
  #resetPromptBudgets(opts: { preserveGate?: boolean } = {}): void {
    this.#verifyAttempts = 0;
    this.#gateRounds = 0;
    this.#reviewRounds = 0;
    this.#taskContinueRounds = 0;
    this.#idleContinueRounds = 0;
    this.#planExecutionActive = false;
    this.#fixPending = false;
    this.#userStop = false;
    if (!opts.preserveGate) this.#lastGateOutcome = undefined;
    this.#promptBaselineId = undefined;
  }

  /** The shared gating for post-turn verification: a mutating execute turn the
   * user didn't interrupt (matches the legacy `#maybeVerify` guards). Also true
   * when a DETACHED subagent dirtied the tree after the spawn turn finished
   * (Session.backgroundDirty) so background edits are not skipped forever. */
  #turnIsGateable(): boolean {
    // turnMode, not mode: the turn is judged by the mode it STARTED in — a
    // mid-turn flip to plan must not smuggle a mutating turn past the gate.
    return (
      this.#session.turnMode === "execute" &&
      (this.#session.didMutate || this.#session.backgroundDirty) &&
      !this.#session.interrupted
    );
  }

  /**
   * Run the real green-gate once against the (quiescent) tree, then act on the
   * outcome: RED enqueues ONE bounded fix turn (formatGateFailure), GREEN commits
   * on green + runs the adversarial diff review, UNVERIFIED just notices honestly.
   */
  async #runGate(profile: RepoProfile): Promise<GateSummary["outcome"]> {
    const gate = this.#config.build.gate;
    const summary = await runGate(this.#cwd, profile, this.#gateRounds, {
      checks: gate.checks,
      timeoutSec: gate.timeoutSec,
      // Run the gate's build/test/lint under the OS sandbox (bunExec upgrades a
      // read-only policy to workspace-write so artifacts can still be written).
      exec: bunExec(this.#sandbox),
      // Thread the session's abort signal so an Esc during a long gate build
      // stops it between (and, via exec, during) checks — otherwise the only
      // bound was the per-check timeout (default 600s × N checks), wedging the
      // queue unabortably.
      signal: this.#session.abortSignal,
    });
    if (summary.outcome === "aborted") {
      // The user interrupted the gate (Esc) before it reached a verdict. Nothing
      // was machine-verified, so take NONE of the verdict paths: no gate-fix
      // enqueue, no #gateRounds increment, no green-ledger persist, no
      // commit-on-green, no adversarial review. Just a quiet, honest notice.
      this.#notice(formatGateOutcome(summary), "info");
      return summary.outcome;
    }
    if (summary.outcome === "unverified") {
      // pickChecks found commands but the gate produced no verdict (every check
      // aborted / no output) — still honest, never green.
      this.#notice(formatGateOutcome(summary), "info");
      return summary.outcome;
    }
    if (summary.outcome === "red") {
      if (this.#gateRounds >= gate.maxRounds) {
        this.#notice(
          `${formatGateOutcome(summary)} — STILL RED after ${gate.maxRounds} fix round(s). ` +
            "Stopping so you can look: the build/tests are broken and the automatic fix budget is spent " +
            "(raise build.gate.maxRounds to give it more rounds).",
          "warn",
        );
        // No fix turn was enqueued, so #afterTurn's red-skips-continuation
        // shortcut has no follow-up turn to re-enter #maybeContinueGoal — a
        // live goal run would sit armed-but-idle forever (and a kill+resume
        // would resurrect it against an unverified gate). Pause it honestly.
        this.#pauseGoalRun(`the gate stayed red after ${gate.maxRounds} fix round(s)`, {
          notice:
            "Goal run paused — the gate is still red and its fix budget is spent. Fix the failures " +
            "(or raise build.gate.maxRounds), then /goal resume to re-arm the run.",
          level: "warn",
        });
        return summary.outcome;
      }
      this.#gateRounds += 1;
      this.#notice(formatGateOutcome(summary), "warn");
      this.#enqueueFix("gate-fix", () =>
        this.#runFixTurn(formatGateFailure(summary, gate.maxRounds)),
      );
      return summary.outcome;
    }
    // GREEN.
    this.#notice(formatGateOutcome(summary), "info");
    this.#persistGreenLedger(profile);
    // Runtime visual verification (web apps only): boot the app headless and
    // find what green checks can't — console errors + dead controls. Its
    // findings ride the SAME adversarial-review fix budget as the diff review.
    // Review BEFORE commit-on-green: branch mode's gitCommitGreen moves HEAD over
    // this turn's work, and with checkpoints disabled the review diff falls back
    // to `git diff HEAD` — committing first blanked that diff, silently skipping
    // the review AFTER the unreviewed commit had already landed. The review stays
    // advisory and bounded (Esc / 120s / provider failure all degrade inside
    // #maybeReview, and a flagged diff enqueues a fix turn without blocking); the
    // finally guarantees the green tree is committed either way, exactly as
    // before — visual verify rides inside it for the same reason. Checkpoint
    // mode is ordering-insensitive (hidden ref, and the review diffs from the
    // PRE-edit baseline) — one order for both keeps this simple.
    try {
      const visual = await this.#maybeVisualVerify(profile);
      await this.#maybeReview(visual);
    } finally {
      await this.#commitOnGreen(summary);
    }
    return summary.outcome;
  }

  /**
   * Cross-run repo memory: after a GREEN gate, persist the recon-detected
   * commands (which just ran green) + conventions to `.vibe/ledger.jsonl`, keyed
   * by the manifest signature, so the NEXT session's recon starts where this one
   * ended (`resolveRepoProfile` merges them back in via `loadLedger`). Without
   * this writeback the ledger — and the `build.recon.ledger` toggle — were inert.
   * Gated on the toggle; best-effort (append failures never block a turn).
   */
  #persistGreenLedger(profile: RepoProfile): void {
    if (!this.#config.build.recon.ledger || profile.greenfield) return;
    if (!Object.keys(profile.commands).length) return;
    appendLedger(this.#cwd, {
      manifestHash: manifestHash({
        commands: profile.commands,
        manifestFiles: profile.manifestFiles,
        packageManager: profile.packageManager,
        primaryLanguage: profile.primaryLanguage,
      }),
      commandsHash: commandsHash(profile.commands),
      at: Date.now(),
      commands: profile.commands,
      conventions: profile.conventions,
    });
  }

  /**
   * Runtime visual verification of a green web app. Best-effort and bounded
   * (90s wall clock): boots the dev server, renders it headless, and collects
   * console errors + dead controls. Returns a compact findings block ONLY when
   * the check ran AND found real issues (so it feeds a fix turn); otherwise it
   * notices the result and returns undefined. A silent skip (not a web app,
   * playwright absent, aborted) is invisible except in the debug log.
   */
  async #maybeVisualVerify(profile: RepoProfile): Promise<string | undefined> {
    if (!this.#config.build.visualVerify || !isWebApp(profile)) return undefined;
    let result: Awaited<ReturnType<typeof browserVerify>>;
    try {
      result = await browserVerify(this.#cwd, profile, {
        signal: AbortSignal.timeout(90_000),
        log: this.#log,
      });
    } catch (err) {
      this.#log.debug(`visual verify skipped: ${(err as Error).message}`);
      return undefined;
    }
    if (!result) return undefined; // silently skipped (not applicable / unavailable)
    const block = formatBrowserVerify(result);
    const hasFindings =
      result.ran && (result.consoleErrors.length > 0 || result.deadControls.length > 0);
    this.#notice(block, hasFindings ? "warn" : "info");
    return hasFindings ? block : undefined;
  }

  /**
   * Commit-on-green. Default "checkpoint" mode writes a hidden-ref GREEN snapshot
   * (dirty-tree-safe, never touches the user's branch). "branch" mode checks out
   * a work branch ONCE per session then commits after each green gate. "off" skips.
   */
  async #commitOnGreen(summary: GateSummary): Promise<void> {
    const mode = this.#config.build.commit.mode;
    if (mode === "off") return;
    const label = greenLabel(summary);
    if (mode === "checkpoint") {
      const cp = await this.#checkpoints.snapshot(label, this.#session.conversationMark(), {
        green: true,
        gate: summary,
      });
      if (cp) this.#bus.emit({ type: "checkpoint-created", id: cp.id, label: cp.label });
      return;
    }
    await this.#commitOnGreenBranch(label);
  }

  /** Branch-mode commit-on-green: prepare the work branch once (cache the verdict;
   * a refusal notices once and disables branch commits for the session), then
   * commit the green tree. NEVER toggles the user's branch per-commit. */
  async #commitOnGreenBranch(label: string): Promise<void> {
    if (this.#branchPrepared === null) {
      const prep = await gitPrepare(this.#cwd, {
        branch: this.#config.build.commit.branchPrefix + this.#session.id,
      });
      this.#branchPrepared = prep.ok;
      this.#notice(
        prep.ok
          ? `Green commits: on work branch ${prep.branch}.`
          : `Green commits disabled: ${prep.reason ?? "git prepare refused"}.`,
        prep.ok ? "info" : "warn",
      );
    }
    if (!this.#branchPrepared) return;
    const sha = await gitCommitGreen(this.#cwd, `vibecodr ${label}`);
    if (sha) this.#notice(`Committed green checkpoint ${sha}.`, "info");
  }

  /**
   * The review diff when no checkpoint baseline exists (checkpoints disabled).
   * A bare `git diff` shows only tracked, unstaged changes — so a brand-new file
   * the agent CREATED (untracked) was invisible to both the reviewer and the stub
   * scan, letting a new file full of stubs ship unreviewed. This includes staged
   * changes (`diff HEAD`) and untracked, non-ignored files (synthesized as an
   * add-diff against /dev/null). Non-destructive: never touches the index.
   */
  async #fallbackReviewDiff(): Promise<string> {
    // Tracked changes vs HEAD (staged + unstaged). In a repo with no commits yet,
    // `git diff HEAD` errors — fall back to the plain working-tree diff there.
    const tracked = await spawnGit(this.#cwd, ["diff", "HEAD"]);
    let diff = tracked.ok ? tracked.stdout : (await spawnGit(this.#cwd, ["diff"])).stdout;
    const listed = await spawnGit(this.#cwd, ["ls-files", "--others", "--exclude-standard"]);
    if (listed.ok && listed.stdout.trim()) {
      for (const file of listed.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        // `git diff --no-index` exits 1 when the files differ, so read stdout
        // regardless of `ok`. `--` guards a filename that looks like a flag.
        const d = await spawnGit(this.#cwd, ["diff", "--no-index", "--", "/dev/null", file]);
        if (d.stdout.trim()) diff += (diff ? "\n" : "") + d.stdout;
      }
    }
    return diff;
  }

  /**
   * Adversarial diff review after a GREEN gate. Diffs THIS turn's work (the
   * pre-turn checkpoint base, or a plain working-tree diff as fallback), scans it
   * for stub/dead-code signals, and asks the model to judge the diff ALONE
   * (single-shot generateText — it reads no files, but the diff is the evidence).
   * NOT clean → one bounded fix turn with the reviewer's feedback. Bounded by
   * review.maxRounds per user prompt; best-effort (a failure never blocks a turn).
   */
  async #maybeReview(visualFindings?: string): Promise<void> {
    const review = this.#config.build.review;
    if (!review.enabled || this.#reviewRounds >= review.maxRounds) return;

    // The REAL diff of this user prompt's work. Prefer the PROMPT baseline (the
    // checkpoint before the first turn of this prompt) so a red→fix→green
    // sequence reviews the cumulative change, not just the last fix turn; fall
    // back to this turn's checkpoint, then a plain working-tree diff when no
    // checkpoint was taken (not a repo / checkpoints disabled).
    const baseCheckpoint = this.#promptBaselineId ?? this.#turnCheckpointId;
    let diff: string;
    if (baseCheckpoint) {
      diff = await this.#checkpoints.diffFrom(baseCheckpoint);
    } else {
      diff = await this.#fallbackReviewDiff();
    }
    // Nothing to act on: no diff to review AND no runtime findings to fix.
    if (!diff.trim() && !visualFindings) return;
    // Cap the fallback path too (diffFrom already caps its own output).
    if (diff.length > REVIEW_DIFF_CAP) {
      diff = `${diff.slice(0, REVIEW_DIFF_CAP)}\n…(diff truncated at ${REVIEW_DIFF_CAP} chars)`;
    }

    // Adversarial diff review of this turn's changes (skipped when there's no
    // diff — e.g. runtime-only findings). The reviewer also sees the visual
    // findings, so ONE review covers static diff + runtime issues.
    let reviewFlagged = "";
    if (diff.trim()) {
      const stubBlock = review.stubScan ? formatStubFindings(scanStubs(diff)) : "";
      const model = await this.registry
        .resolveModel(this.#session.model, this.#config)
        .catch(() => undefined);
      if (!model) {
        // No model to review the diff with. Runtime findings still warrant a fix;
        // a pure diff review with nothing to run against just bows out (as before).
        if (!visualFindings) return;
      } else {
        try {
          const { text } = await generateText({
            model,
            prompt: buildReviewPrompt(diff, stubBlock, visualFindings),
            // The review is a single auxiliary provider call: unbounded, a hung
            // provider wedged `vibe -p` forever with Esc ignored. Bound it by the
            // session abort signal (Esc) AND a hard 120s ceiling; either trips the
            // catch below, which skips the review and lets the turn complete.
            abortSignal: AbortSignal.any([this.#session.abortSignal, AbortSignal.timeout(120_000)]),
          });
          if (!isReviewClean(text)) reviewFlagged = text;
        } catch (err) {
          // Best-effort auxiliary call — an Esc-abort, the 120s timeout, or a
          // transient provider error skips the review with a calm notice and lets
          // the turn complete (same degrade-don't-kill shape as #maybeCompact's
          // summarizer failure); an interrupt must never surface as a scary error.
          // Runtime findings are still ground truth, so fall through to fix them.
          this.#notice(`Diff review skipped: ${(err as Error)?.message ?? String(err)}.`, "warn");
          if (!visualFindings) return;
        }
      }
    }

    // Runtime findings (dead controls / console errors) are ground truth, so
    // they force a fix turn even when the diff reviewer comes back clean.
    if (!reviewFlagged && !visualFindings) {
      this.#notice("Diff review: clean — no issues flagged.", "info");
      return;
    }
    this.#reviewRounds += 1;
    this.#notice(
      reviewFlagged && visualFindings
        ? "Diff review + visual check flagged issues; queuing a fix turn."
        : reviewFlagged
          ? "Diff review flagged issues; queuing a fix turn."
          : "Visual check flagged issues; queuing a fix turn.",
      "warn",
    );
    this.#enqueueFix("review-fix", () =>
      this.#runFixTurn(buildReviewFixPrompt(reviewFlagged, visualFindings)),
    );
  }

  /**
   * Auto-verify (legacy path): after an edit turn, run the verify command; on
   * failure, feed the output back as a follow-up so the agent self-corrects
   * (capped retries).
   *
   * Return shape is intentionally rich so `#afterTurn` can:
   * - tell "machine-verified" from "nothing checked" (`ran`/`ok`);
   * - skip task/goal continuations while a verify-fix is queued (`fixEnqueued`);
   * - mark exhausted failures as red (`exhaustedFail`) instead of pretending
   *   verification succeeded.
   */
  async #maybeVerify(): Promise<{
    ran: boolean;
    ok: boolean;
    fixEnqueued: boolean;
    exhaustedFail: boolean;
  }> {
    const none = { ran: false, ok: false, fixEnqueued: false, exhaustedFail: false };
    const { command, auto, maxRetries } = this.#config.verify;
    if (!auto || !command) return none;
    if (
      this.#session.turnMode !== "execute" ||
      !(this.#session.didMutate || this.#session.backgroundDirty)
    ) {
      return none;
    }
    // The user interrupted this turn (Esc / steer) — don't run verify against a
    // half-applied edit and enqueue an unsolicited "verification failed, fix it"
    // turn behind whatever they steered to.
    if (this.#session.interrupted || this.#userStop) return none;

    const result = await this.#runVerifyCommand(command);
    if (result.ok) return { ran: true, ok: true, fixEnqueued: false, exhaustedFail: false };
    if (this.#verifyAttempts >= maxRetries) {
      this.#notice(
        `Verification still failing after ${maxRetries} attempt(s); stopping auto-fix.`,
        "warn",
      );
      return { ran: true, ok: false, fixEnqueued: false, exhaustedFail: true };
    }
    this.#verifyAttempts += 1;
    this.#enqueueFix("verify-fix", () =>
      this.#runFixTurn(
        `The verification command \`${command}\` failed:\n\n${result.output}\n\n` +
          `Fix the cause and keep changes minimal.`,
      ),
    );
    return { ran: true, ok: false, fixEnqueued: true, exhaustedFail: false };
  }

  /** Run the verify command, emitting start/finish events. Runs through
   * `bunExec` (not the legacy `runVerify`) so it inherits a wall-clock timeout
   * AND the session abort signal with killTree teardown — a watch-mode or hung
   * `verify.command` can't wedge the FIFO queue forever, and Esc reaches it.
   * `bunExec` upgrades a read-only sandbox to workspace-write for these
   * engine-owned check commands, same as `runVerify` did via `policyForChecks`. */
  async #runVerifyCommand(command: string): Promise<{ ok: boolean; output: string }> {
    this.#bus.emit({ type: "verify-started", command });
    const exec = bunExec(this.#sandbox);
    const r = await exec(command, {
      cwd: this.#cwd,
      timeoutSec: 600,
      signal: this.#session.abortSignal,
    });
    const combined = r.out.trim();
    const output =
      combined.length > VERIFY_MAX_OUTPUT
        ? `${combined.slice(0, VERIFY_MAX_OUTPUT)}\n…(truncated)`
        : combined;
    const result = { ok: r.code === 0, output };
    this.#bus.emit({
      type: "verify-finished",
      ok: result.ok,
      output: result.output,
    });
    return result;
  }

  /** Run a git command in the workspace (thin wrapper over the shared runner). */
  #git(args: string[]): Promise<GitRunResult> {
    return spawnGit(this.#cwd, args);
  }

  /** Recompute git state, cache it for the snapshot, and broadcast to the UI. */
  async #emitGit(): Promise<void> {
    try {
      const git = await readGitInfo(this.#cwd);
      if (git) {
        this.#gitState = git;
        this.#bus.emit({ type: "git-updated", sessionId: this.#session.id, git });
      }
    } catch {
      // Git unavailable — the header simply omits the git context.
    }
  }

  /** Push the current background-job list (commands + localhost servers) to the
   * UI's `/jobs` sub-view. Fired whenever a job starts, exits, is killed, or
   * first binds a localhost server. */
  #emitJobs(): void {
    if (!this.#session) return;
    this.#bus.emit({
      type: "jobs-changed",
      sessionId: this.#session.id,
      jobs: this.#jobs.snapshot(),
    });
  }
}

/** A short one-line label for a queued prompt. */
function queueLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

/** Cap on the diff handed to the single-shot reviewer (chars) — the same bound
 * the task reviewer + checkpoints.diffFrom use, so a large refactor's diff can't
 * blow the review turn's context window. */
const REVIEW_DIFF_CAP = 20_000;

/** The green checkpoint / commit label, e.g. "green: typecheck ✓ test ✓ 142/142". */
function greenLabel(summary: GateSummary): string {
  const parts = summary.checks.map(
    (c) => `${c.check} ✓${c.total ? ` ${c.total - c.failed}/${c.total}` : ""}`,
  );
  return `green: ${parts.join(" ")}`.trim();
}

/** The adversarial-diff-review prompt. Mirrors the orchestrator's #reviewTask
 * contract, but single-shot: the reviewer has NO file access, so it judges the
 * diff alone and flags anything suspicious for the main agent to re-check. */
function buildReviewPrompt(diff: string, stubBlock: string, visualBlock?: string): string {
  return (
    "You are an adversarial code reviewer. A coding agent just made changes and the " +
    "repo's REAL checks (typecheck/test/build) are already GREEN. Judge the DIFF BELOW " +
    "ALONE — you have no file access — and flag what green checks can't catch: dead or " +
    "unfinished code, stubs, wrong logic, missing error handling, or changes that don't " +
    "match the apparent intent. Judge from the diff alone; flag anything suspicious for " +
    "the main agent to re-check.\n\n" +
    "```diff\n" +
    diff +
    "\n```\n" +
    (stubBlock
      ? `\nDeterministic stub-scan flagged these ADDED lines (advisory — some are false positives):\n${stubBlock}\n`
      : "") +
    (visualBlock
      ? `\nA runtime visual check of the rendered app also reported (dead controls = clicked with no observable effect):\n${visualBlock}\n`
      : "") +
    "\nReport concrete issues, each as `path:line — problem`. If the diff is correct and " +
    "complete, reply with exactly REVIEW-CLEAN on its own line."
  );
}

/** The fix-turn prompt combining adversarial diff-review output and/or runtime
 * visual-check findings. With only the review output it reproduces the original
 * single-source prompt verbatim. */
function buildReviewFixPrompt(reviewOut: string, visualFindings?: string): string {
  const parts: string[] = [];
  if (reviewOut) {
    parts.push(
      "An adversarial review of your diff (the engine's REAL changes this turn) flagged " +
        "issues. Verify each against the ACTUAL files, fix genuine problems, and keep changes minimal:\n\n" +
        reviewOut,
    );
  }
  if (visualFindings) {
    parts.push(
      "A runtime visual check booted the app and found the issues below. Dead controls were " +
        "clicked with NO observable effect (no navigation, DOM change, network request, or dialog) — " +
        "wire them up or remove them, and fix the console errors. Verify against the ACTUAL files:\n\n" +
        visualFindings,
    );
  }
  return parts.join("\n\n");
}
