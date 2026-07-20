import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCommand } from "../shared/commands";
import {
  decodeOutbound,
  encodeInbound,
  HOST_PROTOCOL_VERSION,
  HOST_INBOUND_SAFE_BYTES,
  incompatibleHostProtocolVersion,
  type HostEventFrame,
  type HostInbound,
  type HostReplayResult,
  type HostRpcParams,
  type RpcMethod,
} from "../shared/protocol";
import { isRpcResult } from "../shared/rpc-result-guards";
import { isSchemaUIEvent } from "../shared/schema-runtime-guards";
import type { EngineSnapshot } from "../shared/types";
import { StdinWriteQueue } from "../shared/stdin-write-queue";
import type { PerformancePhaseSample } from "../shared/performance";
import { enrichedEnv, type HostLaunch, resolveHostLaunch } from "./host-resolver";
import type { EngineTransport } from "./engine-transport";

const READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 2_000;
/** Hard ceiling after SIGKILL before we abandon waiting on a wedged OS process. */
const KILL_WAIT_MS = 1_000;
/** Finalize budget during app quit — must be well under the overall quit budget. */
const QUIT_FINALIZE_MS = 1_500;
/** Commands may include bounded clipboard/file content; reject accidental giant sends. */
const STDIN_MESSAGE_MAX_BYTES = HOST_INBOUND_SAFE_BYTES;
/** A snapshot can contain substantial history, but one line must never grow without bound. */
const PROTOCOL_LINE_MAX_BYTES = 32 * 1024 * 1024;

export type BridgeEventHandler = (event: unknown, frame?: Omit<HostEventFrame, "type" | "event">) => void;
export type BridgeFatalHandler = (message: string) => void;
export type BridgeReadyHandler = (sessionId: string, info?: {
  protocolVersion: number;
  engineRevision: string;
  capabilities: string[];
  hostInstanceId: string;
}) => void;
export type BridgeResyncHandler = (snapshot: EngineSnapshot) => void;

export interface EngineBridgeOptions {
  resolveLaunch?: () => HostLaunch;
  environment?: () => NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  rpcTimeoutMs?: number;
  stopTimeoutMs?: number;
  quitFinalizeTimeoutMs?: number;
  killWaitMs?: number;
  stdinMessageMaxBytes?: number;
  protocolLineMaxBytes?: number;
  prewarmTimeoutMs?: number;
  /** Test seam for deterministic stream/process failure injection. */
  onSpawn?: (proc: ChildProcessWithoutNullStreams) => void;
}

export interface EngineStartOptions {
  cwd: string;
  resume?: string;
  continueLatest?: boolean;
  model?: string;
  mode?: "plan" | "execute" | "yolo";
}

export class EngineBridge implements EngineTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;
  private startRequest = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private nextRpcId = 1;
  private rpcWaiters = new Map<
    number,
    { method: RpcMethod; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readyWaiters: Array<{
    resolve: (sessionId: string) => void;
    reject: (e: Error) => void;
  }> = [];
  private didReady = false;
  private prewarmed = false;
  private prewarmTimer: NodeJS.Timeout | undefined;
  private sessionId = "";
  private hostInstanceId = "";
  private expectedEngineRevision = "";
  private lastEventSeq = 0;
  private pendingEventFrames: HostEventFrame[] = [];
  private replayInFlight = false;
  private stderrBuf = "";
  /** Serializes stdin writes behind Node backpressure (drain). */
  private stdinQueue = new StdinWriteQueue();
  lastLaunchDescription = "";
  lastFatal: string | null = null;
  lastStderr = "";

  onEvent: BridgeEventHandler | null = null;
  onFatal: BridgeFatalHandler | null = null;
  onReady: BridgeReadyHandler | null = null;
  onResync: BridgeResyncHandler | null = null;
  onPerformancePhase: ((sample: PerformancePhaseSample) => void) | null = null;

  constructor(private readonly options: EngineBridgeOptions = {}) {}

  /**
   * True while this bridge still owns a child that has not exited.
   * Uses exit/signal codes — NOT `proc.killed` — so a soft-killed host still
   * reports owned until reap completes (quit must never skip cleanup).
   */
  get isRunning(): boolean {
    return this.hasOwnedChild();
  }

  /** Host accepted bootstrap and can service RPC/send. */
  get isReady(): boolean {
    return this.didReady && this.hasOwnedChild() && !this.lastFatal;
  }

  private hasOwnedChild(): boolean {
    const proc = this.proc;
    if (!proc) return false;
    return proc.exitCode === null && proc.signalCode === null;
  }

  start(opts: EngineStartOptions): Promise<string> {
    const request = ++this.startRequest;
    const canReuse = this.prewarmed && this.hasOwnedChild() && !this.didReady;
    if (!canReuse) this.generation += 1;
    // Supersede a bootstrap that is waiting for ready immediately; its queued
    // lifecycle step then releases so the newest request can retire its child.
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (canReuse && this.prewarmed && this.hasOwnedChild() && !this.didReady) {
        this.clearPrewarm();
        return this.bootstrapCurrent(opts);
      }
      if (this.hasOwnedChild()) await this.stopCurrent();
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      return this.startCurrent(opts);
    });
  }

  /**
   * Query the host-owned project index before an engine session exists.
   *
   * The macOS bridge intentionally supports `listProjects` before bootstrap so
   * a fresh app can render recent workspaces. Keep that short-lived process
   * lifecycle-owned: it is always shut down after the response and a later
   * bootstrap starts a clean host.
   */
  listProjectsForIndex(): Promise<unknown> {
    if (this.isReady) return this.rpc("listProjects");
    const request = ++this.startRequest;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (!this.prewarmed || !this.hasOwnedChild()) {
        if (this.hasOwnedChild()) await this.stopCurrent();
        this.spawnCurrent();
        this.prewarmed = true;
      }
      const proc = this.proc;
      try {
        const value = await this.rpcUnlocked("listProjects");
        if (proc && this.proc === proc) this.armPrewarmTimeout(proc);
        return value;
      } catch (error) {
        if (this.proc === proc) await this.stopCurrent();
        throw error;
      }
    });
  }

  private clearPrewarm(): void {
    this.prewarmed = false;
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    this.prewarmTimer = undefined;
  }

  private armPrewarmTimeout(proc: ChildProcessWithoutNullStreams): void {
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => {
      if (!this.prewarmed || this.proc !== proc || this.didReady) return;
      this.clearPrewarm();
      void this.stop();
    }, this.options.prewarmTimeoutMs ?? 5 * 60_000);
    this.prewarmTimer.unref?.();
  }

  /**
   * Run a host RPC even when no project session is active. Project/session
   * history actions are available on the launch surface, where the indexing
   * host has already exited by design. Own and reap a short-lived host rather
   * than exposing that internal lifecycle detail to the user.
   */
  rpcWithTemporaryHost(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (this.isReady) return this.rpc(method, params);
    const request = ++this.startRequest;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (this.hasOwnedChild()) await this.stopCurrent();
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      const proc = this.spawnCurrent();
      try {
        return await this.rpcUnlocked(method, params);
      } finally {
        // `lifecycle` prevents a later bootstrap from spawning until this
        // cleanup completes. The identity guard avoids stopping unrelated work
        // if the host exited while answering the RPC.
        if (this.proc === proc) await this.stopCurrent();
      }
    });
  }

  /** Provider OAuth must also work before the first project bootstrap. Keep a
   * short-lived host alive across begin/status polling so its loopback server or
   * device-code poller is not killed between renderer calls. */
  providerAuthRpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (this.isReady) return this.rpc(method, params);
    return this.schedule(async () => {
      if (!this.hasOwnedChild()) this.spawnCurrent();
      const proc = this.proc;
      try {
        const value = await this.rpcUnlocked(method, params);
        const state = value && typeof value === "object" && "state" in value
          ? (value as { state?: string }).state
          : undefined;
        const retain = method === "beginProviderAuth" || method === "providerAuthStatus" && state === "pending";
        if (!retain && this.proc === proc) await this.stopCurrent();
        return value;
      } catch (error) {
        if (this.proc === proc) await this.stopCurrent();
        throw error;
      }
    });
  }

  importPortableSession(
    cwd: string,
    archive: import("../shared/handoff").PortableSessionArchiveV1,
    engineRevision: string,
    provisional = false,
  ): Promise<void> {
    const request = ++this.startRequest;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (this.hasOwnedChild()) await this.stopCurrent();
      const proc = this.spawnCurrent();
      const temp = await mkdtemp(join(tmpdir(), "vibe-portable-import-"));
      const archivePath = join(temp, "archive.json");
      try {
        await writeFile(archivePath, JSON.stringify(archive), { mode: 0o600 });
        await this.rpcUnlocked("importPortableSession", { cwd, archivePath, engineRevision, provisional });
      } finally {
        if (this.proc === proc) await this.stopCurrent();
        await rm(temp, { recursive: true, force: true });
      }
    });
  }

  commitPortableImport(cwd: string, sessionId: string, ownershipGeneration: number): Promise<void> {
    if (this.isReady) {
      return this.rpc("commitPortableImport", { cwd, sessionId, ownershipGeneration }).then(() => undefined);
    }
    return this.portableImportAction("commitPortableImport", cwd, sessionId, ownershipGeneration);
  }

  abortPortableImport(cwd: string, sessionId: string, ownershipGeneration: number): Promise<void> {
    return this.portableImportAction("abortPortableImport", cwd, sessionId, ownershipGeneration);
  }

  recoverLostCloudOwnership(
    cwd: string,
    sessionId: string,
    provider: "e2b" | "vercel",
    expectedGeneration: number,
  ): Promise<number> {
    const request = ++this.startRequest;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (this.hasOwnedChild()) await this.stopCurrent();
      const proc = this.spawnCurrent();
      try {
        const value = await this.rpcUnlocked("recoverLostCloudOwnership", {
          cwd,
          sessionId,
          target: { kind: "cloud", provider },
          expectedGeneration,
        });
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid ownership recovery response");
        return value;
      } finally {
        if (this.proc === proc) await this.stopCurrent();
      }
    });
  }

  abortInterruptedHandoff(
    cwd: string,
    sessionId: string,
    target: import("../shared/cloud").ExecutionTarget,
    expectedGeneration?: number,
  ): Promise<{ outcome: "aborted" | "already-committed"; generation: number }> {
    const request = ++this.startRequest;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (this.hasOwnedChild()) await this.stopCurrent();
      const proc = this.spawnCurrent();
      try {
        const value = await this.rpcUnlocked("abortInterruptedHandoff", {
          cwd,
          sessionId,
          target,
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
        });
        if (
          !value || typeof value !== "object"
          || !("outcome" in value)
          || (value.outcome !== "aborted" && value.outcome !== "already-committed")
          || !("generation" in value)
          || typeof value.generation !== "number"
          || !Number.isSafeInteger(value.generation)
          || value.generation < 0
        ) {
          throw new Error("Invalid interrupted handoff recovery response");
        }
        return value as { outcome: "aborted" | "already-committed"; generation: number };
      } finally {
        if (this.proc === proc) await this.stopCurrent();
      }
    });
  }

  private portableImportAction(
    method: "commitPortableImport" | "abortPortableImport",
    cwd: string,
    sessionId: string,
    ownershipGeneration: number,
  ): Promise<void> {
    const request = ++this.startRequest;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      if (request !== this.startRequest) throw new Error("Engine host stopped");
      if (this.hasOwnedChild()) await this.stopCurrent();
      const proc = this.spawnCurrent();
      try {
        await this.rpcUnlocked(method, { cwd, sessionId, ownershipGeneration });
      } finally {
        if (this.proc === proc) await this.stopCurrent();
      }
    });
  }

  private spawnCurrent(): ChildProcessWithoutNullStreams {
    const phaseStarted = performance.now();
    // A second bootstrap can arrive while the prior host is still starting.
    // Always retire any existing child before spawning another; checking only
    // `didReady` leaks two hosts and lets both write into the same renderer.
    const generation = ++this.generation;

    this.lastFatal = null;
    this.lastStderr = "";
    this.stderrBuf = "";
    this.stdinQueue.clear();
    this.didReady = false;
    this.sessionId = "";
    this.hostInstanceId = "";
    this.lastEventSeq = 0;
    this.pendingEventFrames = [];
    this.replayInFlight = false;

    let launch: HostLaunch;
    try {
      launch = (this.options.resolveLaunch ?? resolveHostLaunch)();
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    this.lastLaunchDescription = launch.description;
    console.log(`[bridge] launching: ${launch.description}`);

    // Own a process group on POSIX so stop can reap grandchildren (bun workers).
    // Windows has no process groups of this form — fall back to direct kill.
    const useProcessGroup = process.platform !== "win32";
    const environment = (this.options.environment ?? enrichedEnv)();
    this.expectedEngineRevision = environment.VIBE_ENGINE_COMMIT?.trim() ?? "";
    const proc = spawn(launch.executable, launch.arguments, {
      cwd: launch.workingDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    this.proc = proc;
    this.onPerformancePhase?.({ phase: "host-spawn", durationMs: performance.now() - phaseStarted, transport: "local" });

    const isCurrent = () => this.proc === proc && this.generation === generation;
    const protocolLineMaxBytes =
      this.options.protocolLineMaxBytes ?? PROTOCOL_LINE_MAX_BYTES;
    let stdoutFragments: Buffer[] = [];
    let stdoutLineBytes = 0;
    let protocolFailed = false;

    const failOversizedProtocolLine = () => {
      if (protocolFailed || !isCurrent()) return;
      protocolFailed = true;
      stdoutFragments = [];
      stdoutLineBytes = 0;
      this.terminateFatal(
        `Engine host protocol line exceeded ${protocolLineMaxBytes} bytes`,
        proc,
        generation,
      );
    };

    const appendProtocolFragment = (fragment: Buffer): boolean => {
      if (stdoutLineBytes + fragment.length > protocolLineMaxBytes) {
        failOversizedProtocolLine();
        return false;
      }
      if (fragment.length > 0) stdoutFragments.push(fragment);
      stdoutLineBytes += fragment.length;
      return true;
    };

    const emitProtocolLine = () => {
      if (!isCurrent() || protocolFailed) return;
      let line = Buffer.concat(stdoutFragments, stdoutLineBytes);
      stdoutFragments = [];
      stdoutLineBytes = 0;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      this.handleLine(line.toString("utf8"), proc, generation);
    };

    proc.stdout.on("data", (chunk: Buffer | string) => {
      if (!isCurrent() || protocolFailed) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < data.length) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) {
          appendProtocolFragment(data.subarray(start));
          return;
        }
        if (!appendProtocolFragment(data.subarray(start, newline))) return;
        emitProtocolLine();
        if (protocolFailed || !isCurrent()) return;
        start = newline + 1;
      }
    });

    proc.stdout.on("end", () => {
      if (isCurrent() && !protocolFailed && stdoutLineBytes > 0) emitProtocolLine();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      if (!isCurrent()) return;
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 64_000) {
        this.stderrBuf = this.stderrBuf.slice(-32_000);
      }
    });

    const streamFailure = (stream: string, error: Error) => {
      if (isCurrent()) this.terminateFatal(`Engine host ${stream} failed: ${error.message}`, proc, generation);
    };
    proc.stdin.on("error", (error) => streamFailure("stdin", error));
    proc.stdout.on("error", (error) => streamFailure("stdout", error));
    proc.stderr.on("error", (error) => streamFailure("stderr", error));
    this.options.onSpawn?.(proc);

    proc.on("exit", (code, signal) => {
      if (!isCurrent()) return;
      this.proc = null;
      this.didReady = false;
      const errText = this.consumeStderr();
      if (errText) this.lastStderr = errText;
      const msg =
        signal
          ? errText || `Engine host exited on ${signal}`
          : code && code !== 0
            ? errText || `Engine host exited (${code})`
            : "Engine host exited";
      // Any exit from the current generation is unexpected. Planned stop/start
      // paths increment generation first, so their exit handlers fail isCurrent.
      if (!this.lastFatal) {
        this.lastFatal = msg;
        this.onFatal?.(msg);
      }
      this.failReady(new Error(msg));
      this.failAllRpc(new Error("Engine host not running"));
    });

    proc.on("error", (error) => {
      if (!isCurrent()) return;
      this.proc = null;
      this.didReady = false;
      const message = `Could not start engine host: ${error.message}`;
      this.lastFatal = message;
      this.onFatal?.(message);
      this.failReady(new Error(message));
      this.failAllRpc(new Error(message));
    });

    return proc;
  }

  private async startCurrent(opts: EngineStartOptions): Promise<string> {
    // A second bootstrap can arrive while the prior host is still starting.
    // `start` serializes retirement before this method spawns the replacement.
    this.spawnCurrent();
    return this.bootstrapCurrent(opts);
  }

  private async bootstrapCurrent(opts: EngineStartOptions): Promise<string> {
    const phaseStarted = performance.now();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) throw new Error("Engine host not running");
    const generation = this.generation;

    try {
      this.write({
        op: "bootstrap",
        cwd: opts.cwd,
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.continueLatest ? { continue: true } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `Could not bootstrap engine host: ${reason}`;
      this.terminateFatal(message, proc, generation);
      throw new Error(message);
    }

    const sessionId = await this.waitForReady(this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    this.onPerformancePhase?.({ phase: "host-ready", durationMs: performance.now() - phaseStarted, transport: "local" });
    return sessionId;
  }

  stop(): Promise<void> {
    this.startRequest += 1;
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(() => this.stopCurrent());
  }

  /** Ownership has already been committed elsewhere. Reap the local host
   * without sending shutdown/finalize, which could write a post-commit digest
   * from the old owner. Portable state was flushed by prepareHandoff. */
  detachForHandoff(): Promise<void> {
    this.startRequest += 1;
    this.generation += 1;
    this.failReady(new Error("Engine ownership transferred"));
    this.failAllRpc(new Error("Engine ownership transferred"));
    return this.schedule(async () => {
      const proc = this.proc;
      this.proc = null;
      this.didReady = false;
      this.stdinQueue.clear();
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      this.killOwned(proc, "SIGTERM");
      await this.waitForExit(proc, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      if (proc.exitCode === null && proc.signalCode === null) {
        this.killOwned(proc, "SIGKILL");
        await this.waitForExit(proc, this.options.killWaitMs ?? KILL_WAIT_MS);
      }
    });
  }

  /**
   * App-quit path: best-effort short finalize (only if ready), then always reap
   * the child with SIGTERM→SIGKILL. Never leave an orphan host.
   *
   * Preempt ready/RPC waiters **before** scheduling so an in-flight
   * `waitForReady` (up to READY_TIMEOUT_MS) cannot pin the lifecycle queue
   * past quit's hard ceiling. Do **not** bump `generation` here — finalize
   * still needs handleLine to accept the resp; `stopCurrent` advances generation.
   */
  disposeForQuit(): Promise<void> {
    // Invalidate pending start requests and release waitForReady/RPC waiters
    // immediately so the lifecycle chain can advance to this dispose step.
    this.startRequest += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    return this.schedule(async () => {
      const finalizeMs = this.options.quitFinalizeTimeoutMs ?? QUIT_FINALIZE_MS;
      // Finalize only when the host completed ready and still owns a child.
      if (this.didReady && this.hasOwnedChild()) {
        try {
          await Promise.race([
            this.rpcUnlocked("finalize"),
            sleep(finalizeMs).then(() => {
              throw new Error("finalize timed out");
            }),
          ]);
        } catch {
          /* best-effort — stop still reaps */
        }
      }
      await this.stopCurrent();
    });
  }

  private async stopCurrent(): Promise<void> {
    this.clearPrewarm();
    this.generation += 1;
    this.failReady(new Error("Engine host stopped"));
    this.failAllRpc(new Error("Engine host stopped"));
    this.stdinQueue.clear();
    const proc = this.proc;
    if (!proc) {
      this.didReady = false;
      return;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.proc = null;
      this.didReady = false;
      return;
    }

    // Graceful: ask host to exit, then escalate SIGTERM → SIGKILL.
    try {
      this.writeRaw(proc, { op: "shutdown" });
    } catch {
      /* stdin may already be closed */
    }

    const graceMs = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    const killWait = this.options.killWaitMs ?? KILL_WAIT_MS;

    await this.waitForExit(proc, graceMs);

    if (proc.exitCode === null && proc.signalCode === null) {
      this.killOwned(proc, "SIGTERM");
      await this.waitForExit(proc, graceMs);
    }

    if (proc.exitCode === null && proc.signalCode === null) {
      this.killOwned(proc, "SIGKILL");
      await this.waitForExit(proc, killWait);
    }

    // Only drop ownership when the OS has actually reaped the child. A wedged
    // D-state process must keep isRunning true so quit does not skip cleanup.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      if (this.proc === proc) this.proc = null;
      this.didReady = false;
    } else {
      console.error(
        `[bridge] host pid ${proc.pid} did not exit after SIGKILL wait — retaining ownership`,
      );
      this.didReady = false;
    }
  }

  /** Kill the child, and on POSIX the whole process group when detached. */
  private killOwned(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && typeof proc.pid === "number" && proc.pid > 0) {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          /* fall through to direct kill (group may not exist in tests) */
        }
      }
      proc.kill(signal);
    } catch {
      /* ignore */
    }
  }

  private waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      }),
      sleep(timeoutMs),
    ]);
  }

  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(work);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  send(command: EngineCommand): void {
    if (!this.isReady) throw new Error("Engine host not ready");
    this.write({ op: "send", command });
  }

  async rpc(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.hasOwnedChild()) throw new Error("Engine host not running");
    if (!this.didReady) throw new Error("Engine host not ready");
    const phaseStarted = method === "snapshot" ? performance.now() : 0;
    try { return await this.rpcUnlocked(method, params); }
    finally {
      if (method === "snapshot") {
        this.onPerformancePhase?.({ phase: "snapshot", durationMs: performance.now() - phaseStarted, transport: "local" });
      }
    }
  }

  /** RPC without the ready gate — used only for quit finalize after isReady check. */
  private rpcUnlocked(method: RpcMethod, params?: HostRpcParams): Promise<unknown> {
    if (!this.hasOwnedChild()) throw new Error("Engine host not running");
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      this.rpcWaiters.set(id, { method, resolve, reject, timer });
      try {
        this.write({
          op: "rpc",
          id,
          method,
          ...(params && Object.keys(params).length ? { params } : {}),
        } as HostInbound);
      } catch (e) {
        clearTimeout(timer);
        this.rpcWaiters.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private write(msg: HostInbound): void {
    const proc = this.proc;
    if (!proc?.stdin.writable) throw new Error("Engine host stdin closed");
    try {
      this.writeRaw(proc, msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.terminateFatal(`Engine host stdin failed: ${reason}`, proc);
      throw error;
    }
  }

  private writeRaw(proc: ChildProcessWithoutNullStreams, msg: HostInbound): void {
    if (!proc.stdin.writable) throw new Error("Engine host stdin closed");
    const payload = encodeInbound(msg);
    const payloadBytes = Buffer.byteLength(payload);
    const maxBytes = this.options.stdinMessageMaxBytes ?? STDIN_MESSAGE_MAX_BYTES;
    if (payloadBytes > maxBytes) {
      throw new Error(`Engine host message exceeded ${maxBytes} bytes`);
    }
    // Queue writes so a false return from write() pauses until drain — never
    // fire-and-forget after backpressure (large send bursts / wedged host).
    this.stdinQueue.enqueue(
      payload,
      (chunk) => {
        if (!proc.stdin.writable) throw new Error("Engine host stdin closed");
        return proc.stdin.write(chunk);
      },
      (resume) => {
        proc.stdin.once("drain", () => {
          try {
            resume();
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.terminateFatal(`Engine host stdin failed: ${reason}`, proc);
          }
        });
      },
    );
  }

  private handleLine(
    line: string,
    proc: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    if (this.proc !== proc || this.generation !== generation) return;
    const msg = decodeOutbound(line);
    if (!msg) {
      const incompatibleVersion = incompatibleHostProtocolVersion(line);
      if (incompatibleVersion !== null) {
        this.terminateFatal(
          `Engine host protocol ${incompatibleVersion} is incompatible with desktop protocol ${HOST_PROTOCOL_VERSION}`,
          proc,
          generation,
        );
        return;
      }
      const excerpt = line.trim().slice(0, 160);
      const message = `Engine host emitted invalid protocol output${excerpt ? `: ${excerpt}` : ""}`;
      this.terminateFatal(message, proc, generation);
      return;
    }
    switch (msg.type) {
      case "ready":
        if (msg.protocolVersion !== HOST_PROTOCOL_VERSION) {
          this.terminateFatal(
            `Engine host protocol ${msg.protocolVersion} is incompatible with desktop protocol ${HOST_PROTOCOL_VERSION}`,
            proc,
            generation,
          );
          break;
        }
        if (this.expectedEngineRevision && msg.engineRevision !== this.expectedEngineRevision) {
          this.terminateFatal(
            `Engine host revision ${msg.engineRevision} is incompatible with packaged revision ${this.expectedEngineRevision}`,
            proc,
            generation,
          );
          break;
        }
        this.didReady = true;
        this.sessionId = msg.sessionId;
        this.hostInstanceId = msg.hostInstanceId;
        this.lastEventSeq = 0;
        this.onReady?.(msg.sessionId, {
          protocolVersion: msg.protocolVersion,
          engineRevision: msg.engineRevision,
          capabilities: [...msg.capabilities],
          hostInstanceId: msg.hostInstanceId,
        });
        for (const w of this.readyWaiters) w.resolve(msg.sessionId);
        this.readyWaiters = [];
        break;
      case "event":
        if (!isSchemaUIEvent(msg.event)) {
          this.terminateFatal("Engine host emitted an invalid nested event payload", proc, generation);
        } else {
          this.acceptEventFrame(msg, proc, generation);
        }
        break;
      case "resp": {
        const waiter = this.rpcWaiters.get(msg.id);
        if (!waiter) break;
        clearTimeout(waiter.timer);
        this.rpcWaiters.delete(msg.id);
        if (msg.ok) {
          if (!isRpcResult(waiter.method, msg.value)) {
            const message = `Engine host returned invalid ${waiter.method} response`;
            waiter.reject(new Error(message));
            this.terminateFatal(message, proc, generation);
          } else {
            waiter.resolve(msg.value);
          }
        } else waiter.reject(new Error(msg.error));
        break;
      }
      case "fatal":
        this.terminateFatal(msg.message, proc, generation);
        break;
    }
  }

  private acceptEventFrame(
    frame: HostEventFrame,
    proc: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    if (frame.hostInstanceId !== this.hostInstanceId) {
      this.terminateFatal("Engine host event belongs to a stale host instance", proc, generation);
      return;
    }
    if (frame.seq <= this.lastEventSeq) return;
    if (!this.replayInFlight && frame.seq === this.lastEventSeq + 1) {
      this.deliverEventFrame(frame);
      return;
    }
    this.pendingEventFrames.push(frame);
    if (this.pendingEventFrames.length > 2_048) this.pendingEventFrames = this.pendingEventFrames.slice(-2_048);
    if (!this.replayInFlight) void this.reconcileEventGap(proc, generation);
  }

  private deliverEventFrame(frame: HostEventFrame): void {
    if (frame.seq <= this.lastEventSeq) return;
    this.lastEventSeq = frame.seq;
    this.onEvent?.(frame.event, { hostInstanceId: frame.hostInstanceId, seq: frame.seq });
  }

  private async reconcileEventGap(
    proc: ChildProcessWithoutNullStreams,
    generation: number,
  ): Promise<void> {
    if (this.replayInFlight || !this.hostInstanceId) return;
    this.replayInFlight = true;
    const phaseStarted = performance.now();
    try {
      const result = await this.rpcUnlocked("replayEvents", {
        hostInstanceId: this.hostInstanceId,
        afterSeq: this.lastEventSeq,
      }) as HostReplayResult;
      if (this.proc !== proc || this.generation !== generation) return;
      if (result.truncated || result.hostInstanceId !== this.hostInstanceId) {
        await this.resyncFromSnapshot();
        return;
      }
      const frames = [...result.events, ...this.pendingEventFrames]
        .sort((a, b) => a.seq - b.seq);
      this.pendingEventFrames = [];
      for (const frame of frames) {
        if (frame.seq <= this.lastEventSeq) continue;
        if (frame.hostInstanceId !== this.hostInstanceId || frame.seq !== this.lastEventSeq + 1) {
          await this.resyncFromSnapshot();
          return;
        }
        this.deliverEventFrame(frame);
      }
      if (this.lastEventSeq < result.lastEventSeq) await this.resyncFromSnapshot();
    } catch (error) {
      if (this.proc === proc && this.generation === generation) {
        this.terminateFatal(
          `Engine event replay failed: ${error instanceof Error ? error.message : String(error)}`,
          proc,
          generation,
        );
      }
    } finally {
      this.onPerformancePhase?.({ phase: "replay", durationMs: performance.now() - phaseStarted, transport: "local" });
      this.replayInFlight = false;
      if (
        this.proc === proc && this.generation === generation && this.pendingEventFrames.some((frame) => frame.seq > this.lastEventSeq)
      ) {
        void this.reconcileEventGap(proc, generation);
      }
    }
  }

  private async resyncFromSnapshot(): Promise<void> {
    const phaseStarted = performance.now();
    const value = await this.rpcUnlocked("snapshot");
    this.onPerformancePhase?.({ phase: "snapshot", durationMs: performance.now() - phaseStarted, transport: "local" });
    if (!isRpcResult("snapshot", value)) throw new Error("host returned an invalid resync snapshot");
    const snapshot = value as EngineSnapshot;
    if (snapshot.hostInstanceId !== this.hostInstanceId || !Number.isSafeInteger(snapshot.lastEventSeq)) {
      throw new Error("host returned a mismatched resync cursor");
    }
    this.lastEventSeq = snapshot.lastEventSeq ?? this.lastEventSeq;
    this.pendingEventFrames = this.pendingEventFrames.filter((frame) => frame.seq > this.lastEventSeq);
    this.onResync?.(snapshot);
  }

  private waitForReady(timeoutMs: number): Promise<string> {
    if (this.didReady) return Promise.resolve(this.sessionId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyWaiters.findIndex((w) => w.reject === rejectReady);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        const errTail = this.consumeStderr();
        if (errTail) this.lastStderr = errTail;
        const message = `Engine host timed out waiting for ready${errTail ? `\n${errTail}` : ""}`;
        // Mark lastFatal before kill so the exit handler does not emit a second
        // onFatal with a generic "exited on SIGTERM" (bootstrap already rejects).
        if (!this.lastFatal) this.lastFatal = message;
        // Reap the never-ready child so it cannot linger as an invisible process.
        void this.reapOwned(this.proc);
        reject(new Error(message));
      }, timeoutMs);
      const rejectReady = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.readyWaiters.push({
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: rejectReady,
      });
    });
  }

  /** Escalate kill without advancing generation (current host is still "current"). */
  private async reapOwned(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      if (this.proc === proc) {
        this.proc = null;
        this.didReady = false;
      }
      return;
    }
    const graceMs = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    const killWait = this.options.killWaitMs ?? KILL_WAIT_MS;
    this.killOwned(proc, "SIGTERM");
    await this.waitForExit(proc, graceMs);
    if (proc.exitCode === null && proc.signalCode === null) {
      this.killOwned(proc, "SIGKILL");
      await this.waitForExit(proc, killWait);
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      if (this.proc === proc) {
        this.proc = null;
        this.didReady = false;
      }
    } else if (this.proc === proc) {
      console.error(
        `[bridge] host pid ${proc.pid} did not exit after SIGKILL wait — retaining ownership`,
      );
      this.didReady = false;
    }
  }

  private failReady(err: Error): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private failAllRpc(err: Error): void {
    const waiters = [...this.rpcWaiters.entries()];
    this.rpcWaiters.clear();
    for (const [, w] of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private consumeStderr(): string {
    const t = this.stderrBuf.trim();
    this.stderrBuf = "";
    return t;
  }

  private terminateFatal(
    message: string,
    proc: ChildProcessWithoutNullStreams | null = this.proc,
    generation = this.generation,
  ): void {
    if (!proc || this.proc !== proc || this.generation !== generation) return;
    if (this.lastFatal) return;
    this.lastFatal = message;
    // Release queued payloads immediately and invalidate any late drain resume.
    this.stdinQueue.clear();
    this.onFatal?.(message);
    const error = new Error(message);
    this.failReady(error);
    this.failAllRpc(error);
    // Escalate kill; keep ownership until exit so quit can still reap if needed.
    void this.reapOwned(proc);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
