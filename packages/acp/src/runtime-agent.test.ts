import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { PersistedSession, SessionMeta } from "@vibe/core";
import { ACP_VIBE_METHODS, ApiV1DecisionReceiptSchema, VibeAcpReplayResponseSchema } from "@vibe/protocol";
import { AsyncQueue, type EngineCommand, type EngineSnapshot, type UIEvent } from "@vibe/shared";
import { createAcpAgent, type AcpRuntime, type AcpSessionStore } from "./runtime-agent.ts";

function snapshot(id: string): EngineSnapshot {
  return { sessionId: id, model: "test/model", mode: "execute", goal: null, history: [], tasks: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 }, busy: false, theme: "graphite", accentColor: "blue", details: "normal", mouse: false, approvalMode: "ask", commandNames: [] };
}

class FakeRuntime implements AcpRuntime {
  readonly queue = new AsyncQueue<UIEvent>();
  readonly commands: EngineCommand[] = [];
  constructor(readonly state: EngineSnapshot) {}
  events() { return this.queue; }
  send(command: EngineCommand): void {
    this.commands.push(command);
    if (command.type === "submit-prompt") queueMicrotask(() => {
      this.queue.push({ type: "assistant-text-delta", sessionId: this.state.sessionId, delta: "done" });
      this.queue.push({ type: "engine-idle", sessionId: this.state.sessionId });
    });
  }
  snapshot() { return this.state; }
  async close() { this.queue.close(); }
}

class FakeStore implements AcpSessionStore {
  sessions = new Map<string, PersistedSession>();
  async list(): Promise<SessionMeta[]> { return [...this.sessions.values()].map((item) => item.meta); }
  async load(id: string) { return this.sessions.get(id) ?? null; }
  async fork(id: string, atTurnId: string) {
    const source = this.sessions.get(id);
    if (!source) throw new Error("missing");
    const meta = { ...source.meta, id: "forked", forkedFrom: { sessionId: id, turnId: atTurnId } };
    this.sessions.set(meta.id, { ...source, meta });
    return meta;
  }
  async delete(id: string) { return this.sessions.delete(id); }
}

test("ACP journey validates create, prompt, decisions, cursor replay, and resume", async () => {
  const cwd = process.cwd();
  const store = new FakeStore();
  const runtime = new FakeRuntime(snapshot("session-1"));
  const now = Date.now();
  store.sessions.set("session-1", { meta: { id: "session-1", model: "test/model", mode: "execute", goal: null, createdAt: now, updatedAt: now, turns: [{ id: "turn-1", modelEnd: 0, historyEnd: 0, completedAt: now, origin: "user" }] }, modelMessages: [], history: [] });
  const { app, workspace } = createAcpAgent({
    cwd,
    input: new ReadableStream(), output: new WritableStream(),
    dependencies: { store, openRuntime: async () => runtime },
  });
  const updates: acp.SessionNotification[] = [];
  const client = acp.client().onNotification("session/update", ({ params }) => { updates.push(params); });
  const connection = client.connect(app);
  await connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION });
  expect((await connection.agent.request("session/new", { cwd, mcpServers: [] })).sessionId).toBe("session-1");
  expect((await connection.agent.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "go" }] })).stopReason).toBe("end_turn");
  expect(updates.some((update) => update.update.sessionUpdate === "agent_message_chunk")).toBeTrue();
  runtime.queue.push({ type: "permission-request", sessionId: "session-1", id: "permission-1", toolName: "write", input: {} });
  await Bun.sleep(0);
  const request = { idempotencyKey: "same-key", decision: { kind: "permission" as const, id: "permission-1", decision: "once" as const } };
  const receipt = ApiV1DecisionReceiptSchema.parse(await connection.agent.request(ACP_VIBE_METHODS.decision, { sessionId: "session-1", request }));
  expect(ApiV1DecisionReceiptSchema.parse(await connection.agent.request(ACP_VIBE_METHODS.decision, { sessionId: "session-1", request }))).toEqual(receipt);
  const replay = VibeAcpReplayResponseSchema.parse(await connection.agent.request(ACP_VIBE_METHODS.replay, { sessionId: "session-1" }));
  expect(replay.frames[0]?.type).toBe("ready");
  expect(await connection.agent.request("session/resume", { sessionId: "session-1", cwd })).toBeDefined();
  connection.close();
  await workspace.close();
});
