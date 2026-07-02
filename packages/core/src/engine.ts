import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import {
  createId,
  createLogger,
  type EngineClient,
  type EngineCommand,
  type EngineSnapshot,
  type GateSummary,
  type GitInfo,
  type Logger,
  type Mode,
  type ProviderInfo,
  type AgentInfo,
  type QueuedItem,
  type RepoProfile,
  type UIEvent,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import { writeGlobalConfig } from "@vibe/config";
import {
  ProviderRegistry,
  CatalogService,
  probeOllamaContextWindow,
  probeLmStudioContextWindow,
  type ModelInfo,
} from "@vibe/providers";
import { Toolset, builtinTools, buildRepoMap, createFileLock, BackgroundJobs } from "@vibe/tools";
import type { ModelPrice } from "@vibe/config";
import {
  HookBus,
  CommandRegistry,
  SkillRegistry,
  PluginHost,
  parseSlash,
} from "@vibe/plugins";
import { EventBus } from "./event-bus.ts";
import { Session, isReviewClean } from "./session.ts";
import { BUILTIN_COMMANDS } from "./commands.ts";
import { type PermissionReply, type PermissionResolver, scopeString } from "./permissions.ts";
import { loadAgents, scaffoldAgent, setAgentModel, type NamedAgent } from "./agents.ts";
import { resolveRepoProfile } from "./build/profile.ts";
import { appendLedger, manifestHash, commandsHash } from "./build/ledger.ts";
import {
  runGate,
  pickChecks,
  formatGateFailure,
  formatGateOutcome,
} from "./build/gate.ts";
import { scanStubs, formatStubFindings } from "./build/stubscan.ts";
import { isWebApp } from "./build/codeintel.ts";
import { browserVerify, formatBrowserVerify } from "./build/browser-verify.ts";
import { gitPrepare, gitCommitGreen } from "./build/gitops.ts";
import { TsDiagnostics } from "./diagnostics.ts";
import {
  loadCommandFiles,
  loadCommandsFrom,
  loadSkills,
  loadSkillsFrom,
  globalCommandsDir,
  globalSkillsDir,
} from "./loaders.ts";
import { LoopController, parseLoopArgs } from "./loop.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { MemoryService } from "./memory-service.ts";
import { createLimiter, type Limiter } from "./limiter.ts";
import { createBlackboard } from "./blackboard.ts";
import { registerConfigHooks } from "./config-hooks.ts";
import { loadProjectMemory } from "./memory.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { McpHub, type McpConnect } from "./mcp.ts";
import { readGitInfo, spawnGit, type GitRunResult } from "./git-info.ts";
import { runVerify } from "./verify.ts";
import { withRetry } from "./retry.ts";
import { expandMentions } from "./mentions.ts";
import {
  handleSlash,
  handleApprovals,
  setMainModel,
  setSubagentModel,
  type EngineHandle,
} from "./engine-commands.ts";

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
  #projectMemory: string | undefined;
  #session: Session;
  #log: Logger;
  #pending: { id: string; label: string; run: () => Promise<void> }[] = [];
  #active: QueuedItem | null = null;
  #draining = false;
  #idleResolvers: (() => void)[] = [];
  #agents = new Map<string, NamedAgent>();
  /** One per-file write lock shared across the whole session tree (parent +
   * every subagent), so concurrent agents can't corrupt the same file. */
  #fileLock = createFileLock();
  /** Tree-global adaptive concurrency gate in front of every provider call
   * (initialized in the constructor once config is available). */
  #limiter!: Limiter;
  /** Shared coordination board for parallel subagents, shared across the tree. */
  #blackboard = createBlackboard();
  /** In-process TS language service (lazy; no-op without the optional dep) —
   * edit/write append its diagnostics so type errors surface in the same step. */
  #diagnostics = new TsDiagnostics();
  #loop: LoopController | undefined;
  /** The session running the current loop iteration, so a stop can abort it. */
  #loopSession: Session | undefined;
  #permissionResolver: PermissionResolver | undefined;
  #interactive: boolean;
  #alwaysAllow = new Set<string>();
  #pendingPermissions = new Map<
    string,
    (d: "once" | "always" | "deny", feedback?: string) => void
  >();
  #store: SessionStore;
  #checkpoints: CheckpointManager;
  #mcp: McpHub;
  #memory: MemoryService | undefined;
  /** Whether proactive recall has already injected context this session (once). */
  #proactiveRecallDone = false;
  /** Memoized finalize promise (digest + teardown runs once). */
  #finalizing: Promise<void> | undefined;
  /** The last plan the model presented via present_plan (for handoff on execute). */
  #lastPlan: string | undefined;
  /** Set when plan→execute happens after a presented plan: the next prompt gets
   * a "the user approved your plan; proceed" preamble so the model doesn't read
   * its own "stop here" as an instruction to halt. */
  #pendingHandoff = false;
  #verifyAttempts = 0;
  /** Bounded red→fix→re-gate rounds for the green-gate, per user prompt (reset
   * on submit-prompt alongside #verifyAttempts). */
  #gateRounds = 0;
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
      // Floor the AIMD ceiling at the max nesting depth (+1 for the root) so a
      // LINEAR subagent chain — where each of `maxDepth`+1 ancestors holds a
      // tree-global slot while awaiting its descendant — can never starve its
      // own leaf and deadlock, even after repeated overload backoff. Wider trees
      // that still over-subscribe self-heal via the per-subagent wall-clock
      // timeout, which now (abort-aware limiter) unwedges a stuck acquire.
      min: opts.config.subagent.maxDepth + 1,
      onChange: (limit) => this.#log.debug(`provider concurrency ceiling → ${limit}`),
    });
    this.#cwd = opts.cwd ?? process.cwd();
    this.#projectMemory = opts.projectMemory;
    this.#interactive = opts.interactive ?? false;
    // Use the caller's resolver if given (tests); otherwise bridge `ask`
    // decisions to the UI via permission-request / resolve-permission.
    this.#permissionResolver =
      opts.permissionResolver ?? ((req) => this.#askPermission(req));
    this.#store = new SessionStore(this.#cwd);
    this.#checkpoints = new CheckpointManager(this.#cwd);
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
            ...(opts.config.search.apiKey
              ? { apiKey: opts.config.search.apiKey }
              : {}),
          },
          webfetch: {
            allowPrivateHosts: opts.config.webfetch.allowPrivateHosts,
            allowHosts: opts.config.webfetch.allowHosts,
            timeoutMs: opts.config.webfetch.timeoutMs,
            maxBytes: opts.config.webfetch.maxBytes,
          },
          jobs: this.#jobs,
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
    const resume = opts.resume;
    this.#session = new Session({
      config: opts.config,
      registry: this.registry,
      toolset: this.toolset,
      bus: this.#bus,
      cwd: this.#cwd,
      // An explicit CLI --model/--mode wins over the resumed session's saved
      // value; otherwise the resumed value wins, falling back to config.
      model: opts.modelOverride ?? resume?.meta.model ?? opts.config.model,
      mode: opts.modeOverride ?? resume?.meta.mode ?? opts.config.mode,
      goal: resume?.meta.goal ?? null,
      projectMemory: opts.projectMemory,
      permissionResolver: this.#permissionResolver,
      agents: this.#agents,
      fileLock: this.#fileLock,
      limiter: this.#limiter,
      blackboard: this.#blackboard,
      diagnostics: this.#diagnostics,
      skills: this.skills,
      hooks: this.hooks,
      store: this.#store,
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
                }
              : {}),
          }
        : {}),
    });
    // A resumed session that already carries a recalled block must not run
    // proactive recall again (it would stack a second, possibly divergent one).
    if (resume?.meta.recalledContext) this.#proactiveRecallDone = true;

    // Watch our own (fan-out) event stream to capture a presented plan: persist
    // it to .vibe/plans and remember it for the plan→execute handoff. A separate
    // subscriber, so it never steals events from the TUI/headless renderer.
    void this.#watchInternalEvents();
  }

  async #watchInternalEvents(): Promise<void> {
    for await (const event of this.#bus.subscribe()) {
      if (event.type === "plan-presented") await this.#onPlanPresented(event.plan);
    }
  }

  /** Engine-side per-session state that must survive --resume but belongs to
   * the ENGINE, not the conversation: today just the armed plan handoff. */
  #engineStatePath(): string {
    return join(this.#cwd, ".vibe", "sessions", this.#session.id, "engine.json");
  }

  async #persistEngineState(): Promise<void> {
    try {
      await mkdir(join(this.#cwd, ".vibe", "sessions", this.#session.id), { recursive: true });
      await Bun.write(this.#engineStatePath(), JSON.stringify({ pendingHandoff: this.#pendingHandoff }));
    } catch {
      /* best-effort — losing this on a crash only loses one convenience flag */
    }
  }

  /** Restore engine-side state + the last presented plan on --resume. */
  async #restoreEngineState(): Promise<void> {
    try {
      const state = (await Bun.file(this.#engineStatePath()).json()) as { pendingHandoff?: boolean };
      if (state.pendingHandoff) this.#pendingHandoff = true;
    } catch {
      /* absent/corrupt → nothing to restore */
    }
    try {
      const plan = await Bun.file(this.#planPath()).text();
      // Strip the "# Plan — <id>" header the writer prepends.
      this.#lastPlan = plan.replace(/^# Plan — [^\n]*\n+/, "").trim() || undefined;
    } catch {
      /* no persisted plan */
    }
  }

  /** Path of the persisted presented-plan file for this session. */
  #planPath(): string {
    return join(this.#cwd, ".vibe", "plans", `${this.#session.id}.md`);
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

  /** Persist an approved-able plan and remember it for the execute handoff. */
  async #onPlanPresented(plan: string): Promise<void> {
    this.#lastPlan = plan;
    try {
      await mkdir(join(this.#cwd, ".vibe", "plans"), { recursive: true });
      await Bun.write(this.#planPath(), `# Plan — ${this.#session.id}\n\n${plan}\n`);
      this.#bus.emit({ type: "notice", level: "info", message: `Plan saved to .vibe/plans/${this.#session.id}.md` });
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
  #resolvePlan(decision: "accept" | "edit" | "keep-planning", edit?: string): void {
    if (decision === "edit") {
      const feedback = edit?.trim();
      if (feedback) this.#enqueue(queueLabel(feedback), () => this.#handlePrompt(feedback));
      return;
    }
    if (decision === "keep-planning") {
      this.#bus.emit({ type: "notice", level: "info", message: "Kept planning — the plan wasn't started." });
      return;
    }
    // accept
    const plan = this.#lastPlan;
    if (!plan) return;
    // Clear the armed plan NOW (not later, when the enqueued job runs) so a
    // second `resolve-plan{accept}` — a double-click, a scripted/plugin re-send —
    // fails the `if (!plan) return` guard above instead of seeding the task list
    // twice and firing two execute turns against the same plan.
    this.#lastPlan = undefined;
    this.#session.setMode("execute");
    // Accepting a plan is a mode transition into gated EXECUTE — reset approvals
    // to `ask` so a plan approved from a YOLO session doesn't start executing
    // unprompted. Mirrors the Shift+Tab / `/execute` coupling.
    handleApprovals(this.#getCommandHandle(), "ask", true);
    this.#seedTasksFromPlan(plan);
    // Bind the handoff directly to this job so it applies to THIS turn and can't
    // be stolen by a prompt the user queued ahead of it.
    this.#enqueue("execute plan", () =>
      this.#handlePrompt("Proceed with the approved plan.", { handoff: true }),
    );
  }

  /** Seed the task list from a plan's checklist (`- [ ] step`) or numbered steps. */
  #seedTasksFromPlan(plan: string): void {
    const lines = plan.split("\n");
    let items = lines
      .map((l) => /^\s*[-*]\s+\[[ xX]?\]\s+(.+)$/.exec(l)?.[1])
      .filter((t): t is string => !!t);
    if (!items.length) {
      items = lines.map((l) => /^\s*\d+\.\s+(.+)$/.exec(l)?.[1]).filter((t): t is string => !!t);
    }
    const titles = items
      .map((t) => t.replace(/\*\*/g, "").replace(/`/g, "").trim())
      .filter(Boolean)
      .slice(0, 12);
    if (titles.length) this.#session.setTasks(titles.map((title) => ({ title, status: "pending" as const })));
  }

  /**
   * Load project-local resources from disk: named agents, custom slash command
   * files, skills, and plugins (which may register more of any of these).
   * Safe to call once before the first run.
   */
  async bootstrap(): Promise<void> {
    for (const [name, agent] of await loadAgents(this.#cwd)) {
      this.#agents.set(name, agent);
    }
    // Global skills/commands (~/.config/vibe-codr/{skills,commands}) load FIRST so
    // a project-local file of the same name overrides the user-global one (the
    // registries are last-write-wins by name), matching how memory precedence works.
    for (const cmd of await loadCommandsFrom(globalCommandsDir())) {
      this.commands.register(cmd);
    }
    for (const skill of await loadSkillsFrom(globalSkillsDir())) {
      this.skills.register(skill);
    }
    for (const cmd of await loadCommandFiles(this.#cwd)) {
      this.commands.register(cmd);
    }
    for (const skill of await loadSkills(this.#cwd)) {
      this.skills.register(skill);
    }

    const extraSkillDirs: string[] = [];
    const host = new PluginHost({
      hooks: this.hooks,
      commands: this.commands,
      skills: this.skills,
      registerTool: (def) => this.toolset.register(def),
      registerProvider: (def) => this.registry.register(def),
      addSkillDir: (path) => extraSkillDirs.push(path),
      logger: this.#log,
    });
    await host.load(this.#config.plugins);

    for (const dir of extraSkillDirs) {
      for (const skill of await loadSkillsFrom(dir)) {
        this.skills.register(skill);
      }
    }

    // Declarative config hooks (shell/HTTP) layered onto the in-process HookBus.
    if (this.#config.hooks.length) {
      registerConfigHooks(this.#config.hooks, this.hooks);
    }

    // Long-term memory: resolve the (optional) embedder and attach the service
    // to the live session. Degrades to lexical recall when no embedder is
    // available, so this never blocks or fails startup.
    this.#memory = await MemoryService.create(
      this.#cwd,
      this.#config,
      this.registry,
      this.#log,
    );
    this.#session.setMemory(this.#memory);

    // Deterministic repo recon: ONE batched probe (ledger-bootstrapped) whose
    // profile rides every prompt + subagent kickoff in the tree, so no agent
    // ever guesses this repo's build/test commands. Never throws — worst case
    // is an empty profile and everything behaves as before.
    await this.#runRecon();

    // Connect MCP servers last so their tools join the same registry.
    await this.#mcp.start(this.#config.mcp.servers);

    // Restore engine-side per-session state (armed plan handoff + the last
    // presented plan) so a --resume picks up exactly where approval left off.
    await this.#restoreEngineState();

    // Seed the header's git context (branch/dirty/ahead-behind/worktree) so it's
    // in the first snapshot; cheap, and only at startup.
    await this.#emitGit();
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
      const map = profile.greenfield ? undefined : await buildRepoMap(this.#cwd).catch(() => undefined);
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
      commandNames: this.#commandNames(),
      subagentModel: this.#config.subagent.model,
      reasoning: this.#config.reasoning.effort,
      ...(this.#gitState ? { git: this.#gitState } : {}),
    };
  }

  /** Every invocable slash name — built-ins, custom/plugin commands, and skills
   * (which run as `/skillname`) — for the input's "recognized command" cue. */
  #commandNames(): string[] {
    return [
      ...BUILTIN_COMMANDS.map((c) => c.name),
      ...this.commands.list().map((c) => c.name),
      ...this.skills.list().map((s) => s.name),
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
    this.#loop?.stop("shutdown");
    // Unblock any in-flight permission prompts so nothing hangs.
    for (const resolve of this.#pendingPermissions.values()) resolve("deny");
    this.#pendingPermissions.clear();
    // Reap surviving background jobs (dev servers etc.) — the process is going
    // away; leaving them orphaned made every `bash background:true` a leak. Await
    // the SIGKILL escalation so a child that ignores SIGTERM can't outlive us.
    await this.#jobs.killAllAndWait();
    await this.#mcp.close();
    this.#memory?.close();
    this.#bus.close();
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
        // …and starts a fresh coordination context: the blackboard is per-fan-out
        // scratch (claims, transient decisions), NOT durable state — the task list
        // and long-term memory carry that. Clearing here (not on loop iterations,
        // verify-fix turns, or the plan handoff, which don't route through
        // submit-prompt) stops a stale note like "taking auth.ts" from turn 1
        // leaking into an unrelated fan-out many turns later.
        this.#blackboard.clear();
        // Capture any armed plan handoff NOW and bind it to THIS prompt's job, so
        // it can't be stolen by an unrelated prompt that was queued ahead of it
        // (the flag used to be read at turn-run time — see #handlePrompt).
        const handoff = this.#pendingHandoff;
        this.#pendingHandoff = false;
        if (handoff) void this.#persistEngineState();
        this.#enqueue(queueLabel(command.text), () =>
          this.#handlePrompt(command.text, { handoff }),
        );
        break;
      }
      case "set-mode": {
        // Leaving plan mode for execute right after a presented plan = approval:
        // arm a handoff so the next turn proceeds against the plan.
        const approvingPlan =
          this.#session.mode === "plan" && command.mode === "execute" && this.#lastPlan !== undefined;
        this.#session.setMode(command.mode);
        // Requesting a mode ALWAYS lands in the gated baseline (approvals →
        // ask, `always` grants forgotten) — an ENGINE-owned invariant, not a UI
        // courtesy. Every client (typed /plan → /execute, Shift+Tab, scripts
        // embedding the engine) leaves plan in gated EXECUTE, never inheriting
        // a lingering `auto` from a prior YOLO; and an explicit re-request of
        // the current mode re-arms the gate. Deliberate YOLO is a
        // `set-approvals auto` sent AFTER this (exactly what the TUI's yolo
        // target does), so it survives.
        handleApprovals(this.#getCommandHandle(), "ask", true);
        if (approvingPlan) {
          this.#pendingHandoff = true;
          // Persist the armed handoff so quitting between approval and the next
          // prompt doesn't drop the approval on --resume.
          void this.#persistEngineState();
          // Without this, approving by mode-switch is silent and the user
          // doesn't know the plan is armed but NOT yet running (unlike the plan
          // card's accept, which starts immediately).
          this.#bus.emit({
            type: "notice",
            level: "info",
            message: "Plan approved — your next message starts implementation.",
          });
        } else if (command.mode === "plan" && this.#pendingHandoff) {
          // Returning to plan mode revokes a pending approval: a handoff that
          // survived into plan would prepend "proceed with implementing it now"
          // to a read-only turn — a directive the mode can't honor.
          this.#pendingHandoff = false;
          void this.#persistEngineState();
        }
        break;
      }
      case "set-approvals":
        // Immediate (not queued), mirroring set-mode — the mode toggle must
        // take effect at once so the next turn sees the new approval policy.
        // Quiet only when the sender says so (the Shift+Tab cycle, where the
        // mode chip is the feedback); a typed `/approvals <v>` gets its confirm.
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
        this.#session.setGoal(command.goal);
        break;
      case "abort":
        // Drop everything still waiting, then cancel the in-flight turn — which
        // may be a loop iteration running on an ephemeral session (`#loopSession`
        // is set only for the duration of that iteration), not the main session.
        if (this.#pending.length) {
          this.#pending = [];
          this.#emitQueue();
        }
        // Resolve any on-screen permission prompt as `deny` so the cancelled
        // tool doesn't run — and so a stale card, if clicked later, can't fulfil
        // an already-settled promise and slip a side-effecting call past the
        // abort. (Without this the pending map was only cleared at finalize.)
        for (const resolve of this.#pendingPermissions.values()) resolve("deny");
        this.#pendingPermissions.clear();
        (this.#loopSession ?? this.#session).abort();
        break;
      case "dequeue": {
        // Remove one waiting prompt without running it (cancel a queued item).
        const before = this.#pending.length;
        this.#pending = this.#pending.filter((p) => p.id !== command.id);
        if (this.#pending.length !== before) this.#emitQueue();
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
        // than wait behind the work it is meant to describe.
        if (command.name === "queue") this.#handleQueueCommand(command.args);
        else
          this.#enqueue(`/${command.name}`, () =>
            this.#handleSlash(command.name, command.args),
          );
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
        this.#resolvePlan(command.decision, command.edit);
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
    const id = createId("perm");
    const reply = await new Promise<{ decision: "once" | "always" | "deny"; feedback?: string }>(
      (resolve) => {
        this.#pendingPermissions.set(id, (decision, feedback) => resolve({ decision, feedback }));
        this.#bus.emit({
          type: "permission-request",
          sessionId: this.#session.id,
          id,
          toolName: req.toolName,
          input: req.input,
        });
      },
    );
    if (reply.decision === "always") this.#alwaysAllow.add(key);
    if (reply.decision !== "deny") return true;
    // A denial with typed feedback travels to the model as the deny reason —
    // "denied by user — use staging instead" steers; a bare denial just blocks.
    return { allowed: false, ...(reply.feedback ? { feedback: reply.feedback } : {}) };
  }

  /** Memory key for an `always`-allow decision: tool name plus its content scope
   * (command/path/url) so "always" is remembered for THIS call shape, not the
   * whole tool. `\x00` can't appear in a tool name or scope, so it's an
   * unambiguous separator. */
  #alwaysAllowKey(toolName: string, input: unknown): string {
    const scope = scopeString(toolName, input);
    return scope === undefined ? toolName : `${toolName}\x00${scope}`;
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
      const dropped = this.#pending.length;
      if (dropped) {
        this.#pending = [];
        this.#emitQueue();
      }
      this.#notice(
        dropped ? `Cleared ${dropped} queued item(s).` : "Queue is already empty.",
      );
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
   * "relevant past context" block. Best-effort and bounded; never throws. */
  async #maybeProactiveRecall(prompt: string): Promise<void> {
    if (this.#proactiveRecallDone) return;
    if (!this.#config.memory.proactiveRecall || !this.#memory) return;
    this.#proactiveRecallDone = true;
    try {
      const seed = [this.#session.goal, prompt].filter(Boolean).join(" ").slice(0, 500);
      if (!seed.trim()) return;
      const hits = await this.#memory.search(seed, 3);
      if (!hits.length) return;
      const block = hits
        .map((h) => `- ${h.text.replace(/\s+/g, " ").trim().slice(0, 300)}`)
        .join("\n");
      this.#session.setRecalledContext(block);
      this.#notice(`Recalled ${hits.length} relevant note(s) from long-term memory.`, "info");
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

  /** Build an ephemeral session sharing infra but with a fresh context. */
  #buildSession(): Session {
    return new Session({
      config: this.#config,
      registry: this.registry,
      toolset: this.toolset,
      bus: this.#bus,
      cwd: this.#cwd,
      model: this.#session.model,
      mode: this.#session.mode,
      goal: this.#session.goal,
      projectMemory: this.#projectMemory,
      permissionResolver: this.#permissionResolver,
      agents: this.#agents,
      fileLock: this.#fileLock,
      limiter: this.#limiter,
      blackboard: this.#blackboard,
      skills: this.skills,
      hooks: this.hooks,
      ...(this.#memory ? { memory: this.#memory } : {}),
      getContextWindow: (model) => this.#resolveContextWindow(model),
      getPricing: (model) => this.#resolvePricing(model),
    });
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
      }
    }
    // Route the iteration through the same FIFO queue as user turns so a loop
    // tick never executes concurrently with a user prompt (which would race
    // file writes and interleave output). `#loopSession` is exposed so `/loop
    // stop` / shutdown can abort the turn that's actually in flight.
    return new Promise<string>((resolve, reject) => {
      this.#enqueue(`loop: ${queueLabel(text)}`, async () => {
        const session = this.#buildSession();
        this.#loopSession = session;
        try {
          await session.run(text);
          resolve(session.lastAssistantText());
        } catch (err) {
          // Without this reject, a job that throws before resolve() would leave
          // the LoopController awaiting forever — a silent, permanent hang.
          reject(err as Error);
        } finally {
          this.#loopSession = undefined;
        }
      });
    });
  }

  /** Evaluate a loop's --until condition with a cheap structured call. Rides
   * the same resilience rails as every other provider call — retry on
   * transients, the tree-global limiter, and a hard deadline so a wedged
   * provider can't stall the loop forever (it used to have none of these). */
  async #evaluateCondition(
    result: string,
    condition: string,
  ): Promise<{ done: boolean; reason: string }> {
    const model = await withRetry(
      () => this.registry.resolveModel(this.#session.model, this.#config),
      { maxAttempts: this.#config.retry.maxAttempts, baseDelayMs: this.#config.retry.baseDelayMs },
    );
    const { object } = await this.#limiter.run(
      () =>
        generateObject({
          model,
          schema: z.object({ done: z.boolean(), reason: z.string() }),
          abortSignal: AbortSignal.timeout(60_000),
          maxRetries: this.#config.retry.maxAttempts,
          prompt:
            `You are checking whether a stop condition has been satisfied.\n` +
            `Condition: ${condition}\n\nMost recent result:\n${result}\n\n` +
            `Return done=true only if the condition is clearly satisfied.`,
        }),
      AbortSignal.timeout(90_000),
    );
    return object;
  }

  /**
   * Resolve a model's price (USD per 1M tokens). A config `pricing[model]`
   * override wins; otherwise fall back to the live catalog. A partial override
   * (e.g. only `input`) is completed from the catalog.
   */
  async #resolvePricing(
    model: string,
  ): Promise<(ModelPrice & { estimated?: boolean }) | undefined> {
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
    const clean = name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
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

  /** Handle a built-in or plugin/file slash command. */
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
      notice: (message, level) => engine.#notice(message, level),
      emit: (event) => engine.#bus.emit(event),
      send: (command) => engine.send(command),
      clearAlwaysAllow: () => engine.#alwaysAllow.clear(),
      persistConfig: (patch) => engine.#persistConfig(patch),
      handlePrompt: (text, opts) => engine.#handlePrompt(text, opts),
      resetTurnBudgets: () => engine.#resetPromptBudgets(),
      runVerifyCommand: (command) => engine.#runVerifyCommand(command),
      refreshProjectMemory: () => engine.#refreshProjectMemory(),
      createAgent: (name) => engine.#createAgent(name),
      handleLoop: (args) => engine.#handleLoop(args),
      listModels: () => engine.listModels(),
      resolveContextWindow: (model) => engine.#resolveContextWindow(model),
      resolvePricing: (model) => engine.#resolvePricing(model),
      mcpStatus: () => engine.#mcp.status(),
      git: (args) => engine.#git(args),
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
    const parsed = parseLoopArgs(args);
    if (!parsed) {
      this.#notice(
        "Usage: /loop [interval] <prompt|/command> [--until <condition>] [--max N]",
        "warn",
      );
      return;
    }
    const loop = new LoopController({
      id: createId("loop"),
      ...parsed,
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
    this.#notice(
      `Loop started (every ${Math.round(parsed.intervalMs / 1000)}s)` +
        (parsed.until ? `, until: ${parsed.until}` : "") +
        (parsed.max ? `, max ${parsed.max}` : "") +
        ". Run /loop stop to cancel.",
    );
  }

  /**
   * Append a unit of work to the queue and ensure the drainer is running.
   * Work runs strictly one at a time (FIFO) so history stays consistent; extra
   * prompts submitted while busy become a visible, cancelable backlog.
   */
  #enqueue(label: string, run: () => Promise<void>): void {
    this.#pending.push({ id: createId("q"), label, run });
    // Only surface the queue when something is actually waiting behind active
    // work; a lone item drains immediately and would otherwise just flicker.
    if (this.#draining) this.#emitQueue();
    void this.#drain();
  }

  /** Run queued work to completion, emitting queue state as it changes. */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
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
    this.#draining = false;
    // The queue is fully drained — the prompt AND every follow-up turn it spawned
    // (gate-fix / review-fix / verify-fix) are done. Signal the true terminal
    // point so a headless one-shot stops HERE, not on the first per-turn
    // `session-idle` (which would cut off follow-up output and race finalize()).
    this.#bus.emit({ type: "engine-idle", sessionId: this.#session.id });
    void this.hooks.run("session.idle", { sessionId: this.#session.id });
    for (const resolve of this.#idleResolvers.splice(0)) resolve();
  }

  async #handlePrompt(text: string, opts: { handoff?: boolean } = {}): Promise<void> {
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
      this.#lastPlan = undefined;
      // Consume the persisted plan too, so --resume can't resurrect an
      // already-executed plan and re-fire its handoff (the plan file otherwise
      // repopulates #lastPlan on restore, re-arming a spent approval).
      void this.#discardPersistedPlan();
      text =
        "The plan you presented was approved by the user — proceed with implementing it " +
        `now (your earlier "stop here" no longer applies).${text.trim() ? `\n\n${text}` : ""}`;
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
    const hooked = await this.hooks.run("user.prompt.submit", { text });
    // Proactive recall (opt-in): once per session, seed a "relevant past context"
    // block from long-term memory using the first prompt + goal, injected into
    // the system prompt. Best-effort — a failure must not block the turn.
    await this.#maybeProactiveRecall(hooked.text);
    // Expand `@file` mentions: text files become context blocks, images become
    // attachments for vision models. Unresolvable mentions pass through.
    const expanded = await expandMentions(hooked.text, this.#cwd);
    for (const note of expanded.notices) this.#notice(note, "info");
    if (expanded.images.length) {
      const ok = await this.#supportsImages(this.#session.model);
      if (ok === false) {
        this.#notice(
          `${this.#session.model} may not accept image input; sending anyway.`,
          "warn",
        );
      }
    }
    await this.#session.run(expanded.text, expanded.images, isHandoff ? { display: null } : {});
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
    const build = this.#config.build;
    if (!(build.enabled && build.gate.enabled)) {
      // Build intelligence off (or gate disabled): legacy verify behavior verbatim.
      await this.#maybeVerify();
      return;
    }
    // The gate runs on the same terms the legacy verify did: only after a
    // mutating execute turn the user didn't interrupt. (/loop iterations run on
    // an ephemeral session and never route through #handlePrompt, so they never
    // reach the gate — inherited from this call site.)
    if (!this.#turnIsGateable()) return;

    const profile = this.#session.repoProfile;
    const runnable = profile ? pickChecks(profile, build.gate.checks) : [];
    if (!profile || !runnable.length) {
      // No trustworthy check command for the gate. Fall back to a configured
      // legacy verify command if one exists (recon fills verify.command); only
      // when NOTHING machine-verified the work do we say so — never silently green.
      const verified = await this.#maybeVerify();
      if (!verified) {
        this.#notice(
          "Gate: UNVERIFIED — no build/test command detected, so this turn's work was not machine-verified.",
          "info",
        );
      }
      return;
    }
    await this.#runGate(profile);
  }

  /** Reset every per-user-prompt budget + the diff-review baseline. Called once
   * at the start of a genuine user-initiated prompt (typed submit-prompt, or a
   * slash command that expands into a prompt) — NEVER by an engine-internal fix
   * turn (gate-fix / review-fix / verify-fix), so the "bounded per user prompt"
   * invariant holds and a fix cycle can't reset its own budget mid-flight. */
  #resetPromptBudgets(): void {
    this.#verifyAttempts = 0;
    this.#gateRounds = 0;
    this.#reviewRounds = 0;
    this.#promptBaselineId = undefined;
  }

  /** The shared gating for post-turn verification: a mutating execute turn the
   * user didn't interrupt (matches the legacy `#maybeVerify` guards). */
  #turnIsGateable(): boolean {
    return (
      this.#session.mode === "execute" &&
      this.#session.didMutate &&
      !this.#session.interrupted
    );
  }

  /**
   * Run the real green-gate once against the (quiescent) tree, then act on the
   * outcome: RED enqueues ONE bounded fix turn (formatGateFailure), GREEN commits
   * on green + runs the adversarial diff review, UNVERIFIED just notices honestly.
   */
  async #runGate(profile: RepoProfile): Promise<void> {
    const gate = this.#config.build.gate;
    const summary = await runGate(this.#cwd, profile, this.#gateRounds, {
      checks: gate.checks,
      timeoutSec: gate.timeoutSec,
      // Thread the session's abort signal so an Esc during a long gate build
      // stops it between (and, via exec, during) checks — otherwise the only
      // bound was the per-check timeout (default 600s × N checks), wedging the
      // queue unabortably.
      signal: this.#session.abortSignal,
    });
    if (summary.outcome === "unverified") {
      // pickChecks found commands but the gate produced no verdict (every check
      // aborted / no output) — still honest, never green.
      this.#notice(formatGateOutcome(summary), "info");
      return;
    }
    if (summary.outcome === "red") {
      if (this.#gateRounds >= gate.maxRounds) {
        this.#notice(
          `${formatGateOutcome(summary)} — still red after ${gate.maxRounds} fix round(s); stopping.`,
          "warn",
        );
        return;
      }
      this.#gateRounds += 1;
      this.#notice(formatGateOutcome(summary), "warn");
      this.#enqueue("gate-fix", () =>
        this.#handlePrompt(formatGateFailure(summary, gate.maxRounds)),
      );
      return;
    }
    // GREEN.
    this.#notice(formatGateOutcome(summary), "info");
    this.#persistGreenLedger(profile);
    await this.#commitOnGreen(summary);
    // Runtime visual verification (web apps only): boot the app headless and
    // find what green checks can't — console errors + dead controls. Its
    // findings ride the SAME adversarial-review fix budget as the diff review.
    const visual = await this.#maybeVisualVerify(profile);
    await this.#maybeReview(visual);
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
    const hasFindings = result.ran && (result.consoleErrors.length > 0 || result.deadControls.length > 0);
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
      for (const file of listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
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
          });
          if (!isReviewClean(text)) reviewFlagged = text;
        } catch {
          if (!visualFindings) return; // best-effort — bow out unless runtime findings exist
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
    this.#enqueue("review-fix", () =>
      this.#handlePrompt(buildReviewFixPrompt(reviewFlagged, visualFindings)),
    );
  }

  /**
   * Auto-verify (legacy path): after an edit turn, run the verify command; on
   * failure, feed the output back as a follow-up so the agent self-corrects
   * (capped retries). Returns whether the command actually RAN — so the gate path
   * can tell "machine-verified by a legacy command" from "nothing checked it".
   */
  async #maybeVerify(): Promise<boolean> {
    const { command, auto, maxRetries } = this.#config.verify;
    if (!auto || !command) return false;
    if (this.#session.mode !== "execute" || !this.#session.didMutate) return false;
    // The user interrupted this turn (Esc / steer) — don't run verify against a
    // half-applied edit and enqueue an unsolicited "verification failed, fix it"
    // turn behind whatever they steered to.
    if (this.#session.interrupted) return false;

    const result = await this.#runVerifyCommand(command);
    if (result.ok) return true;
    if (this.#verifyAttempts >= maxRetries) {
      this.#notice(
        `Verification still failing after ${maxRetries} attempt(s); stopping auto-fix.`,
        "warn",
      );
      return true;
    }
    this.#verifyAttempts += 1;
    this.#enqueue("verify-fix", () =>
      this.#handlePrompt(
        `The verification command \`${command}\` failed:\n\n${result.output}\n\n` +
          `Fix the cause and keep changes minimal.`,
      ),
    );
    return true;
  }

  /** Run the verify command, emitting start/finish events. */
  async #runVerifyCommand(command: string): Promise<{ ok: boolean; output: string }> {
    this.#bus.emit({ type: "verify-started", command });
    const result = await runVerify(this.#cwd, command);
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
