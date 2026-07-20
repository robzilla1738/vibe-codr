import { loadConfig, type Config } from "@vibe/config";
import {
  Engine,
  loadProjectMemory,
  PortableSessionManager,
  SessionStore,
  type EngineOptions,
  type PersistedSession,
} from "@vibe/core";
import { ProviderRegistry } from "@vibe/providers";
import type { ExecutionTarget, Mode } from "@vibe/shared";
import { RuntimeService, type RuntimeEngine } from "./runtime-service.ts";

export type RuntimeSessionStore = Pick<
  SessionStore,
  "latestId" | "load" | "acquireLease" | "releaseLease"
>;

export interface RuntimeModelResolver {
  resolveModel(model: string, config: Config): Promise<unknown>;
}

export interface OpenRuntimeSessionDependencies {
  loadConfig(input: { cwd: string; overrides: Partial<Config> }): Promise<Config>;
  createSessionStore(cwd: string): RuntimeSessionStore;
  createRegistry(): RuntimeModelResolver;
  assertOwner(cwd: string, sessionId: string, target: ExecutionTarget): Promise<void>;
  loadProjectMemory(cwd: string): Promise<string | undefined>;
  createEngine(options: EngineOptions): RuntimeEngine;
}

const DEFAULT_DEPENDENCIES: OpenRuntimeSessionDependencies = {
  loadConfig,
  createSessionStore: (cwd) => new SessionStore(cwd),
  createRegistry: () => new ProviderRegistry(),
  assertOwner: (cwd, sessionId, target) =>
    PortableSessionManager.assertOwner(cwd, sessionId, target),
  loadProjectMemory,
  createEngine: (options) => new Engine(options),
};

export type RuntimeResumeRequest =
  | { kind: "new" }
  | { kind: "latest" }
  | { kind: "session"; sessionId: string }
  | { kind: "loaded"; session: PersistedSession };

export interface OpenRuntimeSessionOptions {
  cwd: string;
  interactive: boolean;
  config?: Config;
  configOverrides?: Partial<Config>;
  requiredModels?: readonly string[];
  resume?: RuntimeResumeRequest;
  executionTarget?: ExecutionTarget;
  /** Host-owned authorization may select a target only after resume resolves. */
  executionTargetForResume?: (session: PersistedSession) => ExecutionTarget | undefined;
  /** Acquire an advisory PID lease for a resumed session. Defaults to true. */
  acquireLease?: boolean;
  onWarning?: (message: string) => void;
  projectMemory?: string;
  modelOverride?: string;
  modeOverride?: Mode;
  registry?: ProviderRegistry;
  engineFactory?: (options: EngineOptions) => RuntimeEngine;
  /** Narrow construction seams for deterministic lifecycle tests. */
  dependencies?: Partial<OpenRuntimeSessionDependencies>;
}

/** Resolve and open one Engine session without introducing transport concerns. */
export async function openRuntimeSession(
  options: OpenRuntimeSessionOptions,
): Promise<RuntimeService> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const config = options.config ?? (await loadRuntimeConfig(options, dependencies));

  if (options.requiredModels) {
    const registry = options.registry ?? dependencies.createRegistry();
    try {
      for (const model of options.requiredModels) await registry.resolveModel(model, config);
    } catch (error) {
      throw new Error(
        `missing-credential: resumed engine could not resolve required model: ${errorMessage(error)}`,
      );
    }
  }

  const store = dependencies.createSessionStore(options.cwd);
  const resume = await resolveResume(store, options.resume);
  if (resume) {
    for (const warning of resume.warnings ?? []) options.onWarning?.(warning);
    const target = resolveExecutionTarget(
      options.executionTargetForResume?.(resume) ?? options.executionTarget,
    );
    try {
      await dependencies.assertOwner(options.cwd, resume.meta.id, target);
    } catch (error) {
      throw new Error(
        `session ownership check failed for ${target.kind === "local" ? "local" : `cloud/${target.provider}`}: ${errorMessage(error)}`,
      );
    }
  }

  let releaseOwnedLease: (() => Promise<void>) | undefined;
  if (resume && options.acquireLease !== false) {
    const lease = await store.acquireLease(resume.meta.id);
    if (lease.ok) {
      let released = false;
      releaseOwnedLease = async () => {
        if (released) return;
        released = true;
        await store.releaseLease(resume.meta.id);
      };
    } else {
      options.onWarning?.(
        `session ${resume.meta.id} may be active in another process (PID ${lease.holderPid}).\n` +
          "Two terminals on the same session can lose work — proceed with caution.",
      );
    }
  }

  try {
    const projectMemory =
      options.projectMemory !== undefined
        ? options.projectMemory
        : await dependencies.loadProjectMemory(options.cwd);
    const engineOptions: EngineOptions = {
      config,
      cwd: options.cwd,
      interactive: options.interactive,
      ...(projectMemory ? { projectMemory } : {}),
      ...(resume ? { resume } : {}),
      ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
      ...(options.modeOverride ? { modeOverride: options.modeOverride } : {}),
    };
    const engine = options.engineFactory?.(engineOptions) ?? dependencies.createEngine(engineOptions);
    const service = new RuntimeService(engine, {
      ...(releaseOwnedLease ? { afterFinalize: releaseOwnedLease } : {}),
    });
    return await service.open();
  } catch (error) {
    await releaseOwnedLease?.();
    throw error;
  }
}

async function loadRuntimeConfig(
  options: OpenRuntimeSessionOptions,
  dependencies: OpenRuntimeSessionDependencies,
): Promise<Config> {
  try {
    return await dependencies.loadConfig({
      cwd: options.cwd,
      overrides: options.configOverrides ?? {},
    });
  } catch (error) {
    throw new Error(`config load failed: ${errorMessage(error)}`);
  }
}

async function resolveResume(
  store: RuntimeSessionStore,
  request: RuntimeResumeRequest | undefined,
): Promise<PersistedSession | undefined> {
  if (!request || request.kind === "new") return undefined;
  if (request.kind === "loaded") return request.session;
  const id = request.kind === "latest" ? await store.latestId() : request.sessionId;
  const loaded = id ? await store.load(id) : null;
  if (loaded) return loaded;
  if (request.kind === "session") throw new Error(`requested session not found: ${request.sessionId}`);
  return undefined;
}

function resolveExecutionTarget(explicit: ExecutionTarget | undefined): ExecutionTarget {
  if (explicit) return explicit;
  if (process.env.VIBE_CLOUD_RUNTIME !== "1") return { kind: "local" };
  const provider = process.env.VIBE_CLOUD_PROVIDER;
  if (provider !== "e2b" && provider !== "vercel") {
    throw new Error("cloud runtime is missing a valid VIBE_CLOUD_PROVIDER");
  }
  return { kind: "cloud", provider };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
