import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ENGINE_COMMAND_SCHEMAS,
  ENGINE_COMMAND_TYPES,
  EngineCommandSchema,
  EngineSnapshotSchema,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  HOST_RPC_SCHEMAS,
  RPC_METHODS,
  UI_EVENT_SCHEMAS,
  UI_EVENT_TYPES,
  UIEventSchema,
  decodeInbound,
  decodeOutbound,
  validateRpcResult,
} from "./index.ts";
import { GOLDEN_HOST_WIRE_LINES } from "./fixtures.ts";

const snapshot = {
  sessionId: "session-1",
  model: "test/model",
  mode: "execute",
  goal: null,
  history: [],
  tasks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
  busy: false,
  theme: "default",
  accentColor: "#fff",
  details: "normal",
  mouse: true,
  approvalMode: "ask",
  commandNames: [],
} as const;

describe("canonical protocol schemas", () => {
  test("round-trips representative commands, events, and snapshots", () => {
    const command = { type: "resolve-question", id: "q-1", answers: ["yes"] } as const;
    const event = {
      type: "question-request",
      sessionId: "session-1",
      question: {
        id: "q-1",
        question: "Proceed?",
        choices: [{ label: "Yes" }],
        multiple: false,
        allowFreeform: true,
        createdAt: 1,
      },
    } as const;
    expect(JSON.stringify(EngineCommandSchema.parse(command))).toBe(JSON.stringify(command));
    expect(JSON.stringify(UIEventSchema.parse(event))).toBe(JSON.stringify(event));
    expect(JSON.stringify(EngineSnapshotSchema.parse(snapshot))).toBe(JSON.stringify(snapshot));
  });

  test("keeps exhaustive, duplicate-free discriminator and RPC registries", () => {
    expect(Object.keys(ENGINE_COMMAND_SCHEMAS)).toEqual([...ENGINE_COMMAND_TYPES]);
    expect(Object.keys(UI_EVENT_SCHEMAS)).toEqual([...UI_EVENT_TYPES]);
    expect(Object.keys(HOST_RPC_SCHEMAS)).toEqual([...RPC_METHODS]);
    expect(new Set(ENGINE_COMMAND_TYPES).size).toBe(ENGINE_COMMAND_TYPES.length);
    expect(new Set(UI_EVENT_TYPES).size).toBe(UI_EVENT_TYPES.length);
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
    expect(HOST_PROTOCOL_VERSION).toBe(2);
    expect(HOST_PROTOCOL_CAPABILITIES).toEqual(["event-replay"]);
  });

  test("rejects malformed payloads and unknown discriminators", () => {
    expect(EngineCommandSchema.safeParse({ type: "submit-prompt" }).success).toBeFalse();
    expect(EngineCommandSchema.safeParse({ type: "future-command" }).success).toBeFalse();
    expect(
      UIEventSchema.safeParse({ type: "notice", level: "other", message: "x" }).success,
    ).toBeFalse();
    expect(UIEventSchema.safeParse({ type: "future-event" }).success).toBeFalse();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 1, method: "futureRpc" }))).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({ op: "rpc", id: 1, method: "snapshot", params: { query: "wrong method" } }),
      ),
    ).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "ready", protocolVersion: 3 }))).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "resp", id: 1, ok: false }))).toBeNull();
  });

  test("validates exact RPC result contracts", () => {
    expect(
      validateRpcResult("snapshot", { ...snapshot, hostInstanceId: "host-1", lastEventSeq: 0 }),
    ).toBeTrue();
    expect(validateRpcResult("snapshot", snapshot)).toBeFalse();
    expect(
      validateRpcResult("replayEvents", {
        hostInstanceId: "host-1",
        events: [],
        lastEventSeq: 0,
        truncated: false,
      }),
    ).toBeTrue();
    expect(validateRpcResult("recoverLostCloudOwnership", -1)).toBeFalse();
  });

  test("matches golden wire lines and preserves compatible extra keys", () => {
    const fixture = readFileSync(
      new URL("../fixtures/host-protocol-v2.jsonl", import.meta.url),
      "utf8",
    )
      .trimEnd()
      .split("\n");
    expect(fixture).toEqual([...GOLDEN_HOST_WIRE_LINES]);
    for (const line of fixture) {
      const raw = JSON.parse(line) as { op?: string; type?: string };
      const decoded = raw.op ? decodeInbound(line) : decodeOutbound(line);
      expect(decoded).not.toBeNull();
      expect(JSON.stringify(decoded)).toBe(line);
    }
    const withExtra = JSON.stringify({
      op: "send",
      command: { type: "abort", futureCommandField: true },
      futureFrameField: { nested: true },
    });
    expect(decodeInbound(withExtra)).toEqual(JSON.parse(withExtra));
  });
});
