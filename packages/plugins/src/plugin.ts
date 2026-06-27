import { createLogger, type Logger, type ToolDefinition } from "@vibe/shared";
import type { ProviderDef } from "@vibe/providers";
import type { HookBus } from "./hooks.ts";
import type { CommandRegistry, SlashCommand } from "./commands.ts";
import type { SkillRegistry } from "./skills.ts";

/** Surface handed to a plugin's `register(api)` entrypoint. */
export interface PluginApi {
  registerTool(def: ToolDefinition): void;
  registerProvider(def: ProviderDef): void;
  registerCommand(cmd: SlashCommand): void;
  addSkillDir(path: string): void;
  hooks: HookBus;
  logger: Logger;
}

/** A plugin module exports `register`. */
export interface Plugin {
  register(api: PluginApi): void | Promise<void>;
}

export interface PluginHostDeps {
  hooks: HookBus;
  commands: CommandRegistry;
  skills: SkillRegistry;
  registerTool: (def: ToolDefinition) => void;
  registerProvider: (def: ProviderDef) => void;
  addSkillDir: (path: string) => void;
  logger?: Logger;
}

/**
 * Loads plugin modules and wires them to the host registries. Plugins run
 * in-process for v1. Failures are logged and skipped, never fatal.
 */
export class PluginHost {
  #deps: PluginHostDeps;
  #log: Logger;

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? createLogger("plugins");
  }

  #api(): PluginApi {
    return {
      registerTool: this.#deps.registerTool,
      registerProvider: this.#deps.registerProvider,
      registerCommand: (cmd) => this.#deps.commands.register(cmd),
      addSkillDir: this.#deps.addSkillDir,
      hooks: this.#deps.hooks,
      logger: this.#log,
    };
  }

  /** Import and register each plugin module specifier (npm name or path). */
  async load(specifiers: string[]): Promise<void> {
    for (const spec of specifiers) {
      try {
        const mod = (await import(spec)) as { default?: Plugin } & Partial<Plugin>;
        const plugin = mod.default ?? (mod as Plugin);
        if (typeof plugin.register === "function") {
          await plugin.register(this.#api());
          this.#log.info(`loaded plugin ${spec}`);
        } else {
          this.#log.warn(`plugin ${spec} has no register()`);
        }
      } catch (err) {
        this.#log.error(`failed to load plugin ${spec}: ${(err as Error).message}`);
      }
    }
  }
}
