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

  /** Import and register each plugin module specifier (npm name or path).
   * `timeoutMs` bounds each plugin's register() (default 15s); exposed mainly for
   * tests. */
  async load(specifiers: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
    const deadline = opts.timeoutMs ?? PLUGIN_REGISTER_TIMEOUT_MS;
    // BUG-071: reloading the same plugins must not double-register hooks.
    // Clear hook handlers once at the start of a load batch (commands overwrite
    // by name already; tools refuse shadowing).
    if (specifiers.length) this.#deps.hooks.clear();
    for (const spec of specifiers) {
      // BUG-070: track registrations for this plugin so a timed-out register()
      // can roll back partial wiring.
      const registeredCommands: string[] = [];
      const registeredTools: string[] = [];
      const hookSnap = snapshotHooks(this.#deps.hooks);
      const api: PluginApi = {
        registerTool: (def) => {
          registeredTools.push(def.name);
          this.#deps.registerTool(def);
        },
        registerProvider: this.#deps.registerProvider,
        registerCommand: (cmd) => {
          registeredCommands.push(cmd.name);
          this.#deps.commands.register(cmd);
        },
        addSkillDir: this.#deps.addSkillDir,
        hooks: this.#deps.hooks,
        logger: this.#log,
      };
      try {
        const mod = (await withTimeout(
          import(spec),
          deadline,
          `plugin ${spec} import timed out`,
        )) as { default?: Plugin } & Partial<Plugin>;
        const plugin = mod.default ?? (mod as Plugin);
        if (typeof plugin.register === "function") {
          await withTimeout(
            Promise.resolve(plugin.register(api)),
            deadline,
            `plugin ${spec} register() timed out`,
          );
          this.#log.info(`loaded plugin ${spec}`);
        } else {
          this.#log.warn(`plugin ${spec} has no register()`);
        }
      } catch (err) {
        // Roll back partial register work from a timed-out/hung plugin.
        restoreHooks(this.#deps.hooks, hookSnap);
        for (const name of registeredCommands) {
          this.#deps.commands.unregister(name);
        }
        this.#log.error(`failed to load plugin ${spec}: ${(err as Error).message}`);
      }
    }
  }
}

/** Capture handler lists so a failed register can restore (BUG-070). */
function snapshotHooks(hooks: HookBus): Map<string, number> {
  const names = [
    "session.start",
    "user.prompt.submit",
    "tool.before.execute",
    "tool.after.execute",
    "step.finish",
    "assistant.message",
    "session.idle",
    "session.end",
  ] as const;
  const snap = new Map<string, number>();
  for (const n of names) snap.set(n, hooks.handlerCount(n));
  return snap;
}

function restoreHooks(hooks: HookBus, snap: Map<string, number>): void {
  // If counts grew during a partial register, clear all and accept loss of
  // earlier plugins' hooks in this batch — load() clears at batch start, so
  // only this batch's hooks exist. Full clear is the safe rollback.
  let grew = false;
  for (const [name, n] of snap) {
    if (hooks.handlerCount(name as never) > n) {
      grew = true;
      break;
    }
  }
  if (grew) hooks.clear();
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
