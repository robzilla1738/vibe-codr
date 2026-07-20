import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ENGINE_COMMAND_SCHEMAS,
  ENGINE_COMMAND_TYPES,
  HOST_INBOUND_FRAME_SCHEMAS,
  HOST_INBOUND_OPS,
  HOST_OUTBOUND_FRAME_SCHEMAS,
  HOST_OUTBOUND_TYPES,
  HOST_PROTOCOL_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
  HOST_RPC_REQUEST_SCHEMAS,
  HOST_RPC_SCHEMAS,
  RPC_METHODS,
  UI_EVENT_SCHEMAS,
  UI_EVENT_TYPES,
  decodeInbound,
  decodeOutbound,
  validateRpcResult,
} from "@vibe/protocol/host-v2";
import {
  EngineCommandSchema,
  EngineSnapshotSchema,
  RuntimeErrorDataV1Schema,
  UIEventSchema,
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
    expect(Object.keys(HOST_RPC_REQUEST_SCHEMAS)).toEqual([...RPC_METHODS]);
    expect(Object.keys(HOST_INBOUND_FRAME_SCHEMAS)).toEqual([...HOST_INBOUND_OPS]);
    expect(Object.keys(HOST_OUTBOUND_FRAME_SCHEMAS)).toEqual([...HOST_OUTBOUND_TYPES]);
    expect(new Set(ENGINE_COMMAND_TYPES).size).toBe(ENGINE_COMMAND_TYPES.length);
    expect(new Set(UI_EVENT_TYPES).size).toBe(UI_EVENT_TYPES.length);
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
    expect(new Set(HOST_INBOUND_OPS).size).toBe(HOST_INBOUND_OPS.length);
    expect(new Set(HOST_OUTBOUND_TYPES).size).toBe(HOST_OUTBOUND_TYPES.length);
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

  test("requires method-specific RPC inputs without narrowing accepted v2 fallbacks", () => {
    const inbound = (method: string, params?: unknown) =>
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 1,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );

    expect(inbound("snapshot")).not.toBeNull();
    expect(inbound("beginProviderAuth")).toBeNull();
    expect(inbound("beginProviderAuth", { providerId: "openai-codex" })).toBeNull();
    expect(
      inbound("beginProviderAuth", {
        providerId: "openai-codex",
        authMethod: "browser",
      }),
    ).not.toBeNull();
    const replayWithoutHost = inbound("replayEvents", { afterSeq: 0 });
    expect(replayWithoutHost).not.toBeNull();
    expect(
      validateRpcResult("replayEvents", {
        hostInstanceId: "authoritative-host",
        events: [],
        lastEventSeq: 0,
        truncated: true,
      }),
    ).toBeTrue();
    expect(inbound("replayEvents", { hostInstanceId: "host-1", afterSeq: 0 })).not.toBeNull();
    expect(inbound("archiveProject")).not.toBeNull();
    expect(inbound("archiveProject", {})).not.toBeNull();
    expect(inbound("searchSessions")).not.toBeNull();
    expect(inbound("exportPortableSession", { engineRevision: "rev" })).toBeNull();
    expect(
      inbound("exportPortableSession", { engineRevision: "rev", ownershipGeneration: 1 }),
    ).not.toBeNull();
    expect(inbound("importPortableSession", { engineRevision: "rev" })).toBeNull();
    expect(
      inbound("importPortableSession", {
        engineRevision: "rev",
        archivePath: "/tmp/archive.json",
      }),
    ).not.toBeNull();
    expect(
      inbound("importPortableSession", {
        engineRevision: "rev",
        archivePath: "/tmp/archive.json",
        archive: {
          schemaVersion: 1,
          sessionId: "session-1",
          sourceRoot: "/tmp/project",
          sourceStateRoot: "/tmp/state",
          ownershipGeneration: 1,
          executionTarget: { kind: "local" },
          engineRevision: "rev",
          createdAt: 1,
          files: [],
          pendingCapabilities: [],
          archiveSha256: "sha256",
        },
      }),
    ).not.toBeNull();
  });

  test("validates versioned JSON-safe runtime error metadata", () => {
    const failure = {
      schemaVersion: 1 as const,
      code: "runtime-not-ready",
      message: "The runtime did not become ready.",
      retryable: true,
      details: { attempt: 2, provider: "cloud", nested: [true, null] },
    };
    expect(RuntimeErrorDataV1Schema.parse(failure)).toEqual(failure);
    expect(RuntimeErrorDataV1Schema.safeParse({ ...failure, code: "" }).success).toBeFalse();
    expect(
      RuntimeErrorDataV1Schema.safeParse({ ...failure, details: { elapsedMs: Number.NaN } })
        .success,
    ).toBeFalse();
    expect(RuntimeErrorDataV1Schema.safeParse({ ...failure, stack: "secret" }).success).toBeFalse();
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
