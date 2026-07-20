import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand } from "../shared/commands";
import type { HostRpcParams, RpcMethod } from "../shared/protocol";
import { EngineBridge, type EngineStartOptions } from "./engine-bridge";
import { LocalRuntimeSupervisor } from "./local-runtime-supervisor";

class FakeBridge extends EngineBridge {
  running = false;
  ready = false;
  stopped = 0;
  disposed = 0;
  failStart = false;
  failStop = false;
  retainOwnershipOnStop = false;
  startBarrier: Promise<void> | null = null;

  constructor(readonly fixtureSessionId: string) {
    super();
    this.lastLaunchDescription = `fake:${fixtureSessionId}`;
  }

  override get isRunning(): boolean { return this.running; }
  override get isReady(): boolean { return this.ready; }
  override async start(options: EngineStartOptions): Promise<string> {
    this.running = true;
    if (this.startBarrier) await this.startBarrier;
    if (this.failStart) throw new Error("fixture start failed");
    this.ready = true;
    const id = options.resume ?? this.fixtureSessionId;
    this.onReady?.(id, {
      protocolVersion: 2,
      engineRevision: "test",
      capabilities: ["event-replay"],
      hostInstanceId: `host:${id}`,
    });
    return id;
  }

  override async stop(): Promise<void> {
    this.stopped += 1;
    if (this.failStop) throw new Error("fixture stop failed");
    if (this.retainOwnershipOnStop) return;
    this.running = false;
    this.ready = false;
  }

  override async disposeForQuit(): Promise<void> {
    this.disposed += 1;
    this.running = false;
    this.ready = false;
  }

  override send(_command: EngineCommand): void {
    if (!this.ready) throw new Error("not ready");
  }

  override rpc(method: RpcMethod, _params?: HostRpcParams): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error("not ready"));
    if (method === "snapshot") return Promise.resolve({ sessionId: this.fixtureSessionId });
    return Promise.resolve(null);
  }

  override async detachForHandoff(): Promise<void> {
    this.running = false;
    this.ready = false;
  }

  emit(event: unknown): void { this.onEvent?.(event); }
}

afterEach(() => vi.useRealTimers());

function fixture(options: { capacity?: number; idleTtlMs?: number; now?: () => number } = {}) {
  const bridges: FakeBridge[] = [];
  const supervisor = new LocalRuntimeSupervisor({
    ...options,
    createBridge: () => {
      const bridge = new FakeBridge(`s${bridges.length + 1}`);
      bridges.push(bridge);
      return bridge;
    },
  });
  return { supervisor, bridges };
}

describe("LocalRuntimeSupervisor", () => {
  it("keeps two streaming sessions alive and forwards only the foreground transcript", async () => {
    const { supervisor, bridges } = fixture();
    const foreground: string[] = [];
    const readyHosts: Array<string | undefined> = [];
    const statuses: Array<{ sessionId: string; state: string; foreground: boolean }> = [];
    supervisor.onEvent = (event) => {
      if (event && typeof event === "object" && "sessionId" in event) foreground.push(String(event.sessionId));
    };
    supervisor.onStatus = (status) => statuses.push(status);
    supervisor.onReady = (_sessionId, info) => readyHosts.push(info?.hostInstanceId);

    await supervisor.start({ cwd: "/repo/a" });
    bridges[0]!.emit({ type: "user-message", sessionId: "s1", text: "one" });
    await supervisor.start({ cwd: "/repo/b" });
    bridges[1]!.emit({ type: "user-message", sessionId: "s2", text: "two" });
    bridges[0]!.emit({ type: "assistant-text-delta", sessionId: "s1", delta: "background" });

    expect(bridges[0]!.isRunning).toBe(true);
    expect(bridges[0]!.stopped).toBe(0);
    expect(foreground).toEqual(["s1", "s2"]);
    expect(statuses).toContainEqual(expect.objectContaining({ sessionId: "s1", state: "working", foreground: false }));

    await supervisor.start({ cwd: "/repo/a", resume: "s1" });
    bridges[0]!.emit({ type: "assistant-text-delta", sessionId: "s1", delta: "foreground" });
    expect(foreground).toEqual(["s1", "s2", "s1"]);
    expect(bridges).toHaveLength(2);
    expect(readyHosts.at(-1)).toBe("host:s1");
  });

  it("records background turn performance without forwarding background transcript events", async () => {
    const { supervisor, bridges } = fixture();
    const forwarded: string[] = [];
    const background: string[] = [];
    supervisor.onEvent = (event) => {
      if (event && typeof event === "object" && "type" in event) forwarded.push(String(event.type));
    };
    supervisor.onBackgroundEvent = (event) => {
      if (event && typeof event === "object" && "type" in event) background.push(String(event.type));
    };
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "user-message", sessionId: "s1", text: "work" });
    await supervisor.start({ cwd: "/repo/2" });
    forwarded.length = 0;

    bridges[0]!.emit({ type: "assistant-text-delta", sessionId: "s1", delta: "hidden" });
    bridges[0]!.emit({
      type: "turn-performance",
      sessionId: "s1",
      sample: {
        turnId: "turn-1", sessionId: "s1", model: "m/x", serviceTier: "default",
        startedAt: 0, queueDelayMs: 0, hooksMs: 0, checkpointMs: 0, recallMs: 0,
        attachmentsMs: 0, modelResolveMs: 0, contextPrepareMs: 0, generationMs: 20,
        toolMs: 0, persistMs: 0, postTurnMs: 0, totalMs: 20,
      },
    });

    expect(forwarded).toEqual([]);
    expect(background).toEqual(["turn-performance"]);
  });

  it("never publishes a temporary key for a resumed runtime", async () => {
    const { supervisor } = fixture();
    const keys: string[] = [];
    supervisor.onStatus = (status) => keys.push(status.key);

    await supervisor.start({ cwd: "/repo/resume", resume: "known-session" });

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.startsWith("pending:"))).toBe(false);
  });

  it("refuses a fourth runtime when all three are pinned", async () => {
    const { supervisor, bridges } = fixture();
    for (let index = 0; index < 3; index += 1) {
      await supervisor.start({ cwd: `/repo/${index}` });
      bridges[index]!.emit({ type: "user-message", sessionId: `s${index + 1}`, text: "busy" });
    }
    await expect(supervisor.start({ cwd: "/repo/4" })).rejects.toThrow(
      "Local runtime capacity (3) is full",
    );
    expect(bridges).toHaveLength(3);
  });

  it("reclaims the least-recently-used fresh idle background runtime at capacity", async () => {
    let now = 1_000;
    const { supervisor, bridges } = fixture({ capacity: 3, idleTtlMs: 10_000, now: () => now });
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    now += 10;
    await supervisor.start({ cwd: "/repo/2" });
    bridges[1]!.emit({ type: "engine-idle", sessionId: "s2", gate: "green" });
    now += 10;
    await supervisor.start({ cwd: "/repo/3" });
    now += 10;

    await expect(supervisor.start({ cwd: "/repo/4" })).resolves.toBe("s4");

    expect(bridges[0]!.stopped).toBe(1);
    expect(bridges[1]!.stopped).toBe(0);
    expect(bridges[2]!.stopped).toBe(0);
    expect(bridges).toHaveLength(4);
    expect(supervisor.size).toBe(3);
  });

  it("preserves the capacity error when every runtime is blocked or foreground", async () => {
    const { supervisor, bridges } = fixture({ capacity: 3 });
    await supervisor.start({ cwd: "/repo/input" });
    bridges[0]!.emit({
      type: "permission-request",
      sessionId: "s1",
      id: "p1",
      toolName: "bash",
      input: {},
    });
    await supervisor.start({ cwd: "/repo/review" });
    bridges[1]!.emit({ type: "plan-presented", sessionId: "s2", plan: "Review me" });
    await supervisor.start({ cwd: "/repo/foreground" });
    bridges[2]!.emit({ type: "engine-idle", sessionId: "s3", gate: "green" });

    await expect(supervisor.start({ cwd: "/repo/4" })).rejects.toThrow(
      "Local runtime capacity (3) is full",
    );

    expect(bridges.map((bridge) => bridge.stopped)).toEqual([0, 0, 0]);
    expect(bridges).toHaveLength(3);
    expect(supervisor.size).toBe(3);
  });

  it("prevents two writable hosts from owning the same canonical workspace", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/shared" });
    bridges[0]!.emit({ type: "user-message", sessionId: "s1", text: "working" });

    await expect(supervisor.start({ cwd: "/repo/shared", resume: "other" })).rejects.toThrow(
      "already has a working local session",
    );
    expect(bridges).toHaveLength(1);
  });

  it("rejects ancestor and descendant workspace overlap", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/shared" });
    bridges[0]!.emit({ type: "user-message", sessionId: "s1", text: "working" });

    await expect(supervisor.start({ cwd: "/repo/shared/packages/app", resume: "other" })).rejects.toThrow(
      "already has a working local session",
    );
    expect(bridges).toHaveLength(1);
  });

  it("pins a submitted turn before the host echoes its first event", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/shared" });

    supervisor.send({ type: "submit-prompt", text: "start now" });

    await expect(supervisor.start({ cwd: "/repo/shared", resume: "other" })).rejects.toThrow(
      "already has a working local session",
    );
    expect(bridges[0]!.stopped).toBe(0);
  });

  it("replaces an idle owner before opening another session in that workspace", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/shared" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });

    await expect(supervisor.start({ cwd: "/repo/shared", resume: "other" })).resolves.toBe("other");
    expect(bridges[0]!.stopped).toBe(1);
    expect(bridges).toHaveLength(2);
  });

  it("pins permission/review waits and evicts only the oldest expired idle runtime", async () => {
    let now = 1_000;
    const { supervisor, bridges } = fixture({ idleTtlMs: 100, now: () => now });
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    now += 10;
    await supervisor.start({ cwd: "/repo/2" });
    bridges[1]!.emit({ type: "engine-idle", sessionId: "s2", gate: "green" });
    now += 10;
    await supervisor.start({ cwd: "/repo/3" });
    bridges[2]!.emit({ type: "engine-idle", sessionId: "s3", gate: "red" });
    now += 200;

    await supervisor.start({ cwd: "/repo/4" });
    expect(bridges[0]!.stopped).toBe(1);
    expect(bridges[1]!.stopped).toBe(0);
    expect(bridges[2]!.stopped).toBe(0);
    expect(bridges).toHaveLength(4);
  });

  it("drains every owned runtime on quit", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/1" });
    await supervisor.start({ cwd: "/repo/2" });
    await supervisor.start({ cwd: "/repo/3" });

    await supervisor.disposeForQuit();
    expect(supervisor.isRunning).toBe(false);
    expect(bridges.map((bridge) => bridge.disposed)).toEqual([1, 1, 1]);
  });

  it("serializes terminal disposal behind in-flight starts and rejects queued starts", async () => {
    let releaseStart!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseStart = resolve; });
    const { supervisor } = fixture();
    await supervisor.start({ cwd: "/repo/1" });

    const held = new FakeBridge("held");
    held.startBarrier = barrier;
    supervisor.stageNextBridge(held);
    const inFlight = supervisor.start({ cwd: "/repo/held" });
    await vi.waitFor(() => expect(held.isRunning).toBe(true));
    const queued = supervisor.start({ cwd: "/repo/queued" });
    const disposing = supervisor.disposeForQuit();
    releaseStart();

    await expect(inFlight).resolves.toBe("held");
    await expect(queued).rejects.toThrow("has been disposed");
    await disposing;
    await expect(supervisor.start({ cwd: "/repo/future" })).rejects.toThrow("has been disposed");
    expect(held.disposed).toBe(1);
    expect(supervisor.isRunning).toBe(false);
  });

  it("stops every owned runtime at a cross-process ownership boundary", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/1" });
    await supervisor.start({ cwd: "/repo/2" });
    await supervisor.start({ cwd: "/repo/3" });

    await supervisor.stopAll();

    expect(supervisor.isRunning).toBe(false);
    expect(supervisor.size).toBe(0);
    expect(bridges.map((bridge) => bridge.stopped)).toEqual([1, 1, 1]);
  });

  it("retains supervision when a runtime cannot release its engine host", async () => {
    const { supervisor, bridges } = fixture();
    const statuses: Array<{ sessionId: string; state: string }> = [];
    supervisor.onStatus = (status) => statuses.push(status);
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.retainOwnershipOnStop = true;

    await expect(supervisor.stopAll()).rejects.toThrow("Failed to stop every local runtime");

    expect(supervisor.size).toBe(1);
    expect(supervisor.isRunning).toBe(true);
    expect(supervisor.activeSessionId).toBe("s1");
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ sessionId: "s1", state: "failed" }));

    bridges[0]!.retainOwnershipOnStop = false;
    await supervisor.stopAll();
  });

  it("replaces a crashed runtime when the fresh host resumes the same session id", async () => {
    const bridges: FakeBridge[] = [];
    const supervisor = new LocalRuntimeSupervisor({
      createBridge: () => {
        const bridge = new FakeBridge("same-session");
        bridges.push(bridge);
        return bridge;
      },
    });
    await supervisor.start({ cwd: "/repo" });
    bridges[0]!.running = false;
    bridges[0]!.ready = false;
    bridges[0]!.onFatal?.("crashed");

    await expect(supervisor.start({ cwd: "/repo" })).resolves.toBe("same-session");

    expect(supervisor.activeBridge).toBe(bridges[1]);
    expect(supervisor.size).toBe(1);
    expect(await supervisor.rpc("snapshot")).toEqual({ sessionId: "same-session" });
  });

  it("removes failed runtimes before enforcing bounded capacity", async () => {
    const { supervisor, bridges } = fixture({ capacity: 3 });
    for (let index = 0; index < 3; index += 1) {
      await supervisor.start({ cwd: `/repo/${index + 1}` });
      bridges[index]!.emit({ type: "user-message", sessionId: `s${index + 1}`, text: "work" });
    }
    bridges[0]!.running = false;
    bridges[0]!.ready = false;
    bridges[0]!.onFatal?.("crashed");

    await expect(supervisor.start({ cwd: "/repo/4" })).resolves.toBe("s4");

    expect(supervisor.size).toBe(3);
    expect(bridges).toHaveLength(4);
  });

  it("restores and re-announces the previous foreground runtime when a switch fails", async () => {
    const bridges = [new FakeBridge("stable"), new FakeBridge("broken")];
    bridges[1]!.failStart = true;
    let next = 0;
    const supervisor = new LocalRuntimeSupervisor({ createBridge: () => bridges[next++]! });
    const ready: string[] = [];
    supervisor.onReady = (sessionId) => ready.push(sessionId);

    await supervisor.start({ cwd: "/repo/stable" });
    await expect(supervisor.start({ cwd: "/repo/broken" })).rejects.toThrow("fixture start failed");

    expect(supervisor.activeSessionId).toBe("stable");
    expect(supervisor.isReady).toBe(true);
    expect(ready).toEqual(["stable", "stable"]);
  });

  it("moves blocked runtimes back to working or idle as gates resolve", async () => {
    const { supervisor, bridges } = fixture();
    const statuses: Array<{ state: string }> = [];
    supervisor.onStatus = (status) => statuses.push(status);
    await supervisor.start({ cwd: "/repo" });
    const bridge = bridges[0]!;

    bridge.emit({ type: "permission-request", sessionId: "s1", id: "p1", toolName: "bash", input: {} });
    expect(statuses.at(-1)?.state).toBe("needs-input");
    supervisor.send({ type: "resolve-permission", id: "p1", decision: "once" });
    expect(statuses.at(-1)?.state).toBe("working");

    bridge.emit({ type: "plan-presented", sessionId: "s1", plan: "Do it" });
    expect(statuses.at(-1)?.state).toBe("needs-review");
    bridge.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    expect(statuses.at(-1)?.state).toBe("needs-review");
    bridge.emit({ type: "plan-state-changed", sessionId: "s1", state: { status: "active", updatedAt: 1 } });
    expect(statuses.at(-1)?.state).toBe("idle");
    bridge.emit({ type: "plan-state-changed", sessionId: "s1", state: { status: "pending", updatedAt: 2 } });
    expect(statuses.at(-1)?.state).toBe("needs-review");
    supervisor.send({ type: "resolve-plan", decision: "accept" });
    expect(statuses.at(-1)?.state).toBe("working");

    bridge.emit({
      type: "external-capability-pending",
      sessionId: "s1",
      request: {
        id: "cap1",
        integration: "connector",
        toolName: "call",
        arguments: {},
        approvalScope: "once",
        originatingTurn: "turn1",
        status: "pending",
        createdAt: 1,
      },
    });
    expect(statuses.at(-1)?.state).toBe("needs-input");
    bridge.emit({ type: "external-capability-resolved", sessionId: "s1", id: "cap1", status: "resolved" });
    expect(statuses.at(-1)?.state).toBe("working");

    bridge.emit({ type: "engine-error", sessionId: "s1", message: "host failed" });
    bridge.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    expect(statuses.at(-1)?.state).toBe("failed");
  });

  it("ages out an idle background runtime even when capacity is not full", async () => {
    const { supervisor, bridges } = fixture({ idleTtlMs: 1 });
    const statuses: Array<{ sessionId: string; state: string }> = [];
    supervisor.onStatus = (status) => statuses.push(status);
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    await supervisor.start({ cwd: "/repo/2" });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridges[0]!.stopped).toBe(1);
    expect(supervisor.size).toBe(1);
    expect(statuses).toContainEqual(expect.objectContaining({ sessionId: "s1", state: "stopped" }));
  });

  it("reschedules idle eviction from the latest background activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { supervisor, bridges } = fixture({ idleTtlMs: 100 });
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    await supervisor.start({ cwd: "/repo/2" });

    await vi.advanceTimersByTimeAsync(50);
    bridges[0]!.emit({ type: "notice", level: "info", message: "background heartbeat" });
    await vi.advanceTimersByTimeAsync(50);
    expect(bridges[0]!.stopped).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(bridges[0]!.stopped).toBe(1);
  });

  it("pins idle runtimes while their background jobs are running", async () => {
    vi.useFakeTimers();
    const { supervisor, bridges } = fixture({ idleTtlMs: 10 });
    const runningJob = {
      id: "job-1",
      command: "npm test",
      status: "running" as const,
      exitCode: null,
      servers: [],
      outputTail: "",
    };
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    bridges[0]!.emit({ type: "jobs-changed", sessionId: "s1", jobs: [runningJob] });
    await supervisor.start({ cwd: "/repo/2" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridges[0]!.stopped).toBe(0);
    await expect(supervisor.retireSession("/repo/1", "s1"))
      .resolves.toEqual({ ok: false, state: "jobs-running" });

    bridges[0]!.emit({
      type: "jobs-changed",
      sessionId: "s1",
      jobs: [{ ...runningJob, status: "exited", exitCode: 0 }],
    });
    await expect(supervisor.retireSession("/repo/1", "s1"))
      .resolves.toEqual({ ok: true, retired: true });
    expect(bridges[0]!.stopped).toBe(1);
  });

  it("retires an idle background session before its persisted record is mutated", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    await supervisor.start({ cwd: "/repo/2" });

    await expect(supervisor.retireSession("/repo/1", "s1"))
      .resolves.toEqual({ ok: true, retired: true });
    expect(bridges[0]!.stopped).toBe(1);
    expect(supervisor.size).toBe(1);
  });

  it("allows active rename but blocks destructive active-session retirement", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/active" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });

    await expect(supervisor.retireSession("/repo/active", "s1", true))
      .resolves.toEqual({ ok: true, retired: false });
    await expect(supervisor.retireSession("/repo/active", "s1"))
      .resolves.toEqual({ ok: false, state: "foreground" });
    expect(bridges[0]!.stopped).toBe(0);
  });

  it("refuses to mutate a pinned background session", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "user-message", sessionId: "s1", text: "work" });
    await supervisor.start({ cwd: "/repo/2" });

    await expect(supervisor.retireSession("/repo/1", "s1"))
      .resolves.toEqual({ ok: false, state: "working" });
    expect(bridges[0]!.stopped).toBe(0);
  });

  it("refuses to retire a project while its sole writable runtime is pinned", async () => {
    const { supervisor, bridges } = fixture();
    await supervisor.start({ cwd: "/repo/1" });
    bridges[0]!.emit({ type: "engine-idle", sessionId: "s1", gate: "green" });
    await supervisor.start({ cwd: "/repo/1" });
    bridges[1]!.emit({ type: "user-message", sessionId: "s2", text: "work" });
    await supervisor.start({ cwd: "/repo/2" });

    await expect(supervisor.retireProject("/repo/1"))
      .resolves.toEqual({ ok: false, state: "working" });
    expect(bridges[0]!.stopped).toBe(1);
    expect(bridges[1]!.stopped).toBe(0);
  });
});
