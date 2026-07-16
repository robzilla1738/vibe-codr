import { describe, expect, it } from "vitest";
import {
  decodeInbound,
  decodeOutbound,
  encodedEngineCommandBytes,
  HOST_INBOUND_SAFE_BYTES,
  listedEngineCommandTypes,
  listedUIEventTypes,
} from "./protocol";

describe("NDJSON protocol runtime validation", () => {
  it("rejects malformed inbound messages", () => {
    expect(decodeInbound(JSON.stringify({ op: "bootstrap", cwd: "/repo" }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "bootstrap", cwd: "" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 0, method: "snapshot" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "send", command: { type: "bogus" } }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "send", command: { type: "submit-prompt", text: 7 } }))).toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 1,
      method: "importPortableSession",
      params: { provisional: "true" },
    }))).toBeNull();
  });

  it("accepts bootstrap continue flag and rejects non-boolean continue", () => {
    const ok = decodeInbound(
      JSON.stringify({ op: "bootstrap", cwd: "/repo", continue: true }),
    );
    expect(ok).not.toBeNull();
    expect(ok && ok.op === "bootstrap" && ok.continue).toBe(true);
    expect(
      decodeInbound(JSON.stringify({ op: "bootstrap", cwd: "/repo", continue: "yes" })),
    ).toBeNull();
  });

  it("validates an explicit cloud bootstrap execution target", () => {
    expect(decodeInbound(JSON.stringify({
      op: "bootstrap",
      cwd: "/repo",
      resume: "ses_cloud",
      executionTarget: { kind: "cloud", provider: "e2b" },
    }))).toMatchObject({ executionTarget: { kind: "cloud", provider: "e2b" } });
    expect(decodeInbound(JSON.stringify({
      op: "bootstrap",
      cwd: "/repo",
      executionTarget: { kind: "cloud", provider: "unknown" },
    }))).toBeNull();
  });

  it("rejects rpc params with non-string name", () => {
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 1,
          method: "renameProject",
          params: { cwd: "/r", name: 42 },
        }),
      ),
    ).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 1,
          method: "renameProject",
          params: { cwd: "/r", name: "Mine" },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(JSON.stringify({
        op: "rpc",
        id: 1,
        method: "renameProject",
        params: { cwd: "/r", name: "Mine", unexpected: true },
      })),
    ).toBeNull();
    expect(
      decodeInbound(JSON.stringify({
        op: "rpc",
        id: 1,
        method: "renameSession",
        params: { cwd: "/r", id: "s", title: "x".repeat(1_025) },
      })),
    ).toBeNull();
  });

  it("accepts subscription auth RPC parameters and rejects unknown auth fields", () => {
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 1,
      method: "beginProviderAuth",
      params: { providerId: "openai-codex", authMethod: "browser" },
    }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 2,
      method: "providerAuthStatus",
      params: { providerId: "xai-oauth", authSessionId: "auth-1" },
    }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 3,
      method: "cancelProviderAuth",
      params: { providerId: "xai-oauth", authSessionId: "auth-1" },
    }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 4,
      method: "logoutProviderAuth",
      params: { providerId: "openai-codex" },
    }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 5,
      method: "beginProviderAuth",
      params: { providerId: "openai-codex", authMethod: "browser", callback: "unsafe" },
    }))).toBeNull();
  });

  it("rejects malformed host messages and UI events", () => {
    expect(decodeOutbound(JSON.stringify({ type: "ready", sessionId: "ses_1" }))).not.toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "ready", sessionId: 1 }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "assistant-text-delta", delta: "missing session" } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "notice", level: "info", message: "ok" } }))).not.toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "jobs-changed", sessionId: "s", jobs: "bad" } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "permission-settled", sessionId: "s", ids: [3], reason: "aborted" } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "loop-tick", sessionId: "s", loopId: "l", iteration: -1 } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "goal-run", sessionId: "s", run: { active: true, phase: "execute", round: -1, max: 3, pausedReason: null, met: false } } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "tool-call-progress", sessionId: "s", toolCallId: "x".repeat(1_025), chunk: "data" } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "event", event: { type: "permission-settled", sessionId: "s", ids: ["ok", "bad\0id"], reason: "aborted" } }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "resp", id: 1, ok: false }))).toBeNull();
  });

  it("rejects oversized runtime ids in both protocol directions", () => {
    const oversized = "x".repeat(1_025);
    expect(decodeOutbound(JSON.stringify({ type: "ready", sessionId: oversized }))).toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "send",
      command: { type: "resolve-permission", id: oversized, decision: "deny" },
    }))).toBeNull();
  });

  it("lists exhaustive UIEvent and EngineCommand allowlists", () => {
    const events = listedUIEventTypes();
    const commands = listedEngineCommandTypes();
    expect(events).toContain("engine-idle");
    expect(events).toContain("user-message");
    expect(events.length).toBeGreaterThanOrEqual(40);
    expect(commands).toContain("submit-prompt");
    expect(commands).toContain("resolve-permission");
    expect(new Set(events).size).toBe(events.length);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("measures encoded command bytes against the host-safe ceiling", () => {
    expect(encodedEngineCommandBytes({ type: "submit-prompt", text: "hello" }))
      .toBeLessThan(HOST_INBOUND_SAFE_BYTES);
    expect(encodedEngineCommandBytes({
      type: "submit-prompt",
      text: "😀".repeat(HOST_INBOUND_SAFE_BYTES),
    })).toBeGreaterThan(HOST_INBOUND_SAFE_BYTES);
  });
});
