import {
  createLogger,
  type EngineClient,
  type EngineCommand,
  type EngineSnapshot,
  type Logger,
  type UIEvent,
} from "@vibe/shared";
import type { Config } from "@vibe/config";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { HookBus } from "@vibe/plugins";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";

export interface EngineOptions {
  config: Config;
  cwd?: string;
  registry?: ProviderRegistry;
  toolset?: Toolset;
  hooks?: HookBus;
  projectMemory?: string;
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

  #bus = new EventBus();
  #config: Config;
  #session: Session;
  #log: Logger;
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.#config = opts.config;
    this.registry = opts.registry ?? new ProviderRegistry();
    this.toolset = opts.toolset ?? new Toolset();
    this.hooks = opts.hooks ?? new HookBus();
    this.#log = opts.logger ?? createLogger("engine");
    this.#session = new Session({
      config: opts.config,
      registry: this.registry,
      toolset: this.toolset,
      bus: this.#bus,
      cwd: opts.cwd ?? process.cwd(),
      model: opts.config.model,
      mode: opts.config.mode,
      projectMemory: opts.projectMemory,
    });
  }

  events(): AsyncIterable<UIEvent> {
    return this.#bus.subscribe();
  }

  snapshot(): EngineSnapshot {
    return this.#session.snapshot();
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
        this.#bus.emit({
          type: "notice",
          level: "warn",
          message: `Unknown command: /${command.name}`,
        });
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
