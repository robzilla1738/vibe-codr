import {
  createLogger,
  type EngineClient,
  type EngineCommand,
  type EngineSnapshot,
  type Logger,
  type UIEvent,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import {
  ProviderRegistry,
  CatalogService,
  type ModelInfo,
} from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import {
  HookBus,
  CommandRegistry,
  SkillRegistry,
  PluginHost,
} from "@vibe/plugins";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { helpText, formatModelList, initProject } from "./commands.ts";
import type { PermissionResolver } from "./permissions.ts";
import { loadAgents, type NamedAgent } from "./agents.ts";
import { loadCommandFiles, loadSkills, loadSkillsFrom } from "./loaders.ts";

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
  #queue: Promise<void> = Promise.resolve();
  #agents = new Map<string, NamedAgent>();

  constructor(opts: EngineOptions) {
    this.#config = opts.config;
    this.#cwd = opts.cwd ?? process.cwd();
    this.registry = opts.registry ?? new ProviderRegistry();
    this.toolset = opts.toolset ?? new Toolset();
    this.hooks = opts.hooks ?? new HookBus();
    this.commands = opts.commands ?? new CommandRegistry();
    this.skills = opts.skills ?? new SkillRegistry();
    this.catalog = opts.catalog ?? new CatalogService();
    this.#log = opts.logger ?? createLogger("engine");
    this.#session = new Session({
      config: opts.config,
      registry: this.registry,
      toolset: this.toolset,
      bus: this.#bus,
      cwd: this.#cwd,
      model: opts.config.model,
      mode: opts.config.mode,
      projectMemory: opts.projectMemory,
      permissionResolver: opts.permissionResolver,
      agents: this.#agents,
      skills: this.skills,
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
  }

  events(): AsyncIterable<UIEvent> {
    return this.#bus.subscribe();
  }

  snapshot(): EngineSnapshot {
    return this.#session.snapshot();
  }

  /** Resolves when the queued commands (prompts, slashes) have drained. */
  whenIdle(): Promise<void> {
    return this.#queue;
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
        this.#enqueue(() => this.#handlePrompt(command.text));
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
        this.#session.abort();
        break;
      case "run-slash":
        this.#enqueue(() => this.#handleSlash(command.name, command.args));
        break;
      case "compact":
        this.#bus.emit({
          type: "notice",
          level: "info",
          message: "Compaction is not implemented yet.",
        });
        break;
      case "shutdown":
        this.#bus.close();
        break;
    }
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
      if (result.kind === "prompt") await this.#session.run(result.text);
      else if (result.kind === "command") this.send(result.command);
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
        this.#session.clear();
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

  /** Run prompts one at a time to keep history consistent. */
  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((err) => {
      this.#log.error("turn failed", err);
      this.#bus.emit({
        type: "engine-error",
        sessionId: this.#session.id,
        message: (err as Error).message,
      });
    });
  }

  async #handlePrompt(text: string): Promise<void> {
    const hooked = await this.hooks.run("user.prompt.submit", { text });
    await this.#session.run(hooked.text);
  }
}
