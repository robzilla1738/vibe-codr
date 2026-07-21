import { createLogger, type Logger, type ToolDefinition } from "@vibe/shared";
import type { ProviderDef } from "@vibe/providers";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookBus, HookName } from "./hooks.ts";
import type { CommandRegistry, SlashCommand } from "./commands.ts";
import type { SkillRegistry } from "./skills.ts";
import {
  PLUGIN_CONTRIBUTION_TYPES,
  manifestCompatibilityError,
  parsePluginManifest,
  type PluginContributionType,
  type PluginManifestV1,
} from "./manifest.ts";
import { PluginWorkerClient } from "./worker-client.ts";
import type { JsonValue } from "./worker-protocol.ts";

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

export interface PluginStatus {
  specifier: string;
  name: string;
  version?: string;
  status: "loaded" | "degraded" | "incompatible" | "failed";
  reason?: string;
  declaredContributions: PluginContributionType[];
  registeredContributions: Record<PluginContributionType, string[]>;
  provenance: {
    source: "npm" | "local";
    verified: boolean;
    packageVersion?: string;
    integrity?: string;
  };
}

export interface PluginHostDeps {
  hooks: HookBus;
  commands: CommandRegistry;
  skills: SkillRegistry;
  registerTool: (def: ToolDefinition) => void;
  registerProvider: (def: ProviderDef) => void;
  addSkillDir: (path: string) => void;
  /** Roll back a tool registered mid-failed plugin load (BUG-099). */
  unregisterTool?: (name: string) => void;
  /** Roll back a provider registered mid-failed plugin load (BUG-099). */
  unregisterProvider?: (id: string) => void;
  /** Roll back a skill dir registered mid-failed plugin load (BUG-099). */
  removeSkillDir?: (path: string) => void;
  logger?: Logger;
  /** Explicit exception for bundled or user-approved provider factories. */
  trustedInProcessPlugins?: readonly string[];
}

/**
 * Loads plugin modules and wires them to the host registries. Manifested
 * third-party plugins run in a scrubbed child process unless the caller has
 * explicitly approved that exact specifier for trusted in-process execution.
 * Failures are logged and skipped, never fatal.
 */
export class PluginHost {
  #deps: PluginHostDeps;
  #log: Logger;
  #statuses: PluginStatus[] = [];
  #workers: PluginWorkerClient[] = [];

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? createLogger("plugins");
  }

  listPluginStatus(): PluginStatus[] {
    return this.#statuses.map((status) => ({
      ...status,
      declaredContributions: [...status.declaredContributions],
      registeredContributions: Object.fromEntries(
        PLUGIN_CONTRIBUTION_TYPES.map((type) => [type, [...status.registeredContributions[type]]]),
      ) as Record<PluginContributionType, string[]>,
      provenance: { ...status.provenance },
    }));
  }

  /** Reap every isolated plugin process. Idempotent and safe during teardown. */
  async close(): Promise<void> {
    const workers = this.#workers;
    this.#workers = [];
    await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
  }

  /** Import and register each plugin module specifier (npm name or path).
   * `timeoutMs` bounds each plugin's register() (default 15s); exposed mainly for
   * tests. */
  async load(specifiers: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.close();
    this.#statuses = [];
    const deadline = opts.timeoutMs ?? PLUGIN_REGISTER_TIMEOUT_MS;
    // BUG-071: reloading the same plugins must not double-register hooks.
    // Clear hook handlers once at the start of a load batch (commands overwrite
    // by name already; tools refuse shadowing).
    if (specifiers.length) this.#deps.hooks.clear();
    for (const spec of specifiers) {
      const metadata = await resolvePluginMetadata(spec).catch((error) => ({
        entry: spec,
        manifest: null,
        manifestError: error instanceof Error ? error.message : String(error),
        provenance: { source: isLocalSpecifier(spec) ? "local" as const : "npm" as const, verified: false },
      }));
      const baseStatus: PluginStatus = {
        specifier: spec,
        name: metadata.manifest?.name ?? spec,
        ...(metadata.manifest?.version ? { version: metadata.manifest.version } : {}),
        status: "failed",
        declaredContributions: metadata.manifest?.contributions ?? [],
        registeredContributions: emptyRegisteredContributions(),
        provenance: metadata.provenance,
      };
      if (metadata.manifestError) {
        this.#statuses.push({
          ...baseStatus,
          status: metadata.manifestError.startsWith("Invalid") || metadata.manifestError.includes("manifest")
            ? "incompatible"
            : "failed",
          reason: metadata.manifestError,
        });
        this.#log.error(`rejected plugin ${spec}: ${metadata.manifestError}`);
        continue;
      }
      if (metadata.manifest) {
        const incompatible = manifestCompatibilityError(metadata.manifest);
        if (incompatible) {
          this.#statuses.push({ ...baseStatus, status: "incompatible", reason: incompatible });
          this.#log.error(`rejected plugin ${spec}: ${incompatible}`);
          continue;
        }
      }
      if (metadata.manifest && !this.#deps.trustedInProcessPlugins?.includes(spec)) {
        try {
          const started = await PluginWorkerClient.start({
            specifier: metadata.entry,
            cwd: process.cwd(),
            startupTimeoutMs: deadline,
            rpcTimeoutMs: Math.max(deadline, 1_000),
          });
          if (started.result.status === "trusted-in-process-approval-required") {
            this.#statuses.push({
              ...baseStatus,
              status: "degraded",
              reason: "Provider plugin requires explicit trusted-in-process approval",
            });
            continue;
          }
          const worker = started.client;
          const registered = emptyRegisteredContributions();
          const declared = new Set(metadata.manifest.contributions);
          const actual = new Set<PluginContributionType>();
          if (started.result.metadata.tools.length) actual.add("tools");
          if (started.result.metadata.commands.length) actual.add("commands");
          if (started.result.metadata.hooks.length) actual.add("hooks");
          const undeclared = [...actual].filter((type) => !declared.has(type));
          if (undeclared.length) {
            await worker.close();
            throw new Error(`plugin ${metadata.manifest.name} registered undeclared ${undeclared.join(", ")} contribution`);
          }
          for (const tool of started.result.metadata.tools) {
            this.#deps.registerTool({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              readOnly: tool.readOnly,
              ...(tool.concurrencySafe === undefined ? {} : { concurrencySafe: tool.concurrencySafe }),
              ...(tool.network === undefined ? {} : { network: tool.network }),
              ...(tool.modes === undefined ? {} : { modes: tool.modes }),
              execute: async (input, context) => {
                const value = await worker.callTool(tool.name, input as JsonValue, {
                  cwd: context.cwd,
                  sessionId: context.sessionId,
                  toolCallId: context.toolCallId,
                }, context.abortSignal);
                if (value && typeof value === "object" && !Array.isArray(value) && "output" in value) {
                  return value as { output: string | Record<string, unknown>; isError?: boolean };
                }
                return { output: typeof value === "string" ? value : JSON.stringify(value) };
              },
            });
            registered.tools.push(tool.name);
          }
          for (const command of started.result.metadata.commands) {
            this.#deps.commands.register({
              name: command.name,
              description: command.description,
              source: "plugin",
              run: (args) => worker.runCommand(command.name, args),
            });
            registered.commands.push(command.name);
          }
          for (const hook of started.result.metadata.hooks) {
            this.#deps.hooks.on(hook, async (payload) => await worker.runHook(hook, payload as unknown as JsonValue) as never);
            registered.hooks.push(hook);
          }
          const missing = metadata.manifest.contributions.filter((type) => registered[type].length === 0);
          this.#workers.push(worker);
          this.#statuses.push({
            ...baseStatus,
            status: metadata.provenance.verified && missing.length === 0 ? "loaded" : "degraded",
            ...(missing.length ? { reason: `Declared contributions not registered: ${missing.join(", ")}` }
              : !metadata.provenance.verified ? { reason: "Local plugin is unverified and isolated" } : {}),
            registeredContributions: registered,
          });
          continue;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "isolated plugin failed";
          this.#statuses.push({ ...baseStatus, status: reason.includes("undeclared") ? "incompatible" : "failed", reason });
          this.#log.error(`failed to load isolated plugin ${spec}: ${reason}`);
          continue;
        }
      }
      // BUG-070 / BUG-098 / BUG-099: track every registration for this plugin so
      // a timed-out or throwing register can roll back AND seal the API so a
      // late-settling register cannot re-mutate live registries after rollback.
      const registeredCommands: string[] = [];
      const registeredTools: string[] = [];
      const registeredProviders: string[] = [];
      const registeredSkillDirs: string[] = [];
      const hookSnap = snapshotHooks(this.#deps.hooks);
      let sealed = false;
      const requireContribution = (type: PluginContributionType) => {
        if (metadata.manifest && !metadata.manifest.contributions.includes(type)) {
          throw new Error(`plugin ${metadata.manifest.name} registered undeclared ${type} contribution`);
        }
      };
      const api: PluginApi = {
        registerTool: (def) => {
          if (sealed) return;
          requireContribution("tools");
          registeredTools.push(def.name);
          this.#deps.registerTool(def);
        },
        registerProvider: (def) => {
          if (sealed) return;
          requireContribution("providers");
          registeredProviders.push(def.id);
          this.#deps.registerProvider(def);
        },
        registerCommand: (cmd) => {
          if (sealed) return;
          requireContribution("commands");
          registeredCommands.push(cmd.name);
          this.#deps.commands.register(cmd);
        },
        addSkillDir: (path) => {
          if (sealed) return;
          requireContribution("skills");
          registeredSkillDirs.push(path);
          this.#deps.addSkillDir(path);
        },
        // Proxy hooks so a late-settling register() cannot add handlers after
        // seal/rollback (BUG-098). Other HookBus methods pass through.
        hooks: new Proxy(this.#deps.hooks, {
          get: (target, prop, receiver) => {
            if (prop === "on") {
              return (name: HookName, handler: Parameters<HookBus["on"]>[1]) => {
                if (sealed) return;
                requireContribution("hooks");
                return target.on(name, handler as never);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as HookBus,
        logger: this.#log,
      };

      try {
        const mod = (await withTimeout(
          import(metadata.entry),
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
          const registeredContributions = {
            tools: [...registeredTools],
            providers: [...registeredProviders],
            commands: [...registeredCommands],
            skills: [...registeredSkillDirs],
            hooks: registeredHookNames(this.#deps.hooks, hookSnap),
          };
          const missingDeclared = metadata.manifest?.contributions.filter(
            (type) => registeredContributions[type].length === 0,
          ) ?? [];
          this.#statuses.push({
            ...baseStatus,
            status: metadata.provenance.verified && missingDeclared.length === 0 ? "loaded" : "degraded",
            ...(!metadata.manifest
              ? { reason: "Legacy plugin has no PluginManifestV1" }
              : missingDeclared.length
                ? { reason: `Declared contributions not registered: ${missingDeclared.join(", ")}` }
                : !metadata.provenance.verified
                  ? { reason: "Local plugin is unverified" }
                  : {}),
            registeredContributions,
          });
        } else {
          this.#log.warn(`plugin ${spec} has no register()`);
          this.#statuses.push({ ...baseStatus, status: "degraded", reason: "Plugin has no register()" });
        }
      } catch (err) {
        // Seal FIRST so a late-settling register() cannot re-register after
        // rollback (BUG-098).
        sealed = true;
        // BUG-100: restore THIS plugin's hook growth only — never clear the
        // whole bus (that wiped earlier plugins in the same batch).
        restoreHooks(this.#deps.hooks, hookSnap);
        for (const name of registeredCommands) {
          this.#deps.commands.unregister(name);
        }
        for (const name of registeredTools) {
          this.#deps.unregisterTool?.(name);
        }
        for (const id of registeredProviders) {
          this.#deps.unregisterProvider?.(id);
        }
        for (const path of registeredSkillDirs) {
          this.#deps.removeSkillDir?.(path);
        }
        const reason = (err as Error).message;
        this.#statuses.push({
          ...baseStatus,
          status: metadata.manifest && reason.includes("undeclared") ? "incompatible" : "failed",
          reason,
        });
        this.#log.error(`failed to load plugin ${spec}: ${reason}`);
      }
    }
  }
}

interface ResolvedPluginMetadata {
  entry: string;
  manifest: PluginManifestV1 | null;
  manifestError?: string;
  provenance: PluginStatus["provenance"];
}

async function resolvePluginMetadata(specifier: string): Promise<ResolvedPluginMetadata> {
  const local = isLocalSpecifier(specifier);
  const inline = specifier.startsWith("data:");
  const raw = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
  const entry = inline ? specifier : local ? resolve(raw) : await Bun.resolve(specifier, process.cwd());
  const packageInfo = inline ? null : await nearestPackageJson(entry);
  const sidecars = inline ? [] : [`${entry}.manifest.json`, join(dirname(entry), "vibe.plugin.json")];
  let rawManifest: unknown = packageInfo?.json.vibePlugin;
  let manifestReadError: string | undefined;
  if (rawManifest === undefined) {
    for (const path of sidecars) {
      let contents: string;
      try { contents = await readFile(path, "utf8"); }
      catch { continue; }
      try { rawManifest = JSON.parse(contents); }
      catch { manifestReadError = `Invalid plugin manifest JSON at ${path}`; }
      break;
    }
  }
  const parsed = manifestReadError ? { manifest: null, error: manifestReadError } : parsePluginManifest(rawManifest);
  const provenance: PluginStatus["provenance"] = local || inline
    ? { source: "local", verified: false }
    : {
        source: "npm",
        verified: true,
        ...(typeof packageInfo?.json.version === "string" ? { packageVersion: packageInfo.json.version } : {}),
        integrity: `sha256-${createHash("sha256").update(await readFile(entry)).digest("base64")}`,
      };
  return {
    entry,
    manifest: parsed.manifest,
    ...(parsed.error ? { manifestError: parsed.error } : {}),
    provenance,
  };
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("file:") || isAbsolute(specifier);
}

async function nearestPackageJson(entry: string): Promise<{ path: string; json: Record<string, unknown> } | null> {
  let current = dirname(entry);
  const root = parse(current).root;
  while (current !== root) {
    const path = join(current, "package.json");
    try { return { path, json: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> }; }
    catch { current = dirname(current); }
  }
  return null;
}

function emptyRegisteredContributions(): Record<PluginContributionType, string[]> {
  return { tools: [], providers: [], commands: [], skills: [], hooks: [] };
}

function registeredHookNames(hooks: HookBus, before: Map<string, number>): string[] {
  return [...before].filter(([name, count]) => hooks.handlerCount(name as HookName) > count).map(([name]) => name);
}

/** Capture handler lists so a failed register can restore (BUG-070 / BUG-100). */
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
    "subagent.start",
    "subagent.stop",
    "permission.denied",
    "compact.before",
    "compact.after",
    "goal.transition",
    "turn.failure",
  ] as const;
  const snap = new Map<string, number>();
  for (const n of names) snap.set(n, hooks.handlerCount(n));
  return snap;
}

/** Trim each hook list back to the pre-plugin count (BUG-100). */
function restoreHooks(hooks: HookBus, snap: Map<string, number>): void {
  for (const [name, n] of snap) {
    hooks.trimTo(name as HookName, n);
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
