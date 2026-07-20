import { describe, expect, it } from "vitest";
import {
  isEngineSnapshot,
  isProjectSummaryArray,
  isRenderableUIEvent,
  isRpcResult,
  RPC_CATALOG_FIELD_MAX_CHARS,
  RPC_CATALOG_MAX_ITEMS,
  RPC_PROVIDER_ENV_MAX_ITEMS,
} from "./runtime-guards";

const snapshot = {
  hostInstanceId: "host-1", lastEventSeq: 0,
  sessionId: "ses_1", model: "provider/model", mode: "execute", goal: null,
  history: [], tasks: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 }, busy: false,
  theme: "default", accentColor: "", details: "normal", mouse: false,
  approvalMode: "ask", commandNames: [],
};

describe("RPC runtime guards", () => {
  it("accepts complete snapshots and rejects partial payloads", () => {
    expect(isEngineSnapshot(snapshot)).toBe(true);
    expect(isEngineSnapshot({ ...snapshot, sessionId: 4 })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, sessionId: "x".repeat(1_025) })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, history: null })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, history: [null] })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, usage: { inputTokens: 0, outputTokens: 0 } })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, subagentModel: 42 })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, usage: { ...snapshot.usage, costEstimated: "yes" } })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, usage: { ...snapshot.usage, costUSD: -1 } })).toBe(false);
    expect(isEngineSnapshot({ ...snapshot, git: { branch: "main", dirty: -1, ahead: 0, behind: 0, worktree: false } })).toBe(false);
    expect(isEngineSnapshot({
      ...snapshot,
      pendingCapabilities: [{
        id: "cap_1", integration: "mac", toolName: "open", arguments: {},
        approvalScope: "once", originatingTurn: "turn_1", status: "pending", createdAt: 1,
      }],
    })).toBe(true);
    expect(isEngineSnapshot({ ...snapshot, pendingCapabilities: [{ id: 4 }] })).toBe(false);
    expect(isRpcResult("snapshot", snapshot)).toBe(true);
    expect(isRpcResult("abortInterruptedHandoff", { outcome: "aborted", generation: 0 })).toBe(true);
    expect(isRpcResult("abortInterruptedHandoff", { outcome: "already-committed", generation: 2 })).toBe(true);
    expect(isRpcResult("abortInterruptedHandoff", 0)).toBe(false);
  });

  it("validates project and catalog result shapes", () => {
    const projects = [{ cwd: "/repo", name: "repo", updatedAt: 1, sessions: [{ id: "s", title: "T", model: "m", mode: "execute", goal: null, createdAt: 1, updatedAt: 2 }] }];
    expect(isProjectSummaryArray(projects)).toBe(true);
    expect(isProjectSummaryArray([{ ...projects[0], sessions: [{ ...projects[0]!.sessions[0], id: "x".repeat(1_025) }] }])).toBe(false);
    expect(isProjectSummaryArray([{ cwd: "/repo", sessions: [] }])).toBe(false);
    expect(isRpcResult("listModels", [{ id: "m", providerId: "p", contextWindow: 1_000 }])).toBe(true);
    expect(isRpcResult("listModels", [{ id: "m", providerId: 4 }])).toBe(false);
    expect(isRpcResult("listModels", [{ id: "m", providerId: "p", contextWindow: 0 }])).toBe(false);
    expect(isRpcResult("listProviders", [{ id: "p", configured: true, keyless: false, env: ["KEY"] }])).toBe(true);
    expect(isRpcResult("listProviders", [{ id: "p", configured: "yes", keyless: false, env: [] }])).toBe(false);
    expect(isRpcResult("listModels", [{ id: "", providerId: "p" }])).toBe(false);
    expect(isRpcResult("listSkills", [{ name: "skill", description: "x".repeat(RPC_CATALOG_FIELD_MAX_CHARS + 1) }])).toBe(false);
    expect(isRpcResult("listProviders", [{ id: "p", configured: true, keyless: false, env: Array.from({ length: RPC_PROVIDER_ENV_MAX_ITEMS + 1 }, () => "KEY") }])).toBe(false);
    expect(isRpcResult("listMcp", [{ name: "bad\0name", connected: true, configured: true, toolCount: 0, resourceCount: 0, promptCount: 0 }])).toBe(false);
    expect(isRpcResult("listPluginStatus", [{
      specifier: "./plugin.ts", name: "plugin", version: "1.0.0", status: "degraded",
      reason: "Local plugin is unverified", declaredContributions: ["commands"],
      registeredContributions: { tools: [], providers: [], commands: ["ship"], skills: [], hooks: [] },
      provenance: { source: "local", verified: false },
    }])).toBe(true);
    expect(isRpcResult("listPluginStatus", [{
      specifier: "./plugin.ts", name: "plugin", status: "trusted",
      declaredContributions: [], registeredContributions: { tools: [], providers: [], commands: [], skills: [], hooks: [] },
      provenance: { source: "local", verified: false },
    }])).toBe(false);
    expect(isRpcResult("listAgents", Array.from({ length: RPC_CATALOG_MAX_ITEMS + 1 }, (_, index) => ({ name: `a${index}`, description: "", model: null, mode: "execute" })))).toBe(false);
  });

  it("rejects malformed nested renderer event payloads", () => {
    expect(isRenderableUIEvent({
      type: "context-updated",
      sessionId: "s",
      usedTokens: 1,
      contextWindow: 128_000,
    })).toBe(true);
    expect(isRenderableUIEvent({
      type: "context-updated",
      sessionId: "s",
      usedTokens: -1,
      contextWindow: 128_000,
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "context-updated",
      sessionId: "s",
      usedTokens: 1,
      contextWindow: 0,
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "queue-changed",
      active: { id: "q1", label: "work" },
      pending: [],
    })).toBe(true);
    expect(isRenderableUIEvent({
      type: "queue-changed",
      active: null,
      pending: [null],
    } as never)).toBe(false);
    expect(isRenderableUIEvent({
      type: "queue-changed",
      active: { id: "x".repeat(1_025), label: "work" },
      pending: [],
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "plan-presented",
      sessionId: "s",
      plan: "plan",
      sources: [null],
    } as never)).toBe(false);
    expect(isRenderableUIEvent({
      type: "jobs-changed",
      sessionId: "s",
      jobs: [{ id: "j", status: "running" }],
    } as never)).toBe(false);
    expect(isRenderableUIEvent({
      type: "usage-updated",
      sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: -0.01 },
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "file-changed",
      sessionId: "s",
      toolCallId: "t",
      path: "a.ts",
      action: "edit",
      diff: "",
      added: -1,
      removed: 0,
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "compacted",
      sessionId: "s",
      freedTokens: -1,
    })).toBe(false);
    expect(isRenderableUIEvent({
      type: "user-message",
      sessionId: "s",
      text: "work",
      origin: "automation",
    } as never)).toBe(false);
  });
});
