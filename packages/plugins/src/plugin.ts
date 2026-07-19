import { createLogger, type Logger, type ToolDefinition } from "@vibe/shared";
import type { ProviderDef } from "@vibe/providers";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookBus, HookName } from "./hooks.ts";
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

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_CONTRIBUTION_TYPES = ["tools", "providers", "commands", "skills", "hooks"] as const;
export type PluginContributionType = (typeof PLUGIN_CONTRIBUTION_TYPES)[number];

export interface PluginManifestV1 {
  schemaVersion: 1;
  name: string;
  version: string;
  apiVersion: 1;
  contributions: PluginContributionType[];
  requiredCapabilities: string[];
  provenance: { source: "npm" | "local"; package?: string };
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
}

/**
 * Loads plugin modules and wires them to the host registries. Plugins run
 * in-process for v1. Failures are logged and skipped, never fatal.
 */
export class PluginHost {
  #deps: PluginHostDeps;
  #log: Logger;
  #statuses: PluginStatus[] = [];

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

  /** Import and register each plugin module specifier (npm name or path).
   * `timeoutMs` bounds each plugin's register() (default 15s); exposed mainly for
   * tests. */
  async load(specifiers: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
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

function parsePluginManifest(value: unknown): { manifest: PluginManifestV1 | null; error?: string } {
  if (value === undefined) return { manifest: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { manifest: null, error: "Plugin manifest must be an object" };
  const manifest = value as Partial<PluginManifestV1>;
  if (manifest.schemaVersion !== 1 || typeof manifest.name !== "string" || !manifest.name.trim()
    || typeof manifest.version !== "string" || !manifest.version.trim()
    || !Array.isArray(manifest.contributions) || !manifest.contributions.every(isContributionType)
    || !Array.isArray(manifest.requiredCapabilities) || !manifest.requiredCapabilities.every((item) => typeof item === "string")
    || !manifest.provenance || (manifest.provenance.source !== "npm" && manifest.provenance.source !== "local")
    || (manifest.provenance.package !== undefined && typeof manifest.provenance.package !== "string")) {
    return { manifest: null, error: "Invalid PluginManifestV1" };
  }
  return { manifest: manifest as PluginManifestV1 };
}

function manifestCompatibilityError(manifest: PluginManifestV1): string | undefined {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) return `Plugin API ${String(manifest.apiVersion)} is incompatible with host API ${PLUGIN_API_VERSION}`;
  const unsupported = manifest.requiredCapabilities.filter((capability) => !isContributionType(capability));
  if (unsupported.length) return `Unsupported plugin capabilities: ${unsupported.join(", ")}`;
  return undefined;
}

function isContributionType(value: unknown): value is PluginContributionType {
  return typeof value === "string" && PLUGIN_CONTRIBUTION_TYPES.includes(value as PluginContributionType);
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
