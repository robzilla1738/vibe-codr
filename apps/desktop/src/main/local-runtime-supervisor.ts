import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { commandsExpectBusy } from "../shared/command-busy";
import type { EngineCommand } from "../shared/commands";
import type { UIEvent } from "../shared/events";
import {
  type LocalRuntimeLaunchQueueSnapshot,
  type LocalRuntimeNotificationKind,
  type LocalRuntimeNotificationTransition,
  type LocalRuntimeState,
  type LocalRuntimeStatus,
  normalizeLocalRuntimeCapacity,
} from "../shared/local-runtime";
import type { PerformancePhaseSample } from "../shared/performance";
import { normalizeCwd } from "../shared/project-index";
import type { HostRpcParams, RpcMethod } from "../shared/protocol";
import { isUIEvent } from "../shared/protocol";
import { isSchemaEngineSnapshot } from "../shared/schema-runtime-guards";
import type { EngineSnapshot } from "../shared/types";
import { EngineBridge, type EngineStartOptions } from "./engine-bridge";
import type {
  EngineTransportEventHandler,
  EngineTransportReadyHandler,
  EngineTransportResyncHandler,
} from "./engine-transport";

const DEFAULT_IDLE_TTL_MS = 10 * 60_000;

class LocalRuntimeCapacityUnavailableError extends Error {}

class LocalRuntimeLaunchCancelledError extends Error {
  constructor() { super("Local runtime launch was cancelled"); }
}

interface LaunchRequest {
  id: string;
  dedupeKey: string;
  options: EngineStartOptions;
  cwd: string;
  sessionId?: string;
  createdAt: number;
  stagedBridge: EngineBridge | null;
  started: boolean;
  cancelled: boolean;
  settled: boolean;
  promise: Promise<string>;
  resolve: (sessionId: string) => void;
  reject: (error: unknown) => void;
}

interface RuntimeRecord {
  key: string;
  cwd: string;
  ownershipRoot: string;
  sessionId: string;
  bridge: EngineBridge;
  state: LocalRuntimeState;
  updatedAt: number;
  jobCount: number;
  performedWork: boolean;
  attentionKey?: string;
  notificationSequence: number;
  readyInfo?: Parameters<EngineTransportReadyHandler>[1];
  idleTimer?: NodeJS.Timeout;
}

export interface LocalRuntimeSupervisorOptions {
  capacity?: number;
  idleTtlMs?: number;
  now?: () => number;
  createBridge?: () => EngineBridge;
}

export type RuntimeRetirementResult =
  | { ok: true; retired: boolean }
  | { ok: false; state: LocalRuntimeState | "foreground" | "jobs-running" };

/** Owns a bounded set of local writable engines while exposing exactly one as
 * the foreground transport. Busy/blocked runtimes are pinned; only background
 * idle runtimes age out. */
export class LocalRuntimeSupervisor {
  readonly #records = new Map<string, RuntimeRecord>();
  readonly #pending: LaunchRequest[] = [];
  readonly #requestsById = new Map<string, LaunchRequest>();
  readonly #requestsByDedupeKey = new Map<string, LaunchRequest>();
  #capacity: number;
  readonly #idleTtlMs: number;
  readonly #now: () => number;
  readonly #createBridge: () => EngineBridge;
  #active: RuntimeRecord | null = null;
  #stagedBridge: EngineBridge | null = null;
  #lifecycle: Promise<void> = Promise.resolve();
  #maintenanceScheduled = false;
  #disposed = false;

  onEvent: EngineTransportEventHandler | null = null;
  onFatal: ((message: string) => void) | null = null;
  onReady: EngineTransportReadyHandler | null = null;
  onResync: EngineTransportResyncHandler | null = null;
  onPerformancePhase: ((sample: PerformancePhaseSample) => void) | null = null;
  onBackgroundEvent: ((event: unknown) => void) | null = null;
  onStatus: ((status: LocalRuntimeStatus) => void) | null = null;
  onQueueChanged: ((snapshot: LocalRuntimeLaunchQueueSnapshot) => void) | null = null;
  onNotification: ((transition: LocalRuntimeNotificationTransition) => void) | null = null;
  onWillSwitch: (() => void) | null = null;

  constructor(options: LocalRuntimeSupervisorOptions = {}) {
    this.#capacity = normalizeLocalRuntimeCapacity(options.capacity);
    this.#idleTtlMs = Math.max(0, Math.trunc(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS));
    this.#now = options.now ?? Date.now;
    this.#createBridge = options.createBridge ?? (() => new EngineBridge());
  }

  get activeBridge(): EngineBridge | null { return this.#active?.bridge ?? null; }
  get activeSessionId(): string { return this.#active?.sessionId ?? ""; }
  get isRunning(): boolean { return [...this.#records.values()].some((record) => record.bridge.isRunning); }
  get isReady(): boolean { return this.#active?.bridge.isReady === true; }
  get lastLaunchDescription(): string { return this.#active?.bridge.lastLaunchDescription ?? ""; }
  get lastStderr(): string { return this.#active?.bridge.lastStderr ?? ""; }
  get size(): number { return this.#records.size; }
  get capacity(): number { return this.#capacity; }

  stageNextBridge(bridge: EngineBridge): void {
    if (this.#disposed) {
      void bridge.disposeForQuit().catch(() => undefined);
      return;
    }
    if (this.#stagedBridge && this.#stagedBridge !== bridge) {
      void this.#stagedBridge.disposeForQuit().catch(() => undefined);
    }
    this.#stagedBridge = bridge;
  }

  statuses(): LocalRuntimeStatus[] {
    return [...this.#records.values()].map((record) => this.#status(record));
  }

  queueSnapshot(): LocalRuntimeLaunchQueueSnapshot {
    return {
      capacity: this.#capacity,
      items: this.#pending.filter((request) => !request.cancelled).map((request, index) => ({
        id: request.id,
        cwd: request.cwd,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        createdAt: request.createdAt,
        position: index + 1,
        status: "queued" as const,
      })),
    };
  }

  setCapacity(value: unknown): number {
    this.#capacity = normalizeLocalRuntimeCapacity(value);
    this.#emitQueue();
    this.#scheduleMaintenance();
    return this.#capacity;
  }

  hasRuntime(cwd: string, sessionId: string): boolean {
    const record = this.#records.get(runtimeKey(cwd, sessionId));
    return record?.bridge.isReady === true && record.state !== "stopped";
  }

  start(options: EngineStartOptions): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error("Local runtime supervisor has been disposed"));
    const dedupeKey = launchDedupeKey(options);
    const duplicate = this.#requestsByDedupeKey.get(dedupeKey);
    if (duplicate && !duplicate.cancelled && !duplicate.settled) return duplicate.promise;

    let resolve!: (sessionId: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const request: LaunchRequest = {
      id: randomUUID(),
      dedupeKey,
      options: { ...options },
      cwd: normalizedRuntimeCwd(options.cwd),
      ...(options.resume ? { sessionId: options.resume } : {}),
      createdAt: this.#now(),
      stagedBridge: this.#stagedBridge,
      started: false,
      cancelled: false,
      settled: false,
      promise,
      resolve,
      reject,
    };
    this.#stagedBridge = null;
    this.#requestsById.set(request.id, request);
    this.#requestsByDedupeKey.set(request.dedupeKey, request);
    const operation = this.#lifecycle.then(async () => {
      try {
        if (this.#disposed) throw new Error("Local runtime supervisor has been disposed");
        if (request.cancelled) throw new LocalRuntimeLaunchCancelledError();
        const sessionId = await this.#start(request);
        this.#settleRequest(request, { sessionId });
      } catch (error) {
        if (error instanceof LocalRuntimeCapacityUnavailableError) {
          if (!request.cancelled && !this.#disposed) {
            this.#pending.push(request);
            this.#emitQueue();
            return;
          }
        }
        this.#settleRequest(request, { error });
      }
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return promise;
  }

  cancelLaunch(requestId: string): boolean {
    const request = this.#requestsById.get(requestId);
    if (!request || request.cancelled || request.settled || !this.#pending.includes(request)) return false;
    request.cancelled = true;
    this.#removePendingRequest(request);
    this.#settleRequest(request, { error: new LocalRuntimeLaunchCancelledError() });
    if (request.stagedBridge) {
      const staged = request.stagedBridge;
      request.stagedBridge = null;
      void staged.disposeForQuit().catch(() => undefined);
    }
    this.#emitQueue();
    this.#scheduleMaintenance();
    return true;
  }

  async #start(request: LaunchRequest): Promise<string> {
    const options = request.options;
    await this.#evictExpired();
    if (request.cancelled) throw new LocalRuntimeLaunchCancelledError();
    const cwd = normalizedRuntimeCwd(options.cwd);
    const ownershipRoot = canonicalOwnershipRoot(options.cwd);
    const existing = options.resume
      ? this.#records.get(runtimeKey(ownershipRoot, options.resume))
      : options.continueLatest
        ? [...this.#records.values()]
            .filter((record) => record.ownershipRoot === ownershipRoot && record.bridge.isReady)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        : undefined;
    if (existing?.bridge.isReady) {
      this.#activate(existing);
      this.onReady?.(existing.sessionId, existing.readyInfo);
      return existing.sessionId;
    }
    if (existing) await this.#remove(existing, true);

    // Independent engine hosts do not share filesystem/git mutation locks.
    // Keep at most one writable owner for a canonical workspace; an idle
    // owner can be replaced, while working/blocked/jobs-running owners stay
    // pinned and make the conflict explicit to the user.
    const workspaceOwners = [...this.#records.values()].filter((record) =>
      ownershipRootsOverlap(record.ownershipRoot, ownershipRoot)
    );
    const pinnedOwner = workspaceOwners.find((record) =>
      record.jobCount > 0 || (record.state !== "idle" && record.state !== "failed")
    );
    if (pinnedOwner) {
      throw new Error(
        `This workspace already has a ${pinnedOwner.state} local session. Finish or stop it before opening another writable session.`,
      );
    }
    for (const owner of workspaceOwners) await this.#remove(owner, true);
    await this.#ensureCapacity();
    if (request.cancelled) throw new LocalRuntimeLaunchCancelledError();

    const previous = this.#active;
    this.#removePendingRequest(request);
    this.#emitQueue();
    request.started = true;
    const bridge = request.stagedBridge ?? this.#createBridge();
    request.stagedBridge = null;
    const pendingKey = options.resume
      ? runtimeKey(ownershipRoot, options.resume)
      : `pending:${this.#now()}:${Math.random().toString(36).slice(2)}`;
    const record: RuntimeRecord = {
      key: pendingKey,
      cwd,
      ownershipRoot,
      sessionId: options.resume ?? "",
      bridge,
      state: "idle",
      updatedAt: this.#now(),
      jobCount: 0,
      performedWork: false,
      notificationSequence: 0,
    };
    this.#records.set(record.key, record);
    this.#wire(record);
    this.#activate(record);
    try {
      const sessionId = await bridge.start(options);
      const key = runtimeKey(ownershipRoot, sessionId);
      const duplicate = this.#records.get(key);
      if (duplicate && duplicate !== record) {
        if (duplicate.bridge.isReady) {
          await this.#remove(record, true);
          this.#activate(duplicate);
          this.onReady?.(duplicate.sessionId, duplicate.readyInfo);
          return duplicate.sessionId;
        }
        // A crashed host may be replaced with the same durable session id.
        // Retire the dead owner and let the fresh bridge take its canonical key.
        await this.#remove(duplicate, true);
      }
      this.#records.delete(record.key);
      record.key = key;
      record.sessionId = sessionId;
      record.updatedAt = this.#now();
      this.#records.set(key, record);
      this.#emitStatus(record);
      return sessionId;
    } catch (error) {
      await this.#remove(record, true);
      if (previous && this.#records.has(previous.key)) {
        this.#activate(previous);
        this.onReady?.(previous.sessionId, previous.readyInfo);
        try {
          const snapshot = await previous.bridge.rpc("snapshot");
          if (isSchemaEngineSnapshot(snapshot)) this.onResync?.(snapshot);
        } catch {
          // The restored transport remains usable even if its opportunistic
          // renderer resync fails; the renderer can request another snapshot.
        }
      } else this.#active = null;
      throw error;
    }
  }

  send(command: EngineCommand): void {
    if (!this.#active) throw new Error("Local engine not ready");
    this.#active.bridge.send(command);
    this.#observeCommand(this.#active, command);
  }

  rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.#active) return Promise.reject(new Error("Local engine not ready"));
    this.#touch(this.#active);
    return this.#active.bridge.rpc(method, params);
  }

  async stop(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    await this.#remove(active, true);
    this.#active = null;
  }

  /** Stop every writable local owner before control crosses a process boundary. */
  stopAll(): Promise<void> {
    this.#cancelAllRequests(new Error("Local runtime ownership was released before launch"));
    const operation = this.#lifecycle.then(async () => {
      const records = [...this.#records.values()];
      const results = await Promise.allSettled(records.map((record) => this.#remove(record, true)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Failed to stop every local runtime");
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async detachActiveForHandoff(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    await this.detachSessionForHandoff(active.cwd, active.sessionId);
  }

  detachSessionForHandoff(cwd: string, sessionId: string): Promise<void> {
    const operation = this.#lifecycle.then(async () => {
      const record = this.#records.get(runtimeKey(cwd, sessionId));
      if (!record) return;
      await record.bridge.detachForHandoff();
      await this.#remove(record, false);
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  }

  retireSession(cwd: string, sessionId: string, allowActive = false): Promise<RuntimeRetirementResult> {
    const operation = this.#lifecycle.then(async () => {
      const record = this.#records.get(runtimeKey(cwd, sessionId));
      if (!record) return { ok: true as const, retired: false };
      // Foreground mutation ordering remains renderer-owned. Destructive actions
      // switch away first, while rename can safely target the attached session.
      if (record === this.#active) {
        return allowActive
          ? { ok: true as const, retired: false }
          : { ok: false as const, state: "foreground" as const };
      }
      if (record.jobCount > 0) return { ok: false as const, state: "jobs-running" as const };
      if (record.state !== "idle" && record.state !== "failed") {
        return { ok: false as const, state: record.state };
      }
      await this.#remove(record, true);
      return { ok: true as const, retired: true };
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  }

  retireProject(cwd: string): Promise<RuntimeRetirementResult> {
    const operation = this.#lifecycle.then(async () => {
      const ownershipRoot = canonicalOwnershipRoot(cwd);
      const records = [...this.#records.values()].filter((record) => record.ownershipRoot === ownershipRoot);
      if (!records.length) return { ok: true as const, retired: false };
      if (records.some((record) => record === this.#active)) {
        return { ok: false as const, state: "foreground" as const };
      }
      if (records.some((record) => record.jobCount > 0)) {
        return { ok: false as const, state: "jobs-running" as const };
      }
      const pinned = records.find((record) => record.state !== "idle" && record.state !== "failed");
      if (pinned) return { ok: false as const, state: pinned.state };
      for (const record of records) await this.#remove(record, true);
      return { ok: true as const, retired: true };
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  }

  disposeForQuit(): Promise<void> {
    if (this.#disposed) return this.#lifecycle;
    this.#disposed = true;
    this.#cancelAllRequests(new Error("Local runtime supervisor has been disposed"));
    const operation = this.#lifecycle.then(async () => {
      const records = [...this.#records.values()];
      this.#records.clear();
      this.#active = null;
      for (const record of records) if (record.idleTimer) clearTimeout(record.idleTimer);
      const staged = this.#stagedBridge;
      this.#stagedBridge = null;
      await Promise.allSettled([
        ...records.map((record) => record.bridge.disposeForQuit()),
        staged?.disposeForQuit() ?? Promise.resolve(),
      ]);
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #activate(record: RuntimeRecord): void {
    const previous = this.#active;
    if (previous !== record) this.onWillSwitch?.();
    if (previous && previous !== record && previous.state === "idle" && previous.jobCount === 0) {
      this.#scheduleIdleEviction(previous);
    }
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    this.#active = record;
    this.#touch(record);
    this.#emitAllStatuses();
  }

  #wire(record: RuntimeRecord): void {
    const bridge = record.bridge;
    bridge.onEvent = (event, frame) => {
      this.#observe(record, event);
      if (this.#active === record) this.onEvent?.(event, frame);
      else if (isUIEvent(event) && event.type === "turn-performance") this.onBackgroundEvent?.(event);
    };
    bridge.onFatal = (message) => {
      const wasFailed = record.state === "failed";
      this.#setState(record, "failed");
      if (!wasFailed) this.#notify(record, "failure", "fatal");
      if (this.#active === record) this.onFatal?.(message);
    };
    bridge.onReady = (sessionId, info) => {
      record.sessionId = sessionId;
      record.readyInfo = info ? {
        protocolVersion: info.protocolVersion,
        engineRevision: info.engineRevision,
        capabilities: [...info.capabilities],
        hostInstanceId: info.hostInstanceId,
      } : undefined;
      this.#touch(record);
      if (this.#active === record) this.onReady?.(sessionId, info);
    };
    bridge.onResync = (snapshot: EngineSnapshot) => {
      if (this.#active === record) this.onResync?.(snapshot);
    };
    bridge.onPerformancePhase = (sample) => this.onPerformancePhase?.(sample);
  }

  #observe(record: RuntimeRecord, raw: unknown): void {
    if (!isUIEvent(raw)) return;
    const event: UIEvent = raw;
    if ("sessionId" in event && record.sessionId && event.sessionId !== record.sessionId) return;
    const priorState = record.state;
    switch (event.type) {
      case "user-message":
      case "permission-settled":
      case "question-settled":
      case "external-capability-resolved":
      case "assistant-text-delta":
      case "reasoning-delta":
      case "tool-call-started":
      case "tool-call-progress":
        record.performedWork = true;
        record.attentionKey = undefined;
        this.#setState(record, "working");
        break;
      case "permission-request":
        this.#setState(record, "needs-input");
        this.#notify(record, "permission", `permission:${event.id}`);
        break;
      case "external-capability-pending":
        this.#setState(record, "needs-input");
        this.#notify(record, "permission", `capability:${event.request.id}`);
        break;
      case "question-request":
        this.#setState(record, "needs-input");
        this.#notify(record, "question", `question:${event.question.id}`);
        break;
      case "plan-presented":
        this.#setState(record, "needs-review");
        this.#notify(record, "plan-review", "plan-review");
        break;
      case "plan-state-changed":
        if (event.state.status === "pending") {
          this.#setState(record, "needs-review");
          this.#notify(record, "plan-review", "plan-review");
        }
        else if (event.state.status === "exit_pending") this.#setState(record, "working");
        else if (record.state === "needs-review") this.#setState(record, "idle");
        else this.#touch(record);
        break;
      case "engine-error":
        this.#setState(record, "failed");
        if (priorState !== "failed") this.#notify(record, "failure", `failure:${record.updatedAt}`);
        break;
      case "engine-idle":
        if (record.state === "needs-input" || record.state === "needs-review" || record.state === "failed") {
          // A terminal turn event does not settle an outstanding permission,
          // plan approval, or host failure. Those pinned states have explicit
          // resolution paths and must survive ordinary engine-idle delivery.
          this.#touch(record);
          this.#emitStatus(record);
        } else {
          this.#setState(record, event.gate === "red" ? "needs-review" : "idle");
          if (event.gate !== "red" && event.gate !== "aborted" && record.performedWork) {
            this.#notify(record, "completed", `completed:${record.updatedAt}`);
          }
        }
        record.performedWork = false;
        record.attentionKey = undefined;
        break;
      case "jobs-changed":
        record.jobCount = event.jobs.filter((job) => job.status === "running").length;
        this.#touch(record);
        if (record.idleTimer) clearTimeout(record.idleTimer);
        record.idleTimer = undefined;
        if (record.jobCount === 0 && record.state === "idle" && this.#active !== record) {
          this.#scheduleIdleEviction(record);
          this.#scheduleMaintenance();
        }
        this.#emitStatus(record);
        break;
      default:
        this.#touch(record);
        break;
    }
  }

  #observeCommand(record: RuntimeRecord, command: EngineCommand): void {
    if (commandsExpectBusy([command])) {
      record.performedWork = true;
      record.attentionKey = undefined;
      this.#setState(record, "working");
      return;
    }
    switch (command.type) {
      case "resolve-permission":
      case "resolve-question":
      case "resolve-external-capability":
        record.attentionKey = undefined;
        this.#setState(record, "working");
        break;
      case "resolve-plan":
        record.attentionKey = undefined;
        this.#setState(record, command.decision === "keep-planning" ? "idle" : "working");
        break;
      default:
        break;
    }
  }

  #setState(record: RuntimeRecord, state: LocalRuntimeState): void {
    record.state = state;
    this.#touch(record);
    this.#emitStatus(record);
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    if (state === "idle" && record.jobCount === 0 && this.#active !== record && this.#idleTtlMs >= 0) {
      this.#scheduleIdleEviction(record);
    }
    if (state === "idle" || state === "failed") this.#scheduleMaintenance();
  }

  #scheduleIdleEviction(record: RuntimeRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    const delay = Math.max(0, record.updatedAt + this.#idleTtlMs - this.#now());
    record.idleTimer = setTimeout(() => {
      const operation = this.#lifecycle.then(async () => {
        if (
          this.#records.get(record.key) === record
          && this.#active !== record
          && record.state === "idle"
          && record.jobCount === 0
          && record.updatedAt <= this.#now() - this.#idleTtlMs
        ) await this.#remove(record, true);
        else if (
          this.#records.get(record.key) === record
          && this.#active !== record
          && record.state === "idle"
          && record.jobCount === 0
        ) this.#scheduleIdleEviction(record);
      });
      this.#lifecycle = operation.then(() => undefined, () => undefined);
    }, delay);
    record.idleTimer.unref?.();
  }

  #touch(record: RuntimeRecord): void { record.updatedAt = this.#now(); }

  #status(record: RuntimeRecord): LocalRuntimeStatus {
    return {
      key: record.key,
      cwd: record.cwd,
      sessionId: record.sessionId,
      state: record.state,
      updatedAt: record.updatedAt,
      jobCount: record.jobCount,
      foreground: this.#active === record,
    };
  }

  #emitStatus(record: RuntimeRecord): void {
    if (record.sessionId && !record.key.startsWith("pending:")) this.onStatus?.(this.#status(record));
  }

  #emitAllStatuses(): void {
    for (const record of this.#records.values()) this.#emitStatus(record);
  }

  #emitQueue(): void {
    this.onQueueChanged?.(this.queueSnapshot());
  }

  #notify(record: RuntimeRecord, kind: LocalRuntimeNotificationKind, transitionId: string): void {
    if (this.#active === record || !record.sessionId || record.attentionKey === transitionId) return;
    record.attentionKey = transitionId;
    record.notificationSequence += 1;
    this.onNotification?.({
      kind,
      cwd: record.cwd,
      sessionId: record.sessionId,
      transitionId: `${kind}:${record.notificationSequence}`,
    });
  }

  #removePendingRequest(request: LaunchRequest): void {
    const index = this.#pending.indexOf(request);
    if (index >= 0) this.#pending.splice(index, 1);
  }

  #settleRequest(
    request: LaunchRequest,
    outcome: { sessionId: string } | { error: unknown },
  ): void {
    if (request.settled) return;
    request.settled = true;
    this.#removePendingRequest(request);
    if (this.#requestsById.get(request.id) === request) this.#requestsById.delete(request.id);
    if (this.#requestsByDedupeKey.get(request.dedupeKey) === request) {
      this.#requestsByDedupeKey.delete(request.dedupeKey);
    }
    if ("sessionId" in outcome) request.resolve(outcome.sessionId);
    else request.reject(outcome.error);
  }

  #cancelAllRequests(error: Error): void {
    for (const request of [...this.#requestsById.values()]) {
      if (request.started) continue;
      request.cancelled = true;
      if (request.stagedBridge) {
        const staged = request.stagedBridge;
        request.stagedBridge = null;
        void staged.disposeForQuit().catch(() => undefined);
      }
      this.#settleRequest(request, { error });
    }
    this.#pending.length = 0;
    this.#emitQueue();
  }

  #scheduleMaintenance(): void {
    if (this.#maintenanceScheduled || this.#disposed) return;
    this.#maintenanceScheduled = true;
    const operation = this.#lifecycle.then(async () => {
      this.#maintenanceScheduled = false;
      if (this.#disposed) return;
      await this.#reconcileCapacity();
      await this.#drainQueue();
    });
    this.#lifecycle = operation.then(() => undefined, () => undefined);
  }

  async #drainQueue(): Promise<void> {
    while (!this.#disposed) {
      const request = this.#pending.find((candidate) => !candidate.cancelled && !candidate.settled);
      if (!request) return;
      try {
        const sessionId = await this.#start(request);
        this.#settleRequest(request, { sessionId });
        this.#emitQueue();
      } catch (error) {
        if (error instanceof LocalRuntimeCapacityUnavailableError) return;
        this.#settleRequest(request, { error });
        this.#emitQueue();
      }
    }
  }

  async #reconcileCapacity(): Promise<void> {
    await this.#evictExpired();
    while (this.#records.size > this.#capacity) {
      const candidate = this.#idleRetirementCandidate();
      if (!candidate) return;
      await this.#remove(candidate, true);
    }
  }

  #idleRetirementCandidate(): RuntimeRecord | undefined {
    return [...this.#records.values()]
      .filter((record) => record !== this.#active && record.state === "idle" && record.jobCount === 0)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
  }

  async #ensureCapacity(): Promise<void> {
    await this.#reconcileCapacity();
    while (this.#records.size >= this.#capacity) {
      const candidate = this.#idleRetirementCandidate();
      if (!candidate) break;
      await this.#remove(candidate, true);
    }
    if (this.#records.size < this.#capacity) return;
    throw new LocalRuntimeCapacityUnavailableError(
      `Local runtime capacity (${this.#capacity}) is full. Finish or stop a working session, or retry after an idle background session ages out.`,
    );
  }

  async #evictExpired(): Promise<void> {
    // A crashed bridge no longer owns a functioning runtime and must never
    // consume one of the bounded slots indefinitely.
    const failed = [...this.#records.values()]
      .filter((record) => record.state === "failed")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of failed) await this.#remove(record, true);

    const cutoff = this.#now() - this.#idleTtlMs;
    const candidates = [...this.#records.values()]
      .filter((record) => record !== this.#active && record.state === "idle" && record.jobCount === 0 && record.updatedAt <= cutoff)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of candidates) {
      if (this.#records.size < this.#capacity) break;
      await this.#remove(record, true);
    }
  }

  async #remove(record: RuntimeRecord, stop: boolean): Promise<void> {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    if (stop && record.bridge.isRunning) {
      try {
        await record.bridge.stop();
      } catch (error) {
        record.state = "failed";
        record.updatedAt = this.#now();
        this.#emitStatus(record);
        throw error;
      }
      if (record.bridge.isRunning) {
        record.state = "failed";
        record.updatedAt = this.#now();
        this.#emitStatus(record);
        throw new Error(`Local runtime ${record.sessionId || record.key} still owns its engine host after stop`);
      }
    }
    record.state = "stopped";
    this.#emitStatus(record);
    if (this.#records.get(record.key) === record) this.#records.delete(record.key);
    if (this.#active === record) this.#active = null;
    this.#scheduleMaintenance();
  }
}

export function runtimeKey(cwd: string, sessionId: string): string {
  return `${canonicalOwnershipRoot(cwd)}\0${sessionId}`;
}

function normalizedRuntimeCwd(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function launchDedupeKey(options: EngineStartOptions): string {
  return JSON.stringify({
    cwd: canonicalOwnershipRoot(options.cwd),
    resume: options.resume ?? null,
    continueLatest: options.continueLatest === true,
    model: options.model ?? null,
    mode: options.mode ?? null,
  });
}

function canonicalOwnershipRoot(cwd: string): string {
  let resolved = normalizeCwd(cwd);
  try { resolved = normalizeCwd(realpathSync.native(resolved)); }
  catch { /* A not-yet-created test/root still receives lexical overlap protection. */ }
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function ownershipRootsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return isPathInside(left, right) || isPathInside(right, left);
}

function isPathInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value !== ""
    && value !== ".."
    && !value.startsWith(`..${sep}`)
    && !isAbsolute(value);
}
