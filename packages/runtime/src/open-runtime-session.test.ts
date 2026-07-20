import { describe, expect, test } from "bun:test";
import { defaultConfig, type Config } from "@vibe/config";
import type { EngineOptions, PersistedSession } from "@vibe/core";
import {
  AsyncQueue,
  type EngineCommand,
  type EngineSnapshot,
  type ExecutionTarget,
  type UIEvent,
} from "@vibe/shared";
import {
  openRuntimeSession,
  type OpenRuntimeSessionDependencies,
  type RuntimeEngine,
} from "./index.ts";

const SNAPSHOT = { sessionId: "runtime-session" } as EngineSnapshot;

class InjectedEngine implements RuntimeEngine {
  readonly eventsQueue = new AsyncQueue<UIEvent>();
  readonly bootstrapError?: Error;
  bootstrapCount = 0;
  startCount = 0;
  finalizeCount = 0;

  constructor(bootstrapError?: Error) {
    this.bootstrapError = bootstrapError;
  }

  events(): AsyncIterable<UIEvent> {
    return this.eventsQueue;
  }

  async bootstrap(): Promise<void> {
    this.bootstrapCount += 1;
    if (this.bootstrapError) throw this.bootstrapError;
  }

  start(): void {
    this.startCount += 1;
  }

  send(_command: EngineCommand): void {}

  snapshot(): EngineSnapshot {
    return SNAPSHOT;
  }

  async listModels() {
    return [];
  }

  async finalize(): Promise<void> {
    this.finalizeCount += 1;
    this.eventsQueue.close();
  }
}

function persisted(id: string, warnings: string[] = []): PersistedSession {
  return {
    meta: {
      id,
      model: "ollama/test",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    },
    modelMessages: [],
    history: [],
    warnings,
  };
}

function createHarness() {
  const config = defaultConfig();
  const sessions = new Map<string, PersistedSession>();
  const configLoads: Array<{ cwd: string; overrides: Partial<Config> }> = [];
  const loadedIds: string[] = [];
  const resolvedModels: Array<{ model: string; config: Config }> = [];
  const ownershipChecks: Array<{
    cwd: string;
    sessionId: string;
    target: ExecutionTarget;
  }> = [];
  const engineOptions: EngineOptions[] = [];
  const engines: InjectedEngine[] = [];
  let latestId: string | undefined;
  let leaseResult: { ok: true } | { ok: false; holderPid: number } = { ok: true };
  let releaseCount = 0;
  let registryError: Error | undefined;
  let bootstrapError: Error | undefined;
  let memory = "project memory";

  const dependencies: OpenRuntimeSessionDependencies = {
    async loadConfig(input) {
      configLoads.push(input);
      return config;
    },
    createSessionStore() {
      return {
        async latestId() {
          return latestId;
        },
        async load(id) {
          loadedIds.push(id);
          return sessions.get(id) ?? null;
        },
        async acquireLease() {
          return leaseResult;
        },
        async releaseLease() {
          releaseCount += 1;
        },
      };
    },
    createRegistry() {
      return {
        async resolveModel(model, resolvedConfig) {
          resolvedModels.push({ model, config: resolvedConfig });
          if (registryError) throw registryError;
          return {};
        },
      };
    },
    async assertOwner(cwd, sessionId, target) {
      ownershipChecks.push({ cwd, sessionId, target });
    },
    async loadProjectMemory() {
      return memory;
    },
    createEngine(options) {
      engineOptions.push(options);
      const engine = new InjectedEngine(bootstrapError);
      engines.push(engine);
      return engine;
    },
  };

  return {
    config,
    sessions,
    configLoads,
    loadedIds,
    resolvedModels,
    ownershipChecks,
    engineOptions,
    engines,
    dependencies,
    setLatestId(value: string | undefined) {
      latestId = value;
    },
    setLeaseResult(value: typeof leaseResult) {
      leaseResult = value;
    },
    setRegistryError(value: Error | undefined) {
      registryError = value;
    },
    setBootstrapError(value: Error | undefined) {
      bootstrapError = value;
    },
    setMemory(value: string) {
      memory = value;
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

describe("openRuntimeSession", () => {
  test("applies config overrides, validates required models, opens new, and injects memory", async () => {
    const harness = createHarness();
    harness.setMemory("VIBE project instructions");
    const overrides: Partial<Config> = { model: "ollama/override" };

    const runtime = await openRuntimeSession({
      cwd: "/workspace",
      interactive: false,
      configOverrides: overrides,
      requiredModels: ["ollama/one", "ollama/two"],
      resume: { kind: "new" },
      dependencies: harness.dependencies,
    });

    expect(harness.configLoads).toEqual([{ cwd: "/workspace", overrides }]);
    expect(harness.resolvedModels).toEqual([
      { model: "ollama/one", config: harness.config },
      { model: "ollama/two", config: harness.config },
    ]);
    expect(harness.loadedIds).toEqual([]);
    expect(harness.ownershipChecks).toEqual([]);
    expect(harness.engineOptions[0]).toMatchObject({
      config: harness.config,
      cwd: "/workspace",
      interactive: false,
      projectMemory: "VIBE project instructions",
    });
    expect(harness.engineOptions[0]?.resume).toBeUndefined();
    await runtime.close();

    const invalid = createHarness();
    invalid.setRegistryError(new Error("model unavailable"));
    await expect(
      openRuntimeSession({
        cwd: "/workspace",
        interactive: false,
        requiredModels: ["paid/model"],
        dependencies: invalid.dependencies,
      }),
    ).rejects.toThrow(
      "missing-credential: resumed engine could not resolve required model: model unavailable",
    );
    expect(invalid.engines).toEqual([]);
  });

  test("resolves latest, specific, and loaded sessions with target choice and warnings", async () => {
    const latest = createHarness();
    const latestSession = persisted("latest-session", ["latest warning"]);
    latest.sessions.set(latestSession.meta.id, latestSession);
    latest.setLatestId(latestSession.meta.id);
    const latestWarnings: string[] = [];
    const latestRuntime = await openRuntimeSession({
      cwd: "/latest",
      interactive: true,
      resume: { kind: "latest" },
      executionTarget: { kind: "cloud", provider: "e2b" },
      acquireLease: false,
      onWarning: (warning) => latestWarnings.push(warning),
      dependencies: latest.dependencies,
    });
    expect(latest.loadedIds).toEqual(["latest-session"]);
    expect(latest.engineOptions[0]?.resume).toBe(latestSession);
    expect(latest.ownershipChecks).toEqual([
      {
        cwd: "/latest",
        sessionId: "latest-session",
        target: { kind: "cloud", provider: "e2b" },
      },
    ]);
    expect(latestWarnings).toEqual(["latest warning"]);
    await latestRuntime.close();

    const specific = createHarness();
    const specificSession = persisted("specific-session");
    specific.sessions.set(specificSession.meta.id, specificSession);
    const specificRuntime = await openRuntimeSession({
      cwd: "/specific",
      interactive: false,
      resume: { kind: "session", sessionId: "specific-session" },
      acquireLease: false,
      dependencies: specific.dependencies,
    });
    expect(specific.loadedIds).toEqual(["specific-session"]);
    expect(specific.engineOptions[0]?.resume).toBe(specificSession);
    expect(specific.ownershipChecks[0]?.target).toEqual({ kind: "local" });
    await specificRuntime.close();

    const loaded = createHarness();
    const loadedSession = persisted("loaded-session");
    const loadedRuntime = await openRuntimeSession({
      cwd: "/loaded",
      interactive: false,
      resume: { kind: "loaded", session: loadedSession },
      executionTarget: { kind: "cloud", provider: "e2b" },
      executionTargetForResume: () => ({ kind: "cloud", provider: "vercel" }),
      acquireLease: false,
      dependencies: loaded.dependencies,
    });
    expect(loaded.loadedIds).toEqual([]);
    expect(loaded.engineOptions[0]?.resume).toBe(loadedSession);
    expect(loaded.ownershipChecks[0]?.target).toEqual({
      kind: "cloud",
      provider: "vercel",
    });
    await loadedRuntime.close();
  });

  test("never releases a foreign lease after normal close or failed bootstrap", async () => {
    const normal = createHarness();
    const session = persisted("foreign-normal");
    normal.setLeaseResult({ ok: false, holderPid: 4242 });
    const warnings: string[] = [];
    const runtime = await openRuntimeSession({
      cwd: "/foreign",
      interactive: true,
      config: normal.config,
      resume: { kind: "loaded", session },
      onWarning: (warning) => warnings.push(warning),
      dependencies: normal.dependencies,
    });
    await runtime.close();
    expect(normal.releaseCount).toBe(0);
    expect(warnings.join("\n")).toContain("PID 4242");

    const failed = createHarness();
    failed.setLeaseResult({ ok: false, holderPid: 5252 });
    failed.setBootstrapError(new Error("bootstrap failed"));
    await expect(
      openRuntimeSession({
        cwd: "/foreign-failure",
        interactive: true,
        config: failed.config,
        resume: { kind: "loaded", session: persisted("foreign-failure") },
        dependencies: failed.dependencies,
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(failed.releaseCount).toBe(0);
    expect(failed.engines[0]?.finalizeCount).toBe(1);
  });

  test("releases an owned lease exactly once on close and failed-bootstrap cleanup", async () => {
    const normal = createHarness();
    const runtime = await openRuntimeSession({
      cwd: "/owned",
      interactive: true,
      config: normal.config,
      resume: { kind: "loaded", session: persisted("owned-normal") },
      dependencies: normal.dependencies,
    });
    await Promise.all([runtime.close(), runtime.close(), runtime.finalize()]);
    expect(normal.releaseCount).toBe(1);
    expect(normal.engines[0]?.finalizeCount).toBe(1);

    const failed = createHarness();
    failed.setBootstrapError(new Error("bootstrap cleanup"));
    await expect(
      openRuntimeSession({
        cwd: "/owned-failure",
        interactive: true,
        config: failed.config,
        resume: { kind: "loaded", session: persisted("owned-failure") },
        dependencies: failed.dependencies,
      }),
    ).rejects.toThrow("bootstrap cleanup");
    expect(failed.releaseCount).toBe(1);
    expect(failed.engines[0]?.finalizeCount).toBe(1);
  });
});
