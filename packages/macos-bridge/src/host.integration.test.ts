import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PortableSessionManager, SessionStore } from "@vibe/core";

const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host(stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"))) {
  roots.push(stateDir);
  const child = spawn(process.execPath, ["packages/macos-bridge/bin/engine-host.ts"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, VIBE_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines: unknown[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(JSON.parse(line));
    for (const wake of waiters.splice(0)) wake();
  });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const next = async (predicate: (value: any) => boolean, timeoutMs = 2_000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = lines.findIndex(predicate);
      if (index >= 0) return lines.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("host response timed out")),
          Math.max(1, deadline - Date.now()),
        );
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error("host response timed out");
  };
  return { child, send, next };
}

describe("engine host protocol boundary", () => {
  test("resumes a cloud-owned session from an explicit bootstrap target without cloud environment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    const stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"));
    roots.push(cwd);
    const previousStateDir = process.env.VIBE_STATE_DIR;
    process.env.VIBE_STATE_DIR = stateDir;
    const sessionId = "ses_explicit_cloud_owner";
    const store = new SessionStore(cwd);
    await store.save({
      id: sessionId,
      model: "ollama/glm-5.2",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    }, [], []);
    const manager = new PortableSessionManager(cwd, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await manager.commit(prepared.nonce);
    if (previousStateDir === undefined) delete process.env.VIBE_STATE_DIR;
    else process.env.VIBE_STATE_DIR = previousStateDir;

    const proc = host(stateDir);
    proc.send({
      op: "bootstrap",
      cwd,
      resume: sessionId,
      executionTarget: { kind: "cloud", provider: "e2b" },
    });

    expect(await proc.next((value) => value.type === "ready")).toEqual({
      type: "ready",
      sessionId,
    });
    proc.send({ op: "shutdown" });
  });

  test("fails closed when an explicit resume session is unavailable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    roots.push(cwd);
    const proc = host();

    proc.send({ op: "bootstrap", cwd, resume: "ses_missing" });

    expect(await proc.next((value) => value.type === "fatal")).toEqual({
      type: "fatal",
      message: "requested session not found: ses_missing",
    });
  });
  test("applies a runtime profile even when the launcher drops the cloud runtime flag", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    const stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"));
    roots.push(cwd, stateDir);
    const previousStateDir = process.env.VIBE_STATE_DIR;
    process.env.VIBE_STATE_DIR = stateDir;
    const sessionId = "ses_runtime_profile_applied";
    const store = new SessionStore(cwd);
    await store.save({
      id: sessionId,
      model: "ollama/glm-5.2",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    }, [], []);
    const manager = new PortableSessionManager(cwd, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await manager.commit(prepared.nonce);
    if (previousStateDir === undefined) delete process.env.VIBE_STATE_DIR;
    else process.env.VIBE_STATE_DIR = previousStateDir;

    // The helper intentionally spawns without VIBE_CLOUD_RUNTIME=1. The
    // authenticated bootstrap profile must remain the durable appearance handoff.
    const proc = host(stateDir);
    proc.send({
      op: "bootstrap",
      cwd,
      resume: sessionId,
      executionTarget: { kind: "cloud", provider: "e2b" },
      runtimeProfile: { schemaVersion: 1, theme: "light", accentColor: "#e6e6e6", details: "normal" },
    });

    expect(await proc.next((value) => value.type === "ready")).toEqual({
      type: "ready",
      sessionId,
    });
    proc.send({ op: "rpc", id: 1, method: "snapshot" });
    expect((await proc.next((value) => value.type === "resp" && value.id === 1)).value).toMatchObject({
      theme: "light",
      accentColor: "#e6e6e6",
      details: "normal",
    });
    proc.send({ op: "shutdown" });
  });
  test("validates required models without the cloud runtime flag instead of failing the handoff", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    const stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"));
    roots.push(cwd, stateDir);
    const previousStateDir = process.env.VIBE_STATE_DIR;
    process.env.VIBE_STATE_DIR = stateDir;
    const sessionId = "ses_required_models_validated";
    const store = new SessionStore(cwd);
    await store.save({
      id: sessionId,
      model: "ollama/glm-5.2",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    }, [], []);
    const manager = new PortableSessionManager(cwd, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await manager.commit(prepared.nonce);
    if (previousStateDir === undefined) delete process.env.VIBE_STATE_DIR;
    else process.env.VIBE_STATE_DIR = previousStateDir;

    // The host helper spawns without VIBE_CLOUD_RUNTIME=1, so requiredModels
    // must be validated (not rejected with the cloud-only fatal). ollama is
    // keyless, so it resolves and the handoff completes.
    const proc = host(stateDir);
    proc.send({
      op: "bootstrap",
      cwd,
      resume: sessionId,
      executionTarget: { kind: "cloud", provider: "e2b" },
      requiredModels: ["ollama/glm-5.2"],
    });

    expect(await proc.next((value) => value.type === "ready")).toEqual({
      type: "ready",
      sessionId,
    });
    proc.send({ op: "shutdown" });
  });
  test("resolves required models from bootstrap credentials when the spawn env lacks them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    const stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"));
    roots.push(cwd, stateDir);
    const previousStateDir = process.env.VIBE_STATE_DIR;
    process.env.VIBE_STATE_DIR = stateDir;
    const sessionId = "ses_bootstrap_credentials";
    const store = new SessionStore(cwd);
    await store.save({
      id: sessionId,
      model: "crof/glm-5.2",
      mode: "execute",
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    }, [], []);
    const manager = new PortableSessionManager(cwd, sessionId);
    const prepared = await manager.prepare({ kind: "cloud", provider: "e2b" });
    await manager.commit(prepared.nonce);
    const previousCrof = process.env.CROF_API_KEY;
    delete process.env.CROF_API_KEY;
    if (previousStateDir === undefined) delete process.env.VIBE_STATE_DIR;
    else process.env.VIBE_STATE_DIR = previousStateDir;

    // The host helper spawns WITHOUT CROF_API_KEY in its env (simulating a
    // sandbox launcher that doesn't propagate the spawn env). The bootstrap
    // carries the credential via the stdin pipe; the host must apply it and
    // resolve crof, completing the handoff.
    const proc = host(stateDir);
    proc.send({
      op: "bootstrap",
      cwd,
      resume: sessionId,
      executionTarget: { kind: "cloud", provider: "e2b" },
      requiredModels: ["crof/glm-5.2"],
      runtimeCredentials: { CROF_API_KEY: "nahcrof_from_bootstrap" },
    });

    try {
      expect(await proc.next((value) => value.type === "ready")).toEqual({
        type: "ready",
        sessionId,
      });
    } finally {
      if (previousCrof === undefined) delete process.env.CROF_API_KEY;
      else process.env.CROF_API_KEY = previousCrof;
    }
    proc.send({ op: "shutdown" });
  });

  test("rejects malformed messages and answers valid pre-bootstrap RPCs", async () => {
    const proc = host();
    proc.send({ op: "rpc", id: 1, method: "snapshot" });
    expect(await proc.next((value) => value.type === "resp" && value.id === 1)).toMatchObject({
      ok: false,
      error: "not bootstrapped",
    });

    proc.send({ op: "rpc", id: "bad", method: "snapshot" });
    expect(await proc.next((value) => value.type === "fatal")).toMatchObject({
      message: expect.stringContaining("invalid protocol message"),
    });

    proc.send({ op: "rpc", id: 2, method: "renameSession", params: [] });
    expect(await proc.next((value) => value.type === "fatal")).toMatchObject({
      message: expect.stringContaining("invalid protocol message"),
    });

    proc.send({ op: "shutdown" });
    expect(await new Promise<number | null>((resolve) => proc.child.once("exit", resolve))).toBe(0);
  });

  test("scopes rename, archive, and delete RPCs to valid project sessions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-host-project-"));
    const stateDir = mkdtempSync(join(tmpdir(), "vibe-host-state-"));
    roots.push(cwd);
    const previousStateDir = process.env.VIBE_STATE_DIR;
    process.env.VIBE_STATE_DIR = stateDir;
    const store = new SessionStore(cwd);
    if (previousStateDir === undefined) delete process.env.VIBE_STATE_DIR;
    else process.env.VIBE_STATE_DIR = previousStateDir;
    const base = {
      model: "fixture/model",
      mode: "execute" as const,
      goal: null,
      createdAt: 1,
      updatedAt: 2,
    };
    for (const id of ["rename-me", "archive-me", "delete-me"]) {
      await store.save({ ...base, id }, [], []);
    }

    const proc = host(stateDir);
    proc.send({
      op: "rpc",
      id: 1,
      method: "renameSession",
      params: { cwd, id: "rename-me", title: "Renamed" },
    });
    expect(await proc.next((value) => value.type === "resp" && value.id === 1)).toMatchObject({
      ok: true,
      value: { title: "Renamed" },
    });
    expect((await store.load("rename-me"))?.meta.title).toBe("Renamed");

    proc.send({ op: "rpc", id: 2, method: "archiveSession", params: { cwd, id: "archive-me" } });
    expect(await proc.next((value) => value.type === "resp" && value.id === 2)).toMatchObject({
      ok: true,
    });
    expect(await store.load("archive-me")).toBeNull();

    proc.send({ op: "rpc", id: 3, method: "deleteSession", params: { cwd, id: "delete-me" } });
    expect(await proc.next((value) => value.type === "resp" && value.id === 3)).toMatchObject({
      ok: true,
    });
    expect(await store.load("delete-me")).toBeNull();

    proc.send({ op: "rpc", id: 4, method: "deleteSession", params: { cwd, id: "../escape" } });
    expect(await proc.next((value) => value.type === "resp" && value.id === 4)).toMatchObject({
      ok: false,
    });
    proc.send({ op: "shutdown" });
  });
});
