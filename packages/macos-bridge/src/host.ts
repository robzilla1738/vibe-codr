/**
 * NDJSON Engine host for the macOS app.
 *
 * Protocol (one JSON object per line):
 *   In  → HostInbound  (bootstrap | send | rpc | shutdown)
 *   Out ← HostOutbound (ready | event | resp | fatal)
 *
 * Uses an in-process Engine (no worker_threads) — the desktop UI already runs
 * in a separate process, so the TUI freeze class does not apply.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "@vibe/config";
import { AutomationStore, machineAutomationRoot } from "@vibe/automation";
import {
  PortableSessionManager,
  SessionStore,
  searchSessionsAcrossProjects,
} from "@vibe/core";
import type { EngineCommand, ExecutionTarget } from "@vibe/shared";
import { ProviderAuthManager } from "@vibe/providers";
import {
  listRunTraces,
  openRuntimeSession,
  readRunTrace,
  runEventLedgerDir,
  type RuntimeService,
} from "@vibe/runtime";
import {
  decodeInbound,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  type HostEventFrame,
  type HostInbound,
  type HostOutbound,
  type HostRpcParams,
} from "./protocol.ts";
import {
  archiveProject,
  deleteProject,
  listProjectSummaries,
  renameProject,
} from "./project-index.ts";
import { fitTranscriptPayload, structuredTranscript } from "./transcript-history.ts";
import { automationActivities } from "./automation-activities.ts";

function write(msg: HostOutbound): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const EVENT_REPLAY_MAX_FRAMES = 2_048;
const EVENT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

function applyModeOverride(overrides: Partial<Config>, mode: string): boolean {
  if (mode === "plan") {
    overrides.mode = "plan";
    overrides.approvalMode = "ask";
    return true;
  }
  if (mode === "execute") {
    overrides.mode = "execute";
    overrides.approvalMode = "ask";
    return true;
  }
  if (mode === "yolo") {
    overrides.mode = "execute";
    overrides.approvalMode = "auto";
    return true;
  }
  return false;
}

export async function runHost(): Promise<void> {
  const hostInstanceId = randomUUID();
  const engineRevision = process.env.VIBE_ENGINE_COMMIT?.trim() || "development";
  let eventSequence = 0;
  let replayBytes = 0;
  const replayFrames: Array<{ frame: HostEventFrame; bytes: number }> = [];
  let engine: RuntimeService | null = null;
  let eventLoop: Promise<void> | null = null;
  let shuttingDown = false;
  let activeSessionSearch: AbortController | null = null;
  let lastCwd: string = process.cwd();
  let importedResumeAuthorization: {
    cwd: string;
    sessionId: string;
    target: ExecutionTarget;
  } | null = null;
  const providerAuth = new ProviderAuthManager();
  // TypeScript does not carry assignments made inside `bootstrap` into the
  // outer stdin loop's control-flow graph. Read through a typed accessor so the
  // loop can narrow the real mutable runtime state without unsafe `never` casts.
  const currentEngine = (): RuntimeService | null => engine;
  const currentSessionSearch = (): AbortController | null => activeSessionSearch;

  const writeEvent = (event: HostEventFrame["event"]): void => {
    const frame: HostEventFrame = {
      type: "event",
      hostInstanceId,
      seq: ++eventSequence,
      event,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    replayFrames.push({ frame, bytes });
    replayBytes += bytes;
    while (replayFrames.length > EVENT_REPLAY_MAX_FRAMES || replayBytes > EVENT_REPLAY_MAX_BYTES) {
      const removed = replayFrames.shift();
      if (!removed) break;
      replayBytes -= removed.bytes;
    }
    write(frame);
  };

  const writeFatal = (message: string): void => {
    write({ type: "fatal", message, runEventTail: [...(currentEngine()?.crashTail() ?? [])] });
  };

  const fatal = (err: unknown) => {
    if (shuttingDown) return;
    const message = err instanceof Error ? err.message : String(err);
    writeFatal(message);
  };

  const crash = (err: unknown) => {
    fatal(err);
    shuttingDown = true;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 25).unref();
  };

  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  const startEventPump = (e: RuntimeService) => {
    eventLoop = (async () => {
      try {
        for await (const event of e.events()) {
          writeEvent(event);
        }
      } catch (err) {
        fatal(err);
      }
    })();
  };

  const bootstrap = async (msg: Extract<HostInbound, { op: "bootstrap" }>) => {
    if (engine) {
      writeFatal("already bootstrapped");
      return;
    }

    const cwd = msg.cwd;
    lastCwd = cwd;
    const overrides: Partial<Config> = {};
    if (msg.model) overrides.model = msg.model;
    // The Cloud agent passes the sealed model credentials in the bootstrap
    // message itself (a stdin pipe) so they reach the resumed engine even when
    // the sandbox launcher does not propagate the spawn environment to the
    // host process. Apply them to process.env before config/credential
    // resolution so requiredModels validation and live model calls succeed.
    if (msg.runtimeCredentials) {
      for (const [name, value] of Object.entries(msg.runtimeCredentials)) {
        if (typeof value === "string") process.env[name] = value;
      }
    }
    if (msg.runtimeProfile) {
      // The profile is presentation-only and is safe to honor at this protocol
      // boundary. Do not depend on a launcher environment flag: a sandbox may
      // drop inherited environment while still delivering the authenticated
      // bootstrap frame, and that must not reset appearance during handoff.
      overrides.theme = msg.runtimeProfile.theme;
      overrides.accentColor = msg.runtimeProfile.accentColor;
      overrides.details = msg.runtimeProfile.details;
    }
    if (msg.mode !== undefined && !applyModeOverride(overrides, msg.mode)) {
      writeFatal(`invalid mode "${msg.mode}"`);
      return;
    }

    engine = await openRuntimeSession({
      cwd,
      interactive: true,
      configOverrides: overrides,
      requiredModels: msg.requiredModels,
      resume: msg.resume
        ? { kind: "session", sessionId: msg.resume }
        : msg.continue
          ? { kind: "latest" }
          : { kind: "new" },
      executionTarget: msg.executionTarget,
      executionTargetForResume: (resume) => {
        const authorization = importedResumeAuthorization;
        if (authorization?.cwd !== cwd || authorization.sessionId !== resume.meta.id) {
          return undefined;
        }
        importedResumeAuthorization = null;
        return authorization.target;
      },
      acquireLease: false,
      ...(msg.model ? { modelOverride: msg.model } : {}),
      ...(overrides.mode ? { modeOverride: overrides.mode } : {}),
    });
    startEventPump(engine);

    const snap = engine.snapshot();
    write({
      type: "ready",
      protocolVersion: HOST_PROTOCOL_VERSION,
      engineRevision,
      capabilities: [...HOST_PROTOCOL_CAPABILITIES],
      hostInstanceId,
      sessionId: snap.sessionId,
    });
  };

  const handleRpc = async (
    id: number,
    method: Extract<HostInbound, { op: "rpc" }>["method"],
    params?: HostRpcParams,
  ) => {
    try {
      if (method === "providerAuthStatus" || method === "beginProviderAuth" || method === "cancelProviderAuth" || method === "logoutProviderAuth" || method === "exportProviderAuth") {
        const providerId = params?.providerId;
        if (providerId !== "openai-codex" && providerId !== "xai-oauth") {
          write({ type: "resp", id, ok: false, error: "supported subscription provider required" });
          return;
        }
        if (method === "providerAuthStatus") {
          write({ type: "resp", id, ok: true, value: await providerAuth.status(providerId, params?.authSessionId) });
          return;
        }
        if (method === "beginProviderAuth") {
          const authMethod = params?.authMethod;
          if (authMethod !== "browser" && authMethod !== "device") {
            write({ type: "resp", id, ok: false, error: "auth method required" });
            return;
          }
          write({ type: "resp", id, ok: true, value: await providerAuth.begin(providerId, authMethod) });
          return;
        }
        if (method === "exportProviderAuth") {
          write({ type: "resp", id, ok: true, value: await providerAuth.exportCredential(providerId) });
          return;
        }
        if (method === "cancelProviderAuth") {
          if (!params?.authSessionId) {
            write({ type: "resp", id, ok: false, error: "auth session id required" });
            return;
          }
          await providerAuth.cancel(params.authSessionId);
          write({ type: "resp", id, ok: true, value: null });
          return;
        }
        await providerAuth.logout(providerId);
        write({ type: "resp", id, ok: true, value: null });
        return;
      }
      if (method === "listSessions") {
        const metas = await new SessionStore(lastCwd).list();
        write({ type: "resp", id, ok: true, value: metas });
        return;
      }
      if (method === "listTraces") {
        const cwd = params?.cwd?.trim() || lastCwd;
        const value = await listRunTraces(runEventLedgerDir(cwd), { limit: params?.limit });
        write({ type: "resp", id, ok: true, value });
        return;
      }
      if (method === "readTrace") {
        const cwd = params?.cwd?.trim() || lastCwd;
        if (!params?.runId) {
          write({ type: "resp", id, ok: false, error: "trace run id required" });
          return;
        }
        const value = await readRunTrace(runEventLedgerDir(cwd), params.runId, {
          afterSeq: params.afterSeq,
          limit: params.limit,
          includeRedacted: params.includeRedacted,
        });
        write({ type: "resp", id, ok: true, value });
        return;
      }
      if (method === "searchSessions") {
        activeSessionSearch?.abort();
        const searchController = new AbortController();
        activeSessionSearch = searchController;
        const query = params?.query?.replace(/\s+/g, " ").trim().slice(0, 512) ?? "";
        if (!query) {
          if (activeSessionSearch === searchController) activeSessionSearch = null;
          write({ type: "resp", id, ok: true, value: [] });
          return;
        }
        const projects = params?.cwd
          ? [{ cwd: params.cwd }]
          : await listProjectSummaries(engine ? lastCwd : undefined);
        const hits = await searchSessionsAcrossProjects(projects.map((project) => project.cwd), query, {
          limit: Math.max(1, Math.min(100, Math.trunc(params?.limit ?? 20))),
          concurrency: 4,
          signal: searchController.signal,
        });
        if (activeSessionSearch === searchController) activeSessionSearch = null;
        write({
          type: "resp",
          id,
          ok: true,
          value: hits.map((hit) => ({
            cwd: hit.cwd,
            sessionId: hit.sessionId,
            role: hit.role,
            timestamp: hit.when,
            snippet: hit.snippet,
            score: hit.score,
          })),
        });
        return;
      }
      if (method === "listProjects") {
        // Before bootstrap, process.cwd() is only the host launch directory and
        // must not be presented to desktop clients as a persisted project/capability.
        const projects = await listProjectSummaries(engine ? lastCwd : undefined);
        write({ type: "resp", id, ok: true, value: projects });
        return;
      }
      if (method === "renameProject") {
        const cwd = params?.cwd?.trim() || lastCwd;
        const result = await renameProject(cwd, params?.name ?? "");
        write(
          result
            ? { type: "resp", id, ok: true, value: { cwd, name: result.name } }
            : { type: "resp", id, ok: false, error: "project not found or empty name" },
        );
        return;
      }
      if (method === "archiveProject" || method === "deleteProject") {
        const cwd = params?.cwd?.trim() || lastCwd;
        const result =
          method === "archiveProject" ? await archiveProject(cwd) : await deleteProject(cwd);
        write(
          result
            ? { type: "resp", id, ok: true, value: result }
            : { type: "resp", id, ok: false, error: "project not found" },
        );
        return;
      }
      if (method === "renameSession" || method === "deleteSession" || method === "archiveSession" || method === "forkSession") {
        const sessionId = params?.id?.trim();
        if (!sessionId) {
          write({ type: "resp", id, ok: false, error: "session id required" });
          return;
        }
        const cwd = params?.cwd?.trim() || lastCwd;
        if (!cwd) {
          write({ type: "resp", id, ok: false, error: "cwd required" });
          return;
        }
        const store = new SessionStore(cwd);
        if (method === "forkSession") {
          const loaded = await store.load(sessionId);
          const atTurnId = params?.atTurnId?.trim()
            || loaded?.meta.turns?.filter((turn) => turn.origin === "user").at(-1)?.id;
          if (!atTurnId) {
            write({ type: "resp", id, ok: false, error: "session has no completed user turn to fork" });
            return;
          }
          const forked = await store.fork(sessionId, atTurnId);
          write({ type: "resp", id, ok: true, value: { id: forked.id, cwd, atTurnId } });
          return;
        }
        if (method === "renameSession") {
          const title = (params?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
          const ok = await store.setTitle(sessionId, title);
          write(
            ok
              ? { type: "resp", id, ok: true, value: { id: sessionId, title } }
              : { type: "resp", id, ok: false, error: "session not found or empty title" },
          );
          return;
        }
        if (method === "deleteSession") {
          const ok = await store.delete(sessionId);
          write(
            ok
              ? { type: "resp", id, ok: true, value: { id: sessionId } }
              : { type: "resp", id, ok: false, error: "session not found" },
          );
          return;
        }
        const ok = await store.archive(sessionId);
        write(
          ok
            ? { type: "resp", id, ok: true, value: { id: sessionId } }
            : { type: "resp", id, ok: false, error: "session not found" },
        );
        return;
      }

      if (method === "importPortableSession") {
        if ((!params?.archive && !params?.archivePath) || !params.engineRevision) {
          write({
            type: "resp",
            id,
            ok: false,
            error: "archive path and engine revision required",
          });
          return;
        }
        const archive = params.archive ?? JSON.parse(await readFile(params.archivePath!, "utf8"));
        const cwd = params.cwd?.trim() || lastCwd;
        await PortableSessionManager.import(cwd, archive, params.engineRevision, {
          provisional: params.provisional === true,
        });
        lastCwd = cwd;
        importedResumeAuthorization = {
          cwd,
          sessionId: archive.sessionId,
          target: archive.executionTarget,
        };
        write({ type: "resp", id, ok: true, value: { sessionId: archive.sessionId } });
        return;
      }

      if (method === "commitPortableImport" || method === "abortPortableImport") {
        const sessionId = params?.sessionId?.trim();
        const generation = params?.ownershipGeneration;
        if (
          !sessionId ||
          typeof generation !== "number" ||
          !Number.isSafeInteger(generation) ||
          generation < 1
        ) {
          write({
            type: "resp",
            id,
            ok: false,
            error: "session id and ownership generation required",
          });
          return;
        }
        const cwd = params?.cwd?.trim() || lastCwd;
        if (method === "commitPortableImport") {
          await PortableSessionManager.commitImport(cwd, sessionId, generation);
        } else {
          if (engine) {
            write({
              type: "resp",
              id,
              ok: false,
              error: "portable import abort requires the engine to be shut down",
            });
            return;
          }
          await PortableSessionManager.abortImport(cwd, sessionId, generation);
        }
        write({ type: "resp", id, ok: true, value: null });
        return;
      }

      if (method === "commitHandoff" || method === "abortHandoff") {
        const sessionId = params?.sessionId?.trim() || engine?.snapshot().sessionId;
        if (!sessionId || !params?.nonce) {
          write({ type: "resp", id, ok: false, error: "session id and nonce required" });
          return;
        }
        const manager = new PortableSessionManager(params.cwd?.trim() || lastCwd, sessionId);
        if (method === "commitHandoff") await manager.commit(params.nonce);
        else await manager.abort(params.nonce);
        write({ type: "resp", id, ok: true, value: null });
        return;
      }

      if (method === "recoverLostCloudOwnership") {
        const sessionId = params?.sessionId?.trim();
        const generation = params?.expectedGeneration;
        const provider = params?.target?.kind === "cloud" ? params.target.provider : undefined;
        const cwd = params?.cwd?.trim() || lastCwd;
        if (!sessionId || !provider || !Number.isSafeInteger(generation) || generation === undefined || generation < 0) {
          write({ type: "resp", id, ok: false, error: "cwd, session id, provider, and ownership generation required" });
          return;
        }
        const value = await new PortableSessionManager(cwd, sessionId).recoverLostCloudOwnership(provider, generation);
        write({ type: "resp", id, ok: true, value });
        return;
      }

      if (method === "abortInterruptedHandoff") {
        const sessionId = params?.sessionId?.trim();
        const target = params?.target;
        const generation = params?.expectedGeneration;
        const cwd = params?.cwd?.trim() || lastCwd;
        if (
          !sessionId ||
          !target ||
          (target.kind !== "local" && target.kind !== "cloud") ||
          (target.kind === "cloud" && target.provider !== "e2b" && target.provider !== "vercel") ||
          (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1))
        ) {
          write({ type: "resp", id, ok: false, error: "cwd, session id, target, and optional ownership generation required" });
          return;
        }
        const value = await new PortableSessionManager(cwd, sessionId).abortInterrupted(target, generation);
        write({ type: "resp", id, ok: true, value });
        return;
      }

      if (!engine) {
        write({ type: "resp", id, ok: false, error: "not bootstrapped" });
        return;
      }

      switch (method) {
        case "snapshot":
          {
            const snapshot = engine.snapshot();
            const automationStore = new AutomationStore(machineAutomationRoot());
            const automation = await automationActivities(
              await automationStore.list().catch(() => []),
              await automationStore.history().catch(() => []),
              lastCwd,
            );
            let history = fitTranscriptPayload(snapshot.history);
            try {
              history = structuredTranscript(engine.transcriptState());
            } catch {
              // Snapshot is authoritative and already valid. Legacy transcript
              // enrichment is optional presentation work only.
            }
            write({
              type: "resp",
              id,
              ok: true,
              value: {
                ...(history === snapshot.history ? snapshot : { ...snapshot, history }),
                activities: [...(snapshot.activities ?? []), ...automation],
                hostInstanceId,
                lastEventSeq: eventSequence,
              },
            });
          }
          return;
        case "replayEvents": {
          const afterSeq = params?.afterSeq;
          const sameHost = params?.hostInstanceId === hostInstanceId;
          if (!Number.isSafeInteger(afterSeq) || afterSeq === undefined || afterSeq < 0) {
            write({ type: "resp", id, ok: false, error: "non-negative replay cursor required" });
            return;
          }
          const oldestSeq = replayFrames[0]?.frame.seq ?? eventSequence + 1;
          const truncated = !sameHost || afterSeq < oldestSeq - 1;
          write({
            type: "resp",
            id,
            ok: true,
            value: {
              hostInstanceId,
              events: truncated
                ? []
                : replayFrames.filter(({ frame }) => frame.seq > afterSeq).map(({ frame }) => frame),
              lastEventSeq: eventSequence,
              truncated,
            },
          });
          return;
        }
        case "listModels":
          write({ type: "resp", id, ok: true, value: await engine.listModels() });
          return;
        case "listProviders":
          write({
            type: "resp",
            id,
            ok: true,
            value: await engine.listProviders(),
          });
          return;
        case "listAgents":
          write({
            type: "resp",
            id,
            ok: true,
            value: await engine.listAgents(),
          });
          return;
        case "listSkills":
          write({
            type: "resp",
            id,
            ok: true,
            value: await engine.listSkills(),
          });
          return;
        case "listMcp":
          write({
            type: "resp",
            id,
            ok: true,
            value: engine.listMcp(),
          });
          return;
        case "listPluginStatus":
          write({
            type: "resp",
            id,
            ok: true,
            value: engine.listPluginStatus(),
          });
          return;
        case "finalize":
          await engine.close();
          write({ type: "resp", id, ok: true, value: null });
          return;
        case "prepareHandoff": {
          if (!params?.target) {
            write({ type: "resp", id, ok: false, error: "handoff target required" });
            return;
          }
          const value = await engine.prepareHandoff(params.target, params.expectedGeneration);
          write({ type: "resp", id, ok: true, value });
          return;
        }
        case "exportPortableSession": {
          if (!params?.engineRevision || params.ownershipGeneration === undefined) {
            write({
              type: "resp",
              id,
              ok: false,
              error: "engine revision and ownership generation required",
            });
            return;
          }
          const value = await engine.exportPortableSession(
            params.engineRevision,
            params.ownershipGeneration,
          );
          write({ type: "resp", id, ok: true, value });
          return;
        }
        default:
          write({ type: "resp", id, ok: false, error: `unknown method ${method}` });
      }
    } catch (err) {
      write({
        type: "resp",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > 1_000_000) {
      writeFatal("protocol message exceeds 1 MB");
      continue;
    }
    const msg = decodeInbound(trimmed);
    if (!msg) {
      writeFatal(`invalid protocol message: ${trimmed.slice(0, 120)}`);
      continue;
    }

    try {
      switch (msg.op) {
        case "bootstrap":
          await bootstrap(msg);
          break;
        case "send":
          if (!currentEngine()) {
            writeFatal("send before bootstrap");
            break;
          }
          await currentEngine()!.send(msg.command as EngineCommand);
          break;
        case "rpc":
          // Session recall can span several project stores. Let a replacement
          // query enter the loop immediately so it can abort obsolete work;
          // all other RPCs retain ordered request handling.
          if (msg.method === "searchSessions") void handleRpc(msg.id, msg.method, msg.params);
          else await handleRpc(msg.id, msg.method, msg.params);
          break;
        case "shutdown": {
          shuttingDown = true;
          currentSessionSearch()?.abort();
          const activeEngine = currentEngine();
          if (activeEngine) {
            try {
              await activeEngine.close();
            } catch {
              /* ignore */
            }
          }
          await Promise.race([
            eventLoop ?? Promise.resolve(),
            new Promise((r) => setTimeout(r, 500)),
          ]);
          process.exit(0);
          break;
        }
      }
    } catch (err) {
      fatal(err);
    }
  }

  shuttingDown = true;
  const activeEngine = currentEngine();
  if (activeEngine) {
    try {
      await activeEngine.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
