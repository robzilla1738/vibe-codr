import { generateObject } from "ai";
import { z } from "zod";
import {
  createId,
  createLogger,
  type EngineClient,
  type EngineCommand,
  type EngineSnapshot,
  type Logger,
  type QueuedItem,
  type UIEvent,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import {
  ProviderRegistry,
  CatalogService,
  type ModelInfo,
} from "@vibe/providers";
import { Toolset, builtinTools } from "@vibe/tools";
import type { ModelPrice } from "@vibe/config";
import {
  HookBus,
  CommandRegistry,
  SkillRegistry,
  PluginHost,
  parseSlash,
} from "@vibe/plugins";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { helpText, formatModelList, initProject } from "./commands.ts";
import {
  formatStatus,
  formatCost,
  formatConfig,
  formatTools,
  formatMcp,
  formatPermissions,
  formatNamedList,
} from "./introspect.ts";
import type { PermissionResolver } from "./permissions.ts";
import { loadAgents, type NamedAgent } from "./agents.ts";
import { loadCommandFiles, loadSkills, loadSkillsFrom } from "./loaders.ts";
import { LoopController, parseLoopArgs } from "./loop.ts";
import { SessionStore, type PersistedSession } from "./store.ts";
import { CheckpointManager } from "./checkpoints.ts";
import { McpHub, type McpConnect } from "./mcp.ts";
import { runVerify } from "./verify.ts";
import { expandMentions } from "./mentions.ts";

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
  #config: Config;
  #cwd: string;
  #session: Session;
  #log: Logger;
  #pending: { id: string; label: string; run: () => Promise<void> }[] = [];
  #active: QueuedItem | null = null;
  #draining = false;
  #idleResolvers: (() => void)[] = [];
  #agents = new Map<string, NamedAgent>();
  #loop: LoopController | undefined;
  #permissionResolver: PermissionResolver | undefined;
  #interactive: boolean;
  #alwaysAllow = new Set<string>();
  #pendingPermissions = new Map<string, (d: "once" | "always" | "deny") => void>();
  #store: SessionStore;
  #checkpoints: CheckpointManager;
  #mcp: McpHub;
  #verifyAttempts = 0;

  constructor(opts: EngineOptions) {
    this.#config = opts.config;
    this.#cwd = opts.cwd ?? process.cwd();
    this.#interactive = opts.interactive ?? false;
    // Use the caller's resolver if given (tests); otherwise bridge `ask`
    // decisions to the UI via permission-request / resolve-permission.
    this.#permissionResolver =
      opts.permissionResolver ?? ((req) => this.#askPermission(req));
    this.#store = new SessionStore(this.#cwd);
    this.#checkpoints = new CheckpointManager(this.#cwd);
    this.#mcp = new McpHub({
      registerTool: (def) => this.toolset.register(def),
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
        }),
      );
    this.hooks = opts.hooks ?? new HookBus();
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
      model: resume?.meta.model ?? opts.config.model,
      mode: resume?.meta.mode ?? opts.config.mode,
      goal: resume?.meta.goal ?? null,
      projectMemory: opts.projectMemory,
      permissionResolver: this.#permissionResolver,
      agents: this.#agents,
      skills: this.skills,
      store: this.#store,
      getContextWindow: (model) => this.catalog.contextWindow(model),
      getPricing: (model) => this.#resolvePricing(model),
      ...(resume
        ? {
            id: resume.meta.id,
            createdAt: resume.meta.createdAt,
            initialModelMessages: resume.modelMessages,
            initialHistory: resume.history,
            ...(resume.meta.tasks ? { initialTasks: resume.meta.tasks } : {}),
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

    // Connect MCP servers last so their tools join the same registry.
    await this.#mcp.start(this.#config.mcp.servers);
  }

  events(): AsyncIterable<UIEvent> {
    return this.#bus.subscribe();
  }

  snapshot(): EngineSnapshot {
    return this.#session.snapshot();
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
  }

  send(command: EngineCommand): void {
    switch (command.type) {
      case "submit-prompt":
        // A fresh user prompt resets the auto-verify retry budget.
        this.#verifyAttempts = 0;
        this.#enqueue(queueLabel(command.text), () =>
          this.#handlePrompt(command.text),
        );
        break;
      case "set-mode":
        this.#session.setMode(command.mode);
        break;
      case "set-model":
        this.#session.setModel(command.model);
        break;
      case "set-goal":
        this.#session.setGoal(command.goal);
        break;
      case "abort":
        // Drop everything still waiting, then cancel the in-flight turn.
        if (this.#pending.length) {
          this.#pending = [];
          this.#emitQueue();
        }
        this.#session.abort();
        break;
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
          resolve(command.decision);
        }
        break;
      }
      case "shutdown":
        this.#loop?.stop("shutdown");
        // Unblock any in-flight permission prompts so nothing hangs.
        for (const resolve of this.#pendingPermissions.values()) resolve("deny");
        this.#pendingPermissions.clear();
        void this.#mcp.close();
        this.#bus.close();
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
  }): Promise<boolean> {
    if (!this.#interactive) return true;
    if (this.#alwaysAllow.has(req.toolName)) return true;
    const id = createId("perm");
    const decision = await new Promise<"once" | "always" | "deny">((resolve) => {
      this.#pendingPermissions.set(id, resolve);
      this.#bus.emit({
        type: "permission-request",
        sessionId: this.#session.id,
        id,
        toolName: req.toolName,
        input: req.input,
      });
    });
    if (decision === "always") this.#alwaysAllow.add(req.toolName);
    return decision !== "deny";
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
      permissionResolver: this.#permissionResolver,
      agents: this.#agents,
      skills: this.skills,
      getContextWindow: (model) => this.catalog.contextWindow(model),
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
    const session = this.#buildSession();
    await session.run(text);
    return session.lastAssistantText();
  }

  /** Evaluate a loop's --until condition with a cheap structured call. */
  async #evaluateCondition(
    result: string,
    condition: string,
  ): Promise<{ done: boolean; reason: string }> {
    const model = await this.registry.resolveModel(
      this.#session.model,
      this.#config,
    );
    const { object } = await generateObject({
      model,
      schema: z.object({ done: z.boolean(), reason: z.string() }),
      prompt:
        `You are checking whether a stop condition has been satisfied.\n` +
        `Condition: ${condition}\n\nMost recent result:\n${result}\n\n` +
        `Return done=true only if the condition is clearly satisfied.`,
    });
    return object;
  }

  /**
   * Resolve a model's price (USD per 1M tokens). A config `pricing[model]`
   * override wins; otherwise fall back to the live catalog. A partial override
   * (e.g. only `input`) is completed from the catalog.
   */
  async #resolvePricing(model: string): Promise<ModelPrice | undefined> {
    const override = this.#config.pricing[model];
    if (override?.input !== undefined && override?.output !== undefined) {
      return override;
    }
    const catalog = await this.catalog.pricing(model);
    if (!override) return catalog;
    return {
      input: override.input ?? catalog?.input,
      output: override.output ?? catalog?.output,
    };
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

  #notice(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.#bus.emit({ type: "notice", level, message });
  }

  /** Handle a built-in or plugin/file slash command. */
  async #handleSlash(name: string, args: string): Promise<void> {
    // Plugin/file commands take precedence over built-ins of the same name.
    const custom = this.commands.get(name);
    if (custom) {
      const result = custom.run(args);
      if (result.kind === "prompt") {
        // Treat an expanded command like a user prompt: checkpoint, hooks,
        // and auto-verify all apply, and it starts a fresh verify budget.
        this.#verifyAttempts = 0;
        await this.#handlePrompt(result.text);
      } else if (result.kind === "command") this.send(result.command);
      else this.#notice(result.message);
      return;
    }

    switch (name) {
      case "help":
        this.#notice(helpText(this.commands.list()));
        break;
      case "model":
        if (args) this.#session.setModel(args);
        else this.#notice(`Current model: ${this.#session.model}`);
        break;
      case "models": {
        this.#notice("Fetching models…");
        this.#notice(formatModelList(await this.listModels()));
        break;
      }
      case "plan":
        this.#session.setMode("plan");
        break;
      case "execute":
        this.#session.setMode("execute");
        break;
      case "goal":
        this.#session.setGoal(args || null);
        this.#notice(args ? `Goal set: ${args}` : "Goal cleared.");
        break;
      case "clear":
      case "new":
        this.#session.clear();
        this.#notice("Conversation cleared.");
        break;
      case "status":
        this.#notice(this.#statusText());
        break;
      case "cost":
        this.#notice(
          formatCost(
            this.#session.snapshot().usage,
            this.#session.model,
            await this.#resolvePricing(this.#session.model),
          ),
        );
        break;
      case "config":
        this.#notice(formatConfig(this.#config));
        break;
      case "tools":
        this.#notice(
          formatTools(this.toolset.forMode(this.#session.mode), this.#session.mode),
        );
        break;
      case "skills":
        this.#notice(
          formatNamedList(
            "Skills (call /<name> or the model uses use_skill):",
            this.skills.list().map((s) => ({ name: s.name, description: s.description })),
            "No skills. Add .vibe/skills/<name>/SKILL.md to define one.",
          ),
        );
        break;
      case "commands":
        this.#notice(
          formatNamedList(
            "Custom commands:",
            this.commands.list().map((c) => ({
              name: c.name,
              description: `${c.description} (${c.source})`,
            })),
            "No custom commands. Add .vibe/commands/<name>.md to define one.",
          ),
        );
        break;
      case "mcp":
        this.#notice(
          formatMcp(this.#mcp.status(), Object.keys(this.#config.mcp.servers)),
        );
        break;
      case "permissions":
        this.#notice(
          formatPermissions(this.#config.permissions, this.#config.approvalMode),
        );
        break;
      case "approvals":
        this.#handleApprovals(args);
        break;
      case "reasoning":
        this.#handleReasoning(args);
        break;
      case "theme":
        this.#handleTheme(args);
        break;
      case "diff":
        await this.#handleDiff();
        break;
      case "review":
        await this.#handleReview();
        break;
      case "resume":
        await this.#handleResume();
        break;
      case "exit":
      case "quit":
        this.#notice("Press Ctrl-C (or Ctrl-D) to exit.");
        break;
      case "agents":
        this.#notice(
          this.#agents.size
            ? [...this.#agents.values()]
                .map((a) => `  ${a.name} — ${a.description}`)
                .join("\n")
            : "No named agents. Add .vibe/agents/<name>.md to define one.",
        );
        break;
      case "loop":
        this.#handleLoop(args);
        break;
      case "undo":
        await this.#handleUndo();
        break;
      case "checkpoints":
        await this.#handleCheckpoints();
        break;
      case "verify":
        await this.#handleVerify();
        break;
      case "compact":
        this.send({ type: "compact" });
        break;
      case "init": {
        const created = await initProject(this.#cwd);
        this.#notice(
          created.length
            ? `Created: ${created.join(", ")}`
            : "Project already initialized.",
        );
        break;
      }
      default:
        this.#notice(`Unknown command: /${name}`, "warn");
    }
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
    for (const resolve of this.#idleResolvers.splice(0)) resolve();
  }

  async #handlePrompt(text: string): Promise<void> {
    // Snapshot the workspace before an edit turn so /undo can roll it back.
    if (this.#config.checkpoints.enabled && this.#session.mode === "execute") {
      const cp = await this.#checkpoints.snapshot(queueLabel(text));
      if (cp) {
        this.#bus.emit({ type: "checkpoint-created", id: cp.id, label: cp.label });
      }
    }
    const hooked = await this.hooks.run("user.prompt.submit", { text });
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
    await this.#session.run(expanded.text, expanded.images);
    await this.#maybeVerify();
  }

  /**
   * Auto-verify: after an edit turn, run the verify command; on failure, feed
   * the output back as a follow-up so the agent self-corrects (capped retries).
   */
  async #maybeVerify(): Promise<void> {
    const { command, auto, maxRetries } = this.#config.verify;
    if (!auto || !command) return;
    if (this.#session.mode !== "execute" || !this.#session.didMutate) return;

    const result = await this.#runVerifyCommand(command);
    if (result.ok) return;
    if (this.#verifyAttempts >= maxRetries) {
      this.#notice(
        `Verification still failing after ${maxRetries} attempt(s); stopping auto-fix.`,
        "warn",
      );
      return;
    }
    this.#verifyAttempts += 1;
    this.#enqueue("verify-fix", () =>
      this.#handlePrompt(
        `The verification command \`${command}\` failed:\n\n${result.output}\n\n` +
          `Fix the cause and keep changes minimal.`,
      ),
    );
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

  /** `/verify` — run the verify command on demand. */
  async #handleVerify(): Promise<void> {
    const command = this.#config.verify.command;
    if (!command) {
      this.#notice(
        'No verify command configured. Set `verify.command` (e.g. "bun run typecheck && bun test").',
        "warn",
      );
      return;
    }
    const result = await this.#runVerifyCommand(command);
    this.#notice(result.ok ? "Verification passed." : "Verification failed.");
  }

  /** `/undo` — restore the most recent checkpoint. */
  async #handleUndo(): Promise<void> {
    if (!(await this.#checkpoints.isGitRepo())) {
      this.#notice("Checkpoints need a git repository; nothing to undo.", "warn");
      return;
    }
    const cp = await this.#checkpoints.undo();
    if (!cp) {
      this.#notice("No checkpoint to undo.");
      return;
    }
    this.#bus.emit({ type: "checkpoint-restored", id: cp.id, label: cp.label });
    this.#notice(`Reverted to checkpoint: ${cp.label}`);
  }

  /** `/checkpoints` — list saved checkpoints. */
  async #handleCheckpoints(): Promise<void> {
    const list = await this.#checkpoints.list();
    this.#notice(
      list.length
        ? `Checkpoints (newest last):\n${list.map((c) => `  ${c.label}`).join("\n")}`
        : "No checkpoints yet. One is taken before each edit turn (git repos).",
    );
  }

  /** `/status` — render the live session overview. */
  #statusText(): string {
    const tools = this.toolset.all();
    return formatStatus({
      sessionId: this.#session.id,
      model: this.#session.model,
      mode: this.#session.mode,
      approvalMode: this.#config.approvalMode,
      goal: this.#session.goal,
      cwd: this.#cwd,
      toolCount: tools.length,
      readOnlyCount: tools.filter((t) => t.readOnly).length,
      mcpServerCount: Object.keys(this.#config.mcp.servers).length,
      skillCount: this.skills.list().length,
      commandCount: this.commands.list().length,
      agentCount: this.#agents.size,
      usage: this.#session.snapshot().usage,
    });
  }

  /** `/approvals [ask|auto]` — show or switch the default approval mode. */
  #handleApprovals(args: string): void {
    const next = args.trim().toLowerCase();
    if (!next) {
      this.#notice(`Approval mode: ${this.#config.approvalMode}. Use /approvals <ask|auto>.`);
      return;
    }
    if (next !== "ask" && next !== "auto") {
      this.#notice("Usage: /approvals <ask|auto>", "warn");
      return;
    }
    // Mutating the shared config object is picked up on the next turn, where the
    // PermissionChecker's default action is derived from approvalMode.
    this.#config.approvalMode = next;
    this.#notice(
      next === "auto"
        ? "Approval mode: auto — side-effecting tools run without prompting."
        : "Approval mode: ask — side-effecting tools prompt for approval.",
    );
  }

  /** `/reasoning [low|medium|high|off]` — show or set the reasoning effort. */
  #handleReasoning(args: string): void {
    const next = args.trim().toLowerCase();
    if (!next) {
      this.#notice(
        `Reasoning effort: ${this.#config.reasoning.effort ?? "default"}. Use /reasoning <low|medium|high|off>.`,
      );
      return;
    }
    if (next === "off" || next === "none") {
      delete this.#config.reasoning.effort;
      this.#notice("Reasoning effort cleared (provider default).");
      return;
    }
    if (next !== "low" && next !== "medium" && next !== "high") {
      this.#notice("Usage: /reasoning <low|medium|high|off>", "warn");
      return;
    }
    this.#config.reasoning.effort = next;
    this.#notice(`Reasoning effort: ${next}.`);
  }

  /** `/theme [name]` — show or set the UI theme. */
  #handleTheme(args: string): void {
    const next = args.trim();
    if (!next) {
      this.#notice(`Theme: ${this.#config.theme}. Use /theme <name> to change it.`);
      return;
    }
    this.#config.theme = next;
    this.#notice(`Theme set to "${next}".`);
  }

  /** `/diff` — show the working-tree diff (git). */
  async #handleDiff(): Promise<void> {
    if (!(await this.#checkpoints.isGitRepo())) {
      this.#notice("Not a git repository; nothing to diff.", "warn");
      return;
    }
    const out = await this.#git(["--no-pager", "diff", "--stat", "HEAD"]);
    const full = await this.#git(["--no-pager", "diff", "HEAD"]);
    const body = full.stdout.trim();
    if (!body) {
      this.#notice("No changes in the working tree.");
      return;
    }
    const capped =
      body.length > 8000 ? `${body.slice(0, 8000)}\n…(diff truncated)` : body;
    this.#notice(`${out.stdout.trim()}\n\n${capped}`);
  }

  /** `/review` — ask the model to review the current working-tree changes. */
  async #handleReview(): Promise<void> {
    if (!(await this.#checkpoints.isGitRepo())) {
      this.#notice("Not a git repository; nothing to review.", "warn");
      return;
    }
    const diff = (await this.#git(["--no-pager", "diff", "HEAD"])).stdout.trim();
    if (!diff) {
      this.#notice("No changes in the working tree to review.");
      return;
    }
    this.#verifyAttempts = 0;
    await this.#handlePrompt(
      "Review the current working-tree changes for correctness, bugs, missed edge " +
        "cases, and style consistency with the surrounding code. Be concrete and " +
        "cite file/line where possible. Here is the diff:\n\n```diff\n" +
        diff +
        "\n```",
    );
  }

  /** `/resume` — list saved sessions (resume one with `--resume <id>`). */
  async #handleResume(): Promise<void> {
    const metas = await this.#store.list();
    if (!metas.length) {
      this.#notice("No saved sessions yet.");
      return;
    }
    const lines = metas.slice(0, 20).map((m) => {
      const when = new Date(m.updatedAt).toISOString().replace("T", " ").slice(0, 16);
      const goal = m.goal ? ` — ${m.goal.slice(0, 50)}` : "";
      return `  ${m.id}  ${when}  ${m.model}${goal}`;
    });
    this.#notice(
      `Saved sessions (restart with \`vibecodr --resume <id>\`):\n${lines.join("\n")}`,
    );
  }

  /** Run a git command in the workspace, returning trimmed stdout/stderr. */
  async #git(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.#cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  }
}

/** A short one-line label for a queued prompt. */
function queueLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}
