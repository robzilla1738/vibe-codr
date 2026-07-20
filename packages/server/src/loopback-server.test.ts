import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedSession, SessionMeta } from "@vibe/core";
import type { ApiV1SseFrame } from "@vibe/protocol";
import { AsyncQueue, type EngineCommand, type EngineSnapshot, type UIEvent } from "@vibe/shared";
import {
  type LoopbackRuntime,
  type LoopbackServerHandle,
  type LoopbackSessionStore,
  startLoopbackServer,
} from "./loopback-server.ts";

const handles: LoopbackServerHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
});

function snapshot(id: string): EngineSnapshot {
  return {
    sessionId: id,
    model: "test/model",
    mode: "execute",
    goal: null,
    history: [],
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
    busy: false,
    theme: "graphite",
    accentColor: "blue",
    details: "normal",
    mouse: false,
    approvalMode: "ask",
    commandNames: ["status"],
  };
}

class FakeRuntime implements LoopbackRuntime {
  readonly queue = new AsyncQueue<UIEvent>();
  readonly commands: EngineCommand[] = [];
  closed = false;
  constructor(readonly state: EngineSnapshot) {}
  events(): AsyncIterable<UIEvent> {
    return this.queue;
  }
  send(command: EngineCommand): void {
    this.commands.push(command);
  }
  snapshot(): EngineSnapshot {
    return this.state;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

class FakeStore implements LoopbackSessionStore {
  readonly sessions = new Map<string, PersistedSession>();
  archived: string[] = [];
  deleted: string[] = [];
  async list(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map((session) => session.meta);
  }
  async load(id: string): Promise<PersistedSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async fork(id: string, atTurnId: string): Promise<SessionMeta> {
    if (!this.sessions.has(id) && id !== "ses-1") throw new Error("session not found");
    const now = Date.now();
    const meta: SessionMeta = {
      id: "ses-fork",
      model: "test/model",
      mode: "execute",
      goal: null,
      createdAt: now,
      updatedAt: now,
      parentSessionId: id,
      forkedAtTurnId: atTurnId,
      forkedFrom: { sessionId: id, turnId: atTurnId },
    };
    this.sessions.set(meta.id, { meta, modelMessages: [], history: [] });
    return meta;
  }
  async archive(id: string): Promise<boolean> {
    this.archived.push(id);
    return id === "ses-1" || this.sessions.delete(id);
  }
  async delete(id: string): Promise<boolean> {
    this.deleted.push(id);
    return this.sessions.delete(id);
  }
}

interface ByteReader {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: undefined }>;
}
const readerBuffers = new WeakMap<ByteReader, string>();
async function readFrame(reader: ByteReader): Promise<ApiV1SseFrame> {
  const decoder = new TextDecoder();
  let buffer = readerBuffers.get(reader) ?? "";
  while (true) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      readerBuffers.set(reader, buffer);
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data) return JSON.parse(data) as ApiV1SseFrame;
      continue;
    }
    const result = await reader.read();
    if (result.done) throw new Error("SSE ended before a frame arrived");
    buffer += decoder.decode(result.value, { stream: true });
  }
}

test("loopback journey: create, prompt, decide, replay, fork/resume, archive/delete", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vibe-server-"));
  const store = new FakeStore();
  const runtimes = new Map<string, FakeRuntime>();
  let nextNew = 1;
  const handle = await startLoopbackServer({
    cwd,
    dependencies: {
      store,
      token: { token: "test-token", path: join(cwd, "token") },
      openRuntime: async ({ resume }) => {
        const id = resume.kind === "new" ? `ses-${nextNew++}` : resume.session.meta.id;
        const runtime = new FakeRuntime(snapshot(id));
        runtimes.set(id, runtime);
        if (resume.kind === "new") {
          const now = Date.now();
          const meta: SessionMeta = {
            id,
            model: "test/model",
            mode: "execute",
            goal: null,
            createdAt: now,
            updatedAt: now,
          };
          store.sessions.set(id, { meta, modelMessages: [], history: [] });
        }
        return runtime;
      },
    },
  });
  handles.push(handle);
  const auth = { authorization: "Bearer test-token", "content-type": "application/json" };

  expect((await fetch(`${handle.url}/v1/capabilities`)).status).toBe(401);
  const created = await fetch(`${handle.url}/v1/sessions`, {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { session: { id: string } };
  expect(createdBody.session.id).toBe("ses-1");

  const prompted = await fetch(`${handle.url}/v1/sessions/ses-1/prompt`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "hello" }),
  });
  expect(prompted.status).toBe(202);
  expect(runtimes.get("ses-1")?.commands.at(-1)).toEqual({ type: "submit-prompt", text: "hello" });

  const streamAbort = new AbortController();
  const stream = await fetch(`${handle.url}/v1/sessions/ses-1/events`, {
    headers: { authorization: "Bearer test-token" },
    signal: streamAbort.signal,
  });
  const reader = stream.body!.getReader();
  expect((await readFrame(reader)).type).toBe("ready");
  runtimes.get("ses-1")!.queue.push({
    type: "permission-request",
    sessionId: "ses-1",
    id: "permit-1",
    toolName: "write",
    input: {},
  });
  const pending = await readFrame(reader);
  expect(pending.type === "event" && pending.pendingDecisionId).toBe("permit-1");
  await reader.cancel();
  streamAbort.abort();

  const decisionBody = {
    idempotencyKey: "decision-1",
    decision: { kind: "permission", id: "permit-1", decision: "once" },
  };
  const decision = await fetch(`${handle.url}/v1/sessions/ses-1/decision`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(decisionBody),
  });
  expect(decision.status).toBe(202);
  const receipt = await decision.json();
  const repeated = await fetch(`${handle.url}/v1/sessions/ses-1/decision`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(decisionBody),
  });
  expect(await repeated.json()).toEqual(receipt);
  const conflict = await fetch(`${handle.url}/v1/sessions/ses-1/decision`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      ...decisionBody,
      decision: { ...decisionBody.decision, decision: "deny" },
    }),
  });
  expect(conflict.status).toBe(409);
  const stale = await fetch(`${handle.url}/v1/sessions/ses-1/decision`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...decisionBody, idempotencyKey: "decision-2" }),
  });
  expect(stale.status).toBe(409);

  const cursor = pending.cursor;
  runtimes.get("ses-1")!.queue.push({ type: "notice", level: "info", message: "offline event" });
  await Bun.sleep(5);
  const replayAbort = new AbortController();
  const replay = await fetch(
    `${handle.url}/v1/sessions/ses-1/events?cursor=${encodeURIComponent(`${cursor.epoch}:${cursor.sequence}`)}`,
    { headers: { authorization: "Bearer test-token" }, signal: replayAbort.signal },
  );
  const replayReader = replay.body!.getReader();
  const replayReady = await readFrame(replayReader);
  expect(replayReady.type).toBe("ready");
  expect(replayReady.cursor.sequence).toBeGreaterThan(cursor.sequence);
  expect(replayReady.type === "ready" && replayReady.truncated).toBe(false);
  const replayed = await readFrame(replayReader);
  expect(replayed.type === "event" && replayed.event.type).toBe("notice");
  await replayReader.cancel();
  replayAbort.abort();

  const staleCursorAbort = new AbortController();
  const staleCursorStream = await fetch(
    `${handle.url}/v1/sessions/ses-1/events?cursor=other-epoch:0`,
    { headers: { authorization: "Bearer test-token" }, signal: staleCursorAbort.signal },
  );
  const staleCursorReader = staleCursorStream.body!.getReader();
  const resync = await readFrame(staleCursorReader);
  expect(resync.type === "ready" && resync.truncated).toBe(true);
  expect(resync.type === "ready" && resync.snapshot?.sessionId).toBe("ses-1");
  await staleCursorReader.cancel();
  staleCursorAbort.abort();

  const forked = await fetch(`${handle.url}/v1/sessions/ses-1/fork`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ atTurnId: "turn-1" }),
  });
  expect(forked.status).toBe(201);
  const resumed = await fetch(`${handle.url}/v1/sessions/ses-fork/prompt`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "resume" }),
  });
  expect(resumed.status).toBe(202);
  expect(runtimes.get("ses-fork")?.commands.at(-1)).toEqual({
    type: "submit-prompt",
    text: "resume",
  });

  expect(
    (
      await fetch(`${handle.url}/v1/sessions/ses-1/archive`, {
        method: "POST",
        headers: auth,
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(
    (await fetch(`${handle.url}/v1/sessions/ses-fork`, { method: "DELETE", headers: auth })).status,
  ).toBe(200);
  expect(store.archived).toContain("ses-1");
  expect(store.deleted).toContain("ses-fork");
});

test("rejects every requested non-loopback bind", async () => {
  await expect(startLoopbackServer({ cwd: process.cwd(), hostname: "0.0.0.0" })).rejects.toThrow(
    "loopback",
  );
  await expect(startLoopbackServer({ cwd: process.cwd(), hostname: "::1" })).rejects.toThrow(
    "loopback",
  );
});
