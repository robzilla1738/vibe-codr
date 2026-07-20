import { describe, it, expect } from "vitest";
import {
  encodeInbound,
  decodeInbound,
  decodeOutbound,
  type EngineCommand,
  type HostInbound,
} from "../../../src/shared/protocol";
import { isRelayInbound, isRelayOutbound, MOBILE_UPLOAD_MAX_BASE64_CHARS } from "../../../relay/protocol";

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
      { type: "cancel-activity", id: "activity-1" },
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
    expect(decodeOutbound('{"type":"ready","protocolVersion":2,"engineRevision":"test","capabilities":["event-replay"],"hostInstanceId":"host-1","sessionId":"s1"}')).toMatchObject({ type: "ready", protocolVersion: 2, hostInstanceId: "host-1", sessionId: "s1" });
    expect(decodeOutbound('{"type":"resp","id":7,"ok":true,"value":{"x":1}}')).toEqual({ type: "resp", id: 7, ok: true, value: { x: 1 } });
    expect(decodeOutbound('{"type":"fatal","message":"boom"}')).toEqual({ type: "fatal", message: "boom" });
    // an event frame the relay forwards must decode as a valid UIEvent
    const ev = decodeOutbound('{"type":"event","hostInstanceId":"host-1","seq":1,"event":{"type":"notice","level":"info","message":"hi"}}');
    expect(ev?.type).toBe("event");
    const correlated = decodeOutbound('{"type":"event","hostInstanceId":"host-1","seq":2,"event":{"type":"user-message","sessionId":"s1","turnId":"turn-opaque","text":"hi"}}');
    expect(correlated).toMatchObject({ type: "event", event: { type: "user-message", turnId: "turn-opaque" } });

    const currentEvents = [
      { type: "plan-state-changed", sessionId: "s1", state: { status: "pending", updatedAt: 1 } },
      { type: "question-request", sessionId: "s1", question: { id: "q1", question: "Proceed?", choices: [{ label: "Yes" }], multiple: false, allowFreeform: false, createdAt: 1 } },
      { type: "question-settled", sessionId: "s1", id: "q1", reason: "answered" },
      { type: "activities-changed", sessionId: "s1", activities: [{ id: "activity-1", kind: "shell", label: "Tests", status: "running" }] },
    ];
    for (const [index, event] of currentEvents.entries()) {
      expect(decodeOutbound(JSON.stringify({ type: "event", hostInstanceId: "host-1", seq: index + 3, event })))
        .toMatchObject({ type: "event", event });
    }
  });

  it("shutdown round-trips", () => {
    expect(decodeInbound(encodeInbound({ op: "shutdown" }))).toEqual({ op: "shutdown" });
  });

  it("accepts guarded Git relay frames and rejects incomplete requests", () => {
    expect(isRelayInbound({ relay: "git", requestId: "git-1", request: { action: "status", cwd: "/x" } })).toBe(true);
    expect(isRelayInbound({ relay: "git", requestId: "git-2", request: { action: "commit", request: { cwd: "/x", message: "ship" } } })).toBe(true);
    expect(isRelayInbound({ relay: "git" })).toBe(false);
    expect(isRelayInbound({ relay: "git", requestId: "git-bad", request: { action: "status" } })).toBe(false);
    expect(isRelayOutbound({ relay: "git-result", requestId: "git-1", result: { ok: true, status: null } })).toBe(true);
  });

  it("bounds terminal, file, upload, config, and memory relay frames", () => {
    expect(isRelayInbound({ relay: "term-open", requestId: "term-1", cwd: "/x", cols: 80, rows: 24 })).toBe(true);
    expect(isRelayInbound({ relay: "term-open", requestId: "term-2", cwd: "/x", cols: Number.NaN, rows: 24 })).toBe(false);
    expect(isRelayInbound({ relay: "list-files", requestId: "files-1", cwd: "/x", query: "src", limit: 40 })).toBe(true);
    expect(isRelayInbound({ relay: "list-files", requestId: "files-2", cwd: "/x", query: "", limit: 10_000 })).toBe(false);
    expect(isRelayInbound({ relay: "upload-file", requestId: "upload-1", cwd: "/x", name: "photo.png", mimeType: "image/png", dataBase64: "aGk=" })).toBe(true);
    expect(isRelayInbound({ relay: "upload-file", requestId: "upload-2", cwd: "/x", name: "photo.png", dataBase64: "not base64" })).toBe(false);
    expect(isRelayInbound({ relay: "upload-file", requestId: "upload-3", cwd: "/x", name: "photo.png", dataBase64: "A".repeat(MOBILE_UPLOAD_MAX_BASE64_CHARS + 4) })).toBe(false);
    expect(isRelayOutbound({ relay: "upload-result", requestId: "upload-1", result: { ok: true, path: ".vibe/mobile-attachments/id-photo.png", name: "photo.png", size: 2 } })).toBe(true);
    expect(isRelayInbound({ relay: "config-write", requestId: "config-1", request: { scope: "project", cwd: "/x", patch: { model: "openai/gpt" } } })).toBe(true);
    expect(isRelayInbound({ relay: "memory-write", requestId: "memory-1", request: { scope: "project", cwd: "/x" } })).toBe(false);
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
