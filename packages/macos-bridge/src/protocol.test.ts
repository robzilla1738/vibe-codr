import { describe, expect, test } from "bun:test";
import { decodeInbound, decodeOutbound } from "./protocol.ts";

describe("macOS bridge protocol runtime validation", () => {
  test("accepts valid commands and rejects malformed inbound shapes", () => {
    expect(
      decodeInbound(JSON.stringify({ op: "bootstrap", cwd: "/tmp/project", mode: "plan" })),
    ).toMatchObject({ op: "bootstrap", cwd: "/tmp/project" });
    expect(
      decodeInbound(JSON.stringify({
        op: "bootstrap",
        cwd: "/tmp/project",
        resume: "ses_cloud",
        executionTarget: { kind: "cloud", provider: "e2b" },
      })),
    ).toMatchObject({ executionTarget: { kind: "cloud", provider: "e2b" } });
    expect(
      decodeInbound(JSON.stringify({
        op: "bootstrap",
        cwd: "/tmp/project",
        executionTarget: { kind: "cloud", provider: "unknown" },
      })),
    ).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 1, method: "snapshot" }))).toEqual({
      op: "rpc",
      id: 1,
      method: "snapshot",
    });
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 2,
      method: "beginProviderAuth",
      params: { providerId: "xai-oauth", authMethod: "device" },
    }))).not.toBeNull();
    expect(decodeInbound(JSON.stringify({
      op: "rpc",
      id: 3,
      method: "beginProviderAuth",
      params: { providerId: "unknown", authMethod: "device" },
    }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: "1", method: "snapshot" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 1, method: "unknown" }))).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 2,
          method: "importPortableSession",
          params: { provisional: "true" },
        }),
      ),
    ).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "send", command: { type: "unknown" } }))).toBeNull();
    expect(
      decodeInbound(JSON.stringify({ op: "send", command: { type: "submit-prompt" } })),
    ).toBeNull();
    expect(decodeInbound("[]")).toBeNull();
  });

  test("accepts valid host messages and rejects malformed events and responses", () => {
    expect(decodeOutbound(JSON.stringify({ type: "ready", sessionId: "ses_1" }))).toEqual({
      type: "ready",
      sessionId: "ses_1",
    });
    expect(
      decodeOutbound(
        JSON.stringify({ type: "event", event: { type: "notice", level: "info", message: "ok" } }),
      ),
    ).not.toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify({
          type: "event",
          event: {
            type: "user-message",
            sessionId: "ses_1",
            text: "Continue",
            origin: "engine",
            label: "Goal",
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify({
          type: "event",
          event: { type: "user-message", sessionId: "ses_1", text: "Continue", origin: "other" },
        }),
      ),
    ).toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify({
          type: "event",
          event: {
            type: "user-message",
            sessionId: "ses_1",
            text: "Continue",
            label: { text: "Goal" },
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeOutbound(JSON.stringify({ type: "event", event: { type: "notice", level: "info" } })),
    ).toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify({
          type: "event",
          event: { type: "tasks-updated", sessionId: "s", tasks: null },
        }),
      ),
    ).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "resp", id: 1, ok: false }))).toBeNull();
  });
});
