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

  /** Import and register each plugin module specifier (npm name or path).
   * `timeoutMs` bounds each plugin's register() (default 15s); exposed mainly for
   * tests. */
  async load(specifiers: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
    const deadline = opts.timeoutMs ?? PLUGIN_REGISTER_TIMEOUT_MS;
    for (const spec of specifiers) {
      try {
        // Bound the import too, not just register(): a module with a hanging
        // top-level `await` would block boot BEFORE register() is ever reached
        // (bootstrap awaits load() before the TUI starts). A timeout is logged
        // and skipped, not fatal.
        const mod = (await withTimeout(
          import(spec),
          deadline,
          `plugin ${spec} import timed out`,
        )) as { default?: Plugin } & Partial<Plugin>;
        const plugin = mod.default ?? (mod as Plugin);
        if (typeof plugin.register === "function") {
          // Bound register() with a wall-clock deadline: a plugin whose
          // register() never resolves (or is pathologically slow) would otherwise
          // hang the entire CLI boot — bootstrap() awaits this before the TUI
          // starts. Matches the MCP hub's per-server connect timeout. A timeout is
          // logged and skipped, not fatal.
          await withTimeout(
            Promise.resolve(plugin.register(this.#api())),
            deadline,
            `plugin ${spec} register() timed out`,
          );
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

/** Per-plugin register() deadline (ms) so one hung plugin can't block CLI boot. */
export const PLUGIN_REGISTER_TIMEOUT_MS = 15_000;

/** Reject if `p` doesn't settle within `ms`. The pending `p` is abandoned (a
 * plugin that eventually resolves just logs late); boot proceeds regardless. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
