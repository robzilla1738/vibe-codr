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
import { readFile } from "node:fs/promises";
import { loadConfig, type Config } from "@vibe/config";
import {
  Engine,
  loadProjectMemory,
  PortableSessionManager,
  SessionStore,
  type PersistedSession,
} from "@vibe/core";
import type { EngineCommand, ExecutionTarget } from "@vibe/shared";
import {
  decodeInbound,
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

function write(msg: HostOutbound): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

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
  let engine: Engine | null = null;
  let eventLoop: Promise<void> | null = null;
  let shuttingDown = false;
  let lastCwd: string = process.cwd();
  // TypeScript does not carry assignments made inside `bootstrap` into the
  // outer stdin loop's control-flow graph. Read through a typed accessor so the
  // loop can narrow the real mutable runtime state without unsafe `never` casts.
  const currentEngine = (): Engine | null => engine;

  const fatal = (err: unknown) => {
    if (shuttingDown) return;
    const message = err instanceof Error ? err.message : String(err);
    write({ type: "fatal", message });
  };

  const crash = (err: unknown) => {
    fatal(err);
    shuttingDown = true;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 25).unref();
  };

  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  const startEventPump = (e: Engine) => {
    eventLoop = (async () => {
      try {
        for await (const event of e.events()) {
          write({ type: "event", event });
        }
      } catch (err) {
        fatal(err);
      }
    })();
  };

  const bootstrap = async (msg: Extract<HostInbound, { op: "bootstrap" }>) => {
    if (engine) {
      write({ type: "fatal", message: "already bootstrapped" });
      return;
    }

    const cwd = msg.cwd;
    lastCwd = cwd;
    const overrides: Partial<Config> = {};
    if (msg.model) overrides.model = msg.model;
    if (msg.mode !== undefined && !applyModeOverride(overrides, msg.mode)) {
      write({ type: "fatal", message: `invalid mode "${msg.mode}"` });
      return;
    }

    let config: Config;
    try {
      config = await loadConfig({ cwd, overrides });
    } catch (err) {
      write({
        type: "fatal",
        message: `config load failed: ${(err as Error).message}`,
      });
      return;
    }

    let resume: PersistedSession | undefined;
    if (msg.continue || msg.resume) {
      const store = new SessionStore(cwd);
      const id = msg.resume ?? (await store.latestId());
      const loaded = id ? await store.load(id) : null;
      if (loaded) resume = loaded;
    }

    if (resume) {
      const cloudProvider = process.env.VIBE_CLOUD_PROVIDER;
      let target: ExecutionTarget = { kind: "local" };
      if (process.env.VIBE_CLOUD_RUNTIME === "1") {
        if (cloudProvider !== "e2b" && cloudProvider !== "vercel") {
          write({ type: "fatal", message: "cloud runtime is missing a valid VIBE_CLOUD_PROVIDER" });
          return;
        }
        target = { kind: "cloud", provider: cloudProvider };
      }
      try {
        await PortableSessionManager.assertOwner(cwd, resume.meta.id, target);
      } catch (error) {
        write({
          type: "fatal",
          message: `session ownership check failed: ${(error as Error).message}`,
        });
        return;
      }
    }

    const projectMemory = await loadProjectMemory(cwd);
    engine = new Engine({
      config,
      cwd,
      interactive: true,
      ...(projectMemory ? { projectMemory } : {}),
      ...(resume ? { resume } : {}),
      ...(msg.model ? { modelOverride: msg.model } : {}),
      ...(overrides.mode ? { modeOverride: overrides.mode } : {}),
    });

    await engine.bootstrap();
    engine.start();
    startEventPump(engine);

    const snap = engine.snapshot();
    write({ type: "ready", sessionId: snap.sessionId });
  };

  const handleRpc = async (
    id: number,
    method: Extract<HostInbound, { op: "rpc" }>["method"],
    params?: HostRpcParams,
  ) => {
    try {
      if (method === "listSessions") {
        const metas = await new SessionStore(lastCwd).list();
        write({ type: "resp", id, ok: true, value: metas });
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
      if (method === "renameSession" || method === "deleteSession" || method === "archiveSession") {
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

      if (!engine) {
        write({ type: "resp", id, ok: false, error: "not bootstrapped" });
        return;
      }

      switch (method) {
        case "snapshot":
          {
            const snapshot = engine.snapshot();
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
              value: history === snapshot.history ? snapshot : { ...snapshot, history },
            });
          }
          return;
        case "listModels":
          write({ type: "resp", id, ok: true, value: await engine.listModels() });
          return;
        case "listProviders":
          write({
            type: "resp",
            id,
            ok: true,
            value: engine.listProviders(),
          });
          return;
        case "listAgents":
          write({
            type: "resp",
            id,
            ok: true,
            value: engine.listAgents(),
          });
          return;
        case "listSkills":
          write({
            type: "resp",
            id,
            ok: true,
            value: engine.listSkills(),
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
        case "finalize":
          await engine.finalize?.();
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
      write({ type: "fatal", message: "protocol message exceeds 1 MB" });
      continue;
    }
    const msg = decodeInbound(trimmed);
    if (!msg) {
      write({ type: "fatal", message: `invalid protocol message: ${trimmed.slice(0, 120)}` });
      continue;
    }

    try {
      switch (msg.op) {
        case "bootstrap":
          await bootstrap(msg);
          break;
        case "send":
          if (!currentEngine()) {
            write({ type: "fatal", message: "send before bootstrap" });
            break;
          }
          await currentEngine()!.send(msg.command as EngineCommand);
          break;
        case "rpc":
          await handleRpc(msg.id, msg.method, msg.params);
          break;
        case "shutdown": {
          shuttingDown = true;
          const activeEngine = currentEngine();
          if (activeEngine) {
            try {
              await activeEngine.finalize?.();
            } catch {
              /* ignore */
            }
            try {
              await activeEngine.send({ type: "shutdown" });
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
      await activeEngine.finalize?.();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
