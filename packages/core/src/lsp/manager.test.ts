import { test, expect } from "bun:test";
import { LspConfigSchema } from "@vibe/config";
import { LspDiagnostics, type ManagedClient, type LspClientFactory } from "./manager.ts";

interface FakeClient extends ManagedClient {
  startCalls: number;
  diagnoseCalls: number;
  disposeCalls: number;
  emitExit(code?: number): void;
}

interface Behavior {
  start?: () => Promise<void>;
  diagnose?: (absPath: string, timeoutMs: number) => Promise<string | undefined>;
}

function makeFake(behavior: Behavior): FakeClient {
  const exitCbs: ((code: number) => void)[] = [];
  return {
    startCalls: 0,
    diagnoseCalls: 0,
    disposeCalls: 0,
    async start() {
      this.startCalls++;
      if (behavior.start) await behavior.start();
    },
    async diagnose(absPath, timeoutMs) {
      this.diagnoseCalls++;
      return behavior.diagnose ? behavior.diagnose(absPath, timeoutMs) : undefined;
    },
    dispose() {
      this.disposeCalls++;
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    emitExit(code = 1) {
      for (const cb of exitCbs) cb(code);
    },
  };
}

function fakeFactory(behavior: Behavior): { factory: LspClientFactory; created: FakeClient[] } {
  const created: FakeClient[] = [];
  const factory: LspClientFactory = () => {
    const c = makeFake(behavior);
    created.push(c);
    return c;
  };
  return { factory, created };
}

function makeManager(behavior: Behavior, overrides: Record<string, unknown> = {}) {
  const { factory, created } = fakeFactory(behavior);
  const config = LspConfigSchema.parse({
    timeoutMs: 40,
    idleShutdownMs: 0,
    ...(overrides.config as object),
  });
  const manager = new LspDiagnostics({
    config,
    workspaceRoot: () => "/root",
    which: () => "/usr/bin/fake",
    clientFactory: factory,
    restartBackoffMs: 0,
    maxRestarts: 3,
    initializeTimeoutMs: 1_000,
  });
  return { manager, created };
}

test("lazy spawn: no server until the first NON-TS diagnose", async () => {
  const { manager, created } = makeManager({ diagnose: async () => "  x: int error" });

  // TS/JS and unmapped files never spawn a server.
  expect(await manager.diagnose("/proj/a.ts")).toBeUndefined();
  expect(await manager.diagnose("/proj/README.md")).toBeUndefined();
  expect(created.length).toBe(0);

  // First .py diagnose spawns exactly one server and returns its result.
  const out = await manager.diagnose("/proj/app.py");
  expect(out).toContain("x: int error");
  expect(created.length).toBe(1);

  // A second .py diagnose reuses the same server (no new spawn).
  await manager.diagnose("/proj/other.py");
  expect(created.length).toBe(1);
  expect(created[0]!.diagnoseCalls).toBe(2);
});

test("per-diagnose timeout → undefined (a hung server never blocks the edit)", async () => {
  const { manager } = makeManager({
    // Start succeeds, but the server never answers publishDiagnostics.
    diagnose: () => new Promise<string | undefined>(() => {}),
  });
  const started = Date.now();
  const out = await manager.diagnose("/proj/app.py");
  expect(out).toBeUndefined();
  // Bounded by the 40ms per-diagnose deadline, not left hanging.
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("bounded crash-restart then give-up", async () => {
  // Every spawn fails to start → the manager restarts up to maxRestarts, then
  // stops trying (advisory: it just returns undefined, never blocks an edit).
  const { manager, created } = makeManager({ start: () => Promise.reject(new Error("boom")) });

  for (let i = 0; i < 5; i++) expect(await manager.diagnose("/proj/app.py")).toBeUndefined();

  // Exactly maxRestarts (3) spawn attempts were made before giving up.
  expect(created.length).toBe(3);
  const status = manager.status();
  expect(status.find((s) => s.language === "py")?.state).toBe("crashed");
});

test("a crash after a good start re-spawns (crash budget resets on a clean start)", async () => {
  const { manager, created } = makeManager({ diagnose: async () => "  boom" });
  await manager.diagnose("/proj/app.py");
  expect(created.length).toBe(1);
  expect(manager.status().find((s) => s.language === "py")?.state).toBe("running");

  // The live server dies unexpectedly → the next diagnose spawns a fresh one.
  created[0]!.emitExit(1);
  await manager.diagnose("/proj/app.py");
  expect(created.length).toBe(2);
  expect(manager.status().find((s) => s.language === "py")?.state).toBe("running");
});

test("idle timer kills an unused server; the next edit re-spawns it", async () => {
  const { manager, created } = makeManager(
    { diagnose: async () => "  err" },
    { config: { idleShutdownMs: 20 } },
  );
  await manager.diagnose("/proj/app.py");
  expect(created.length).toBe(1);

  // Wait past the idle window — the server is disposed.
  await Bun.sleep(60);
  expect(created[0]!.disposeCalls).toBe(1);
  expect(manager.status().find((s) => s.language === "py")?.state).toBe("idle");

  // A later edit lazily re-spawns (idle shutdown isn't a crash — no give-up).
  await manager.diagnose("/proj/app.py");
  expect(created.length).toBe(2);
});

test("status surfaces a configured-but-missing server even before any edit", () => {
  const { factory } = fakeFactory({});
  const config = LspConfigSchema.parse({ servers: { go: { command: "gopls" } } });
  const manager = new LspDiagnostics({
    config,
    workspaceRoot: () => "/root",
    which: () => null, // nothing on PATH
    clientFactory: factory,
  });
  const go = manager.status().find((s) => s.language === "go");
  expect(go?.state).toBe("missing");
});

test("dispose kills a server still mid-initialize (its start never resolved)", async () => {
  // A server whose handshake is still in flight when dispose() runs must be torn
  // down too — its start() may never resolve, so leaving it to the #ensureClient
  // disposed-guard would leak the child process past shutdown.
  const { manager, created } = makeManager({ start: () => new Promise<void>(() => {}) });

  // Kick off a diagnose; the background start won't finish within the per-diagnose
  // deadline, so this returns undefined but leaves start() pending in the entry.
  expect(await manager.diagnose("/proj/app.py")).toBeUndefined();
  expect(created.length).toBe(1);
  expect(created[0]!.disposeCalls).toBe(0); // not ready, not yet disposed

  manager.dispose();
  // The mid-initialize client was disposed, not orphaned.
  expect(created[0]!.disposeCalls).toBe(1);
});

test("a server that inits then crashes on every diagnose gives up (init doesn't reset the budget)", async () => {
  // The server starts cleanly but dies the instant it's used. A clean init must
  // NOT reset the crash budget — only a completed diagnose does — so crash-on-use
  // keeps accumulating toward maxRestarts and eventually gives up (→ undefined)
  // instead of respawning forever.
  const created: FakeClient[] = [];
  const factory: LspClientFactory = () => {
    const c = makeFake({
      diagnose: async () => {
        c.emitExit(1); // the server dies mid-request
        throw new Error("server died during diagnose");
      },
    });
    created.push(c);
    return c;
  };
  const config = LspConfigSchema.parse({ timeoutMs: 40, idleShutdownMs: 0 });
  const manager = new LspDiagnostics({
    config,
    workspaceRoot: () => "/root",
    which: () => "/usr/bin/fake",
    clientFactory: factory,
    restartBackoffMs: 0,
    maxRestarts: 3,
    initializeTimeoutMs: 1_000,
  });

  for (let i = 0; i < 6; i++) expect(await manager.diagnose("/proj/app.py")).toBeUndefined();

  // Exactly maxRestarts (3) spawns happened before giving up — no unbounded churn.
  expect(created.length).toBe(3);
  expect(manager.status().find((s) => s.language === "py")?.state).toBe("crashed");
});

test("dispose tears every spawned server down", async () => {
  const { manager, created } = makeManager({ diagnose: async () => "  err" });
  await manager.diagnose("/proj/app.py");
  expect(created.length).toBe(1);
  manager.dispose();
  expect(created[0]!.disposeCalls).toBe(1);
  // After dispose, diagnose is inert.
  expect(await manager.diagnose("/proj/app.py")).toBeUndefined();
});
