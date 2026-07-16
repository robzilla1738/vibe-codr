import { describe, expect, it } from "vitest";
import type { EngineSnapshot } from "../../shared/types";
import { assertCloudSessionContinuity, cloudProjectStateRoot } from "./session-continuity";

const roots = {
  sourceRoot: "/Users/test/project",
  sourceStateRoot: "/Users/test/.vibe/state/source-hash",
  targetRoot: "/home/user/vibe/project",
  targetStateRoot: "/home/user/vibe/state/target-hash",
};

function snapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    sessionId: "session-same",
    model: "ollama/glm-5.2",
    subagentModel: "ollama/gemma4:31b",
    mode: "execute",
    goal: null,
    history: [{
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "Review the attached file" }],
      createdAt: 1,
      metadata: { statePath: "/Users/test/.vibe/state/source-hash/session.json" },
    }],
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
    busy: false,
    theme: "graphite",
    accentColor: "#000000",
    details: "normal",
    mouse: true,
    approvalMode: "ask",
    commandNames: [],
    ...overrides,
  };
}

function remoteSnapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return snapshot({
    history: [{
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "Review the attached file" }],
      createdAt: 1,
      metadata: { statePath: "/home/user/vibe/state/target-hash/session.json" },
    }],
    ...overrides,
  });
}

describe("cloud session continuity", () => {
  it("accepts the exact session after portable path rebasing", () => {
    expect(() => assertCloudSessionContinuity(snapshot(), remoteSnapshot(), roots)).not.toThrow();
  });

  it.each([
    ["session identity", { sessionId: "session-replacement" }],
    ["main model", { model: "anthropic/claude-opus-4-8" }],
    ["subagent model", { subagentModel: "anthropic/claude-opus-4-8" }],
    ["mode", { mode: "plan" as const }],
    ["conversation", { history: [] }],
  ])("rejects changed %s", (_label, changed) => {
    expect(() => assertCloudSessionContinuity(snapshot(), remoteSnapshot(changed), roots)).toThrow(/continuity failed/i);
  });

  it("derives the same state directory shape as the engine", () => {
    expect(cloudProjectStateRoot("/home/user/vibe/state", "/home/user/vibe/project"))
      .toMatch(/^\/home\/user\/vibe\/state\/[0-9a-f]{16}$/);
  });
});
