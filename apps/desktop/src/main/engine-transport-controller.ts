import type { CappedReadResult } from "../shared/capped-read";
import type { EngineCommand } from "../shared/commands";
import { estimateJsonUtf8Bytes } from "../shared/json-size";
import type { LocalRuntimeStatus } from "../shared/local-runtime";
import type { PerformancePhaseSample } from "../shared/performance";
import type { HostRpcParams, RpcMethod } from "../shared/protocol";
import { isEngineSnapshot } from "../shared/runtime-guards";
import type { TerminalCommandResult, TerminalEvent, TerminalOpenRequest, TerminalOpenResult } from "../shared/terminal";
import type { EngineSnapshot } from "../shared/types";
import { EngineBridge, type EngineStartOptions } from "./engine-bridge";
import type {
  EngineTransport,
  EngineTransportEventHandler,
  EngineTransportReadyHandler,
  EngineTransportResyncHandler,
} from "./engine-transport";
import { LocalRuntimeSupervisor, type RuntimeRetirementResult } from "./local-runtime-supervisor";
import { RemoteEngineTransport } from "./remote-engine-transport";

export class EngineTransportController implements EngineTransport {
  readonly #indexBridge = new EngineBridge();
  readonly #authBridge = new EngineBridge();
  readonly #locals: LocalRuntimeSupervisor;
  #indexBridgeConsumed = false;
  #active: EngineTransport;
  #remote: RemoteEngineTransport | null = null;
  #remoteCwd: string | null = null;
  #remoteSourceCwd: string | null = null;
  #remoteActivationEvents: Array<{ event: unknown; bytes: number }> | null = null;
  #remoteActivationBytes = 0;
  #provisionalBridge: EngineBridge | null = null;
  #provisionalRuntime: { cwd: string; sessionId: string } | null = null;
  #localLifecycleTail: Promise<void> = Promise.resolve();
  #localOwnershipEpoch = 0;
  #localOwnershipReleased = false;
  #disposed = false;

  onEvent: EngineTransportEventHandler | null = null;
  onTerminalEvent: ((event: TerminalEvent) => void) | null = null;
  onFatal: ((message: string) => void) | null = null;
  onReady: EngineTransportReadyHandler | null = null;
  onResync: EngineTransportResyncHandler | null = null;
  onPerformancePhase: ((sample: PerformancePhaseSample) => void) | null = null;
  onBackgroundEvent: ((event: unknown) => void) | null = null;
  onLocalRuntimeStatus: ((status: LocalRuntimeStatus) => void) | null = null;
  onTransportWillSwitch: (() => void) | null = null;

  constructor() {
    this.#locals = new LocalRuntimeSupervisor({
      createBridge: () => {
        if (!this.#indexBridgeConsumed) {
          this.#indexBridgeConsumed = true;
          return this.#indexBridge;
        }
        return new EngineBridge();
      },
    });
    this.#locals.onWillSwitch = () => this.onTransportWillSwitch?.();
    this.#locals.onStatus = (status) => this.onLocalRuntimeStatus?.(status);
    this.#locals.onBackgroundEvent = (event) => this.onBackgroundEvent?.(event);
    this.#active = this.#locals;
    this.#wire(this.#locals);
  }

  /** The foreground local bridge for ownership-sensitive Cloud handoff RPCs. */
  get local(): EngineBridge {
    return this.#locals.activeBridge ?? this.#provisionalBridge ?? this.#indexBridge;
  }

  get isRunning(): boolean {
    return this.#active.isRunning
      || this.#locals.isRunning
      || this.#provisionalBridge?.isRunning === true
      || this.#remote?.isRunning === true
      || this.#authBridge.isRunning
      || this.#indexBridge.isRunning;
  }
  get isReady(): boolean { return this.#active.isReady; }
  get isRemote(): boolean { return this.#active !== this.#locals; }
  get lastLaunchDescription(): string { return this.isRemote ? "Cloud agent" : this.#locals.lastLaunchDescription; }
  get lastStderr(): string { return this.isRemote ? "" : this.#locals.lastStderr; }

  start(options: EngineStartOptions): Promise<string> {
    const ownershipEpoch = this.#localOwnershipEpoch;
    if (this.#disposed || this.#localOwnershipReleased) {
      return Promise.reject(new Error("Local runtime ownership is not available"));
    }
    const operation = this.#localLifecycleTail.then(async () => {
      if (this.#disposed || this.#localOwnershipReleased || ownershipEpoch !== this.#localOwnershipEpoch) {
        throw new Error("Local runtime ownership changed before the engine could start");
      }
      if (this.#active !== this.#locals) this.onTransportWillSwitch?.();
      // A project/session switch only detaches this desktop. The cloud owner,
      // its PTYs, and jobs continue until an explicit return or destroy action.
      if (this.#remote) await this.#remote.disposeForQuit();
      this.#remote = null;
      this.#remoteCwd = null;
      this.#remoteSourceCwd = null;
      this.#remoteActivationEvents = null;
      this.#remoteActivationBytes = 0;
      this.#active = this.#locals;
      this.#wire(this.#locals);
      return this.#locals.start(options);
    });
    this.#localLifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async switchToRemote(
    connection: { url: string; accessToken: string; headers?: Record<string, string> },
    options: EngineStartOptions,
    handoff: { preserveLocal?: boolean; sourceCwd?: string } = {},
  ): Promise<string> {
    this.onTransportWillSwitch?.();
    if (this.#remote) {
      await this.#remote.disposeForQuit();
      this.#remote = null;
    }
    if (handoff.preserveLocal === false && this.#locals.isReady) await this.#locals.stop();
    const remote = new RemoteEngineTransport(connection);
    this.#remote = remote;
    this.#remoteCwd = options.cwd;
    this.#remoteSourceCwd = handoff.sourceCwd ?? options.cwd;
    this.#active = remote;
    this.#remoteActivationEvents = [];
    this.#remoteActivationBytes = 0;
    this.#wire(remote);
    try {
      return await remote.start(options);
    } catch (error) {
      await remote.disposeForQuit().catch(() => undefined);
      this.#remoteActivationEvents = null;
      this.#remoteActivationBytes = 0;
      if (this.#remote === remote) this.#remote = null;
      this.#remoteCwd = null;
      this.#remoteSourceCwd = null;
      if (this.#active === remote) {
        this.#active = this.#locals;
        this.#wire(this.#locals);
      }
      throw error;
    }
  }

  async completeLocalHandoff(): Promise<void> {
    await this.#locals.detachActiveForHandoff();
  }

  async completeRemoteHandoff(): Promise<void> {
    this.onTransportWillSwitch?.();
    const remote = this.#remote;
    if (!remote) throw new Error("Cloud transport is unavailable for ownership detach");
    await remote.detachForHandoff();
    if (this.#remote === remote) this.#remote = null;
    this.#remoteCwd = null;
    this.#remoteSourceCwd = null;
    this.#remoteActivationEvents = null;
    this.#remoteActivationBytes = 0;
    this.#active = this.#locals;
    this.#provisionalRuntime = null;
    this.#wire(this.#locals);
  }

  retireLocalSessionForMutation(cwd: string, sessionId: string, allowActive = false): Promise<RuntimeRetirementResult> {
    return this.#locals.retireSession(cwd, sessionId, allowActive);
  }

  retireLocalProjectForMutation(cwd: string): Promise<RuntimeRetirementResult> {
    return this.#locals.retireProject(cwd);
  }

  async disconnectRemote(): Promise<void> {
    const remote = this.#remote;
    if (remote) await remote.disposeForQuit();
    if (this.#remote === remote) this.#remote = null;
    this.#remoteActivationEvents = null;
    this.#remoteActivationBytes = 0;
    this.#active = this.#locals;
    this.#wire(this.#locals);
  }

  startProvisionalLocal(options: EngineStartOptions): Promise<string> {
    const ownershipEpoch = this.#localOwnershipEpoch;
    if (this.#disposed || this.#localOwnershipReleased) {
      return Promise.reject(new Error("Local runtime ownership is not available"));
    }
    const operation = this.#localLifecycleTail.then(() => {
      if (this.#disposed || this.#localOwnershipReleased || ownershipEpoch !== this.#localOwnershipEpoch) {
        throw new Error("Local runtime ownership changed before the provisional engine could start");
      }
      if (this.#provisionalBridge) {
        this.#locals.stageNextBridge(this.#provisionalBridge);
        this.#provisionalBridge = null;
      }
      return this.#locals.start(options).then((sessionId) => {
        this.#provisionalRuntime = { cwd: options.cwd, sessionId };
        return sessionId;
      });
    });
    this.#localLifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async importPortableSession(cwd: string, archive: import("../shared/handoff").PortableSessionArchiveV1, revision: string, provisional = false): Promise<void> {
    const bridge = new EngineBridge();
    await bridge.importPortableSession(cwd, archive, revision, provisional);
    this.#provisionalBridge = bridge;
  }

  commitPortableImport(cwd: string, sessionId: string, generation: number): Promise<void> {
    return this.local.commitPortableImport(cwd, sessionId, generation);
  }

  async abortPortableImport(cwd: string, sessionId: string, generation: number): Promise<void> {
    // Rollback is a store mutation, not a foreground-runtime operation. A
    // fresh helper guarantees that cleanup cannot stop an unrelated local
    // session after the provisional bridge has moved into the supervisor.
    const helper = new EngineBridge();
    try { await helper.abortPortableImport(cwd, sessionId, generation); }
    finally { await helper.disposeForQuit().catch(() => undefined); }
  }

  async abortProvisionalLocal(cwd: string, sessionId: string): Promise<void> {
    const provisional = this.#provisionalRuntime;
    if (!provisional || provisional.cwd !== cwd || provisional.sessionId !== sessionId) return;
    await this.#locals.detachSessionForHandoff(cwd, sessionId);
    if (this.#provisionalRuntime === provisional) this.#provisionalRuntime = null;
  }

  async recoverLostCloudOwnership(cwd: string, sessionId: string, provider: "e2b" | "vercel", generation: number): Promise<number> {
    const helper = new EngineBridge();
    try { return await helper.recoverLostCloudOwnership(cwd, sessionId, provider, generation); }
    finally { await helper.disposeForQuit().catch(() => undefined); }
  }

  async abortInterruptedLocalHandoff(
    cwd: string,
    sessionId: string,
    target: import("../shared/cloud").ExecutionTarget,
    expectedGeneration?: number,
  ): Promise<{ outcome: "aborted" | "already-committed"; generation: number }> {
    const helper = new EngineBridge();
    try { return await helper.abortInterruptedHandoff(cwd, sessionId, target, expectedGeneration); }
    finally { await helper.disposeForQuit().catch(() => undefined); }
  }

  async stop(): Promise<void> {
    this.onTransportWillSwitch?.();
    const wasRemote = this.isRemote;
    await this.#active.stop();
    if (wasRemote) this.#remote = null;
    this.#remoteCwd = null;
    this.#remoteSourceCwd = null;
    this.#remoteActivationEvents = null;
    this.#remoteActivationBytes = 0;
    this.#active = this.#locals;
    this.#wire(this.#locals);
  }

  /** Release every runtime owned by this process before control moves to a
   * different desktop/phone process. Ordinary renderer detach/stop paths keep
   * their narrower foreground-only behavior. */
  stopAllOwnedRuntimes(options: { preserveRemote?: boolean } = {}): Promise<void> {
    this.onTransportWillSwitch?.();
    // Invalidate queued starts immediately, then drain behind any operation
    // that already owns the lifecycle. Ownership remains unavailable until
    // the desktop/relay receives an explicit return boundary.
    this.#localOwnershipReleased = true;
    this.#localOwnershipEpoch += 1;
    const operation = this.#localLifecycleTail.then(async () => {
      const remote = this.#remote;
      const provisional = this.#provisionalBridge;
      this.#provisionalBridge = null;
      this.#provisionalRuntime = null;
      const results = await Promise.allSettled([
        remote
          ? options.preserveRemote
            ? remote.disposeForQuit()
            : remote.stop()
          : Promise.resolve(),
        this.#locals.stopAll(),
        this.#authBridge.disposeForQuit(),
        this.#indexBridgeConsumed ? Promise.resolve() : this.#indexBridge.disposeForQuit(),
        provisional?.disposeForQuit() ?? Promise.resolve(),
      ]);
      this.#remote = null;
      this.#remoteCwd = null;
      this.#remoteSourceCwd = null;
      this.#remoteActivationEvents = null;
      this.#remoteActivationBytes = 0;
      this.#active = this.#locals;
      this.#wire(this.#locals);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Failed to stop every owned runtime",
        );
      }
    });
    this.#localLifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  restoreLocalRuntimeOwnership(): void {
    if (!this.#disposed) this.#localOwnershipReleased = false;
  }

  disposeForQuit(): Promise<void> {
    if (this.#disposed) return this.#localLifecycleTail;
    this.#disposed = true;
    this.#localOwnershipReleased = true;
    this.#localOwnershipEpoch += 1;
    const operation = this.#localLifecycleTail.then(async () => {
      await Promise.allSettled([
        this.#remote?.disposeForQuit() ?? Promise.resolve(),
        this.#locals.disposeForQuit(),
        this.#indexBridgeConsumed ? Promise.resolve() : this.#indexBridge.disposeForQuit(),
        this.#authBridge.disposeForQuit(),
        this.#provisionalBridge?.disposeForQuit() ?? Promise.resolve(),
      ]);
    });
    this.#localLifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  send(command: EngineCommand): void { this.#active.send(command); }

  isRemoteWorkspaceCwd(cwd: string): boolean {
    return this.isRemote && (this.#remoteCwd === cwd || this.#remoteSourceCwd === cwd);
  }

  remoteTerminalOpen(request: TerminalOpenRequest): Promise<TerminalOpenResult> {
    if (!this.#remote || this.#active !== this.#remote || !this.isRemoteWorkspaceCwd(request.cwd)) {
      return Promise.resolve({ ok: false, error: "Cloud terminal is unavailable for this workspace" });
    }
    return this.#remote.terminalOpen(request);
  }

  remoteTerminalWrite(id: string, data: string): TerminalCommandResult {
    if (!this.#remote || this.#active !== this.#remote) return { ok: false, error: "Cloud terminal is unavailable" };
    return this.#remote.terminalWrite(id, data);
  }

  remoteTerminalResize(id: string, cols: number, rows: number): TerminalCommandResult {
    if (!this.#remote || this.#active !== this.#remote) return { ok: false, error: "Cloud terminal is unavailable" };
    return this.#remote.terminalResize(id, cols, rows);
  }

  remoteReadTextFile(cwd: string, path: string, maxBytes: number): Promise<CappedReadResult> {
    if (!this.#remote || this.#active !== this.#remote || !this.isRemoteWorkspaceCwd(cwd)) {
      return Promise.resolve({ ok: false, error: "Cloud file preview is unavailable for this workspace" });
    }
    return this.#remote.readTextFile(path, maxBytes);
  }

  remoteWriteFile(cwd: string, path: string, data: Buffer, mode?: number): Promise<TerminalCommandResult> {
    if (!this.#remote || this.#active !== this.#remote || !this.isRemoteWorkspaceCwd(cwd)) {
      return Promise.resolve({ ok: false, error: "Cloud file upload is unavailable for this workspace" });
    }
    return this.#remote.writeFile(path, data, mode);
  }

  /** Read the provisional remote snapshot without releasing activation events.
   * The renderer's later attach remains the sole hydration boundary. */
  async snapshotForHandoff(): Promise<EngineSnapshot> {
    if (!this.isRemote) throw new Error("Cloud transport is not active");
    const value = await this.#active.rpc("snapshot");
    if (!isEngineSnapshot(value)) throw new Error("Cloud session continuity failed: remote snapshot is invalid");
    return value;
  }

  async rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    const transport = this.#active;
    const value = await transport.rpc(method, params);
    if (method === "snapshot" && transport === this.#remote && this.#remoteActivationEvents) {
      // Renderer attach installs its own bounded hydration queue before asking
      // for this snapshot. Releasing here makes the snapshot authoritative and
      // lets every event observed during remote startup replay after hydration.
      const events = this.#remoteActivationEvents;
      this.#remoteActivationEvents = null;
      this.#remoteActivationBytes = 0;
      for (const { event } of events) this.onEvent?.(event);
    }
    return value;
  }
  projectIndexRpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    const ownershipEpoch = this.#localOwnershipEpoch;
    if (this.#disposed || this.#localOwnershipReleased) {
      return Promise.reject(new Error("Local runtime ownership is not available"));
    }
    const operation = this.#localLifecycleTail.then(async () => {
      if (this.#disposed || this.#localOwnershipReleased || ownershipEpoch !== this.#localOwnershipEpoch) {
        throw new Error("Local runtime ownership changed before the project operation could start");
      }
      if (this.#locals.isReady) return this.#locals.rpc(method, params);
      if (method === "listProjects" && !this.#indexBridgeConsumed) return this.#indexBridge.listProjectsForIndex();
      const helper = new EngineBridge();
      try { return await helper.rpcWithTemporaryHost(method, params); }
      finally { await helper.disposeForQuit().catch(() => undefined); }
    });
    this.#localLifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  providerAuthRpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    return this.#authBridge.providerAuthRpc(method, params);
  }
  listProjectsForIndex(): Promise<unknown> {
    return this.#indexBridgeConsumed
      ? this.projectIndexRpc("listProjects")
      : this.#indexBridge.listProjectsForIndex();
  }

  #wire(transport: EngineTransport): void {
    if (transport instanceof RemoteEngineTransport) {
      transport.onTerminalEvent = (event) => {
        if (this.#active === transport) this.onTerminalEvent?.(event);
      };
    }
    transport.onEvent = (event, frame) => {
      if (this.#active !== transport) return;
      if (transport === this.#remote && this.#remoteActivationEvents) {
        // The remote protocol already bounds every frame. Bound this short
        // activation window as well, retaining the newest events; the snapshot
        // supplies durable history for anything older.
        const limit = 4 * 1024 * 1024;
        const bytes = estimateJsonUtf8Bytes(event, limit + 1);
        if (bytes > limit) return;
        while (this.#remoteActivationEvents.length >= 512 || this.#remoteActivationBytes + bytes > limit) {
          const removed = this.#remoteActivationEvents.shift();
          if (!removed) break;
          this.#remoteActivationBytes -= removed.bytes;
        }
        this.#remoteActivationEvents.push({ event, bytes });
        this.#remoteActivationBytes += bytes;
        return;
      }
      this.onEvent?.(event, frame);
    };
    transport.onFatal = (message) => { if (this.#active === transport) this.onFatal?.(message); };
    transport.onReady = (sessionId, info) => { if (this.#active === transport || !this.#active.isReady) this.onReady?.(sessionId, info); };
    transport.onResync = (snapshot) => { if (this.#active === transport) this.onResync?.(snapshot); };
    transport.onPerformancePhase = (sample) => this.onPerformancePhase?.(sample);
  }
}
