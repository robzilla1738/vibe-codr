import { describe, it, expect } from "vitest";
import { encodeInbound, decodeInbound, decodeOutbound, type HostInbound } from "@shared/protocol";
import type { EngineCommand } from "@shared/commands";
import { isRelayInbound, isRelayOutbound } from "../../../relay/protocol";

// Locks the phone↔relay wire contract: the NDJSON the mobile RemoteEngineClient
// emits is byte-identical to what the relay's decodeInbound accepts, and the
// frames the relay emits decode on the mobile side. This is the 1:1 parity seam.

describe("remote protocol parity (mobile client ↔ relay)", () => {
  it("bootstrap round-trips", () => {
    const msg: HostInbound = { op: "bootstrap", cwd: "/x", resume: "abc", mode: "plan" };
    const line = encodeInbound(msg);
    expect(decodeInbound(line)).toEqual(msg);
  });

  it("send command round-trips for every command shape", () => {
    const commands: EngineCommand[] = [
      { type: "submit-prompt", text: "hi" },
      { type: "run-slash", name: "model", args: "" },
      { type: "set-mode", mode: "execute", start: true },
      { type: "resolve-permission", id: "p1", decision: "always" },
      { type: "resolve-plan", decision: "accept", approvals: "auto" },
      { type: "resolve-question", id: "q1", answers: ["yes"] },
      { type: "abort" },
      { type: "compact" },
    ];
    for (const command of commands) {
      const line = encodeInbound({ op: "send", command });
      expect(decodeInbound(line)).toEqual({ op: "send", command });
    }
  });

  it("rpc round-trips", () => {
    const line = encodeInbound({ op: "rpc", id: 7, method: "snapshot" });
    expect(decodeInbound(line)).toEqual({ op: "rpc", id: 7, method: "snapshot" });
  });

  it("relay → mobile: ready/event/resp frames decode", () => {
    expect(decodeOutbound('{"type":"ready","sessionId":"s1"}')).toEqual({ type: "ready", sessionId: "s1" });
    expect(decodeOutbound('{"type":"resp","id":7,"ok":true,"value":{"x":1}}')).toEqual({ type: "resp", id: 7, ok: true, value: { x: 1 } });
    expect(decodeOutbound('{"type":"fatal","message":"boom"}')).toEqual({ type: "fatal", message: "boom" });
    // an event frame the relay forwards must decode as a valid UIEvent
    const ev = decodeOutbound('{"type":"event","event":{"type":"notice","level":"info","message":"hi"}}');
    expect(ev?.type).toBe("event");
  });

  it("shutdown round-trips", () => {
    expect(decodeInbound(encodeInbound({ op: "shutdown" }))).toEqual({ op: "shutdown" });
  });

  it("accepts guarded Git relay frames and rejects incomplete requests", () => {
    expect(isRelayInbound({ relay: "git", request: { action: "status", cwd: "/x" } })).toBe(true);
    expect(isRelayInbound({ relay: "git", request: { action: "commit", request: { cwd: "/x", message: "ship" } } })).toBe(true);
    expect(isRelayInbound({ relay: "git" })).toBe(false);
    expect(isRelayInbound({ relay: "git", request: { action: "status" } })).toBe(false);
    expect(isRelayOutbound({ relay: "git-result", result: { ok: true, status: null } })).toBe(true);
  });

  it("bounds terminal, file, config, and memory relay frames", () => {
    expect(isRelayInbound({ relay: "term-open", cwd: "/x", cols: 80, rows: 24 })).toBe(true);
    expect(isRelayInbound({ relay: "term-open", cwd: "/x", cols: Number.NaN, rows: 24 })).toBe(false);
    expect(isRelayInbound({ relay: "list-files", cwd: "/x", query: "src", limit: 40 })).toBe(true);
    expect(isRelayInbound({ relay: "list-files", cwd: "/x", query: "", limit: 10_000 })).toBe(false);
    expect(isRelayInbound({ relay: "config-write", request: { scope: "project", cwd: "/x", patch: { model: "openai/gpt" } } })).toBe(true);
    expect(isRelayInbound({ relay: "memory-write", request: { scope: "project", cwd: "/x" } })).toBe(false);
  });

  it("guards Cloud relay control frames", () => {
    expect(isRelayInbound({ relay: "cloud", requestId: "1", request: { action: "settings" } })).toBe(true);
    expect(isRelayInbound({ relay: "cloud", requestId: "2", request: { action: "handoff", request: { cwd: "/x", provider: "e2b" } } })).toBe(true);
    expect(isRelayInbound({ relay: "cloud", requestId: "3", request: { action: "handoff" } })).toBe(false);
    expect(isRelayInbound({ relay: "cloud", requestId: "4", request: { action: "connect", provider: "other", credentials: {} } })).toBe(false);
    expect(isRelayInbound({ relay: "cloud", requestId: "5", request: { action: "connect", provider: "vercel", credentials: { token: "vercel_token" } } })).toBe(true);
    expect(isRelayInbound({ relay: "cloud", requestId: "6", request: { action: "connect", provider: "vercel", credentials: { token: "vercel_token", projectId: "prj_1" } } })).toBe(false);
    expect(isRelayInbound({ relay: "cloud", requestId: "7", request: { action: "connect", provider: "vercel", credentials: {} } })).toBe(true);
    expect(isRelayOutbound({ relay: "cloud-status", event: { status: "starting", message: "Starting" } })).toBe(true);
    expect(isRelayOutbound({ relay: "cloud-result", requestId: "1", result: { ok: true, value: [] } })).toBe(true);
  });
});
