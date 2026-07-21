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
  GoalCompletionStatusSchema,
  GoalRunInfoSchema,
  PROTOCOL_LIMITS_V1,
  RuntimeErrorDataV1Schema,
  UIEventSchema,
  legacyGoalMet,
} from "./index.ts";
import {
  isEngineSnapshot as isClientEngineSnapshot,
  isProjectSummaryArray as isClientProjectSummaryArray,
  isUIEvent as isClientUIEvent,
} from "./client-runtime.ts";
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
  test("accepts optional assistant output phases and rejects unknown phases", () => {
    for (const phase of ["commentary", "final"] as const) {
      const event = { type: "assistant-text-delta", sessionId: "session-1", delta: "text", phase } as const;
      expect(UIEventSchema.safeParse(event).success).toBeTrue();
      expect(isClientUIEvent(event)).toBeTrue();
    }
    const invalid = { type: "assistant-text-delta", sessionId: "session-1", delta: "text", phase: "thinking" };
    expect(UIEventSchema.safeParse(invalid).success).toBeFalse();
    expect(isClientUIEvent(invalid)).toBeFalse();
  });

  test("keeps goal completion evidence explicit and legacy met derived", () => {
    for (const status of ["verified", "met-unverified", "paused", "unmet"] as const) {
      expect(GoalCompletionStatusSchema.parse(status)).toBe(status);
      expect(legacyGoalMet(status)).toBe(status === "verified" || status === "met-unverified");
      const event = {
        type: "engine-idle",
        sessionId: "session-1",
        goalCompletionStatus: status,
        met: legacyGoalMet(status),
      } as const;
      expect(UIEventSchema.safeParse(event).success).toBeTrue();
      expect(isClientUIEvent(event)).toBeTrue();
    }
    expect(GoalCompletionStatusSchema.safeParse("self-reported-verified").success).toBeFalse();
    const contradictory = {
      type: "engine-idle",
      sessionId: "session-1",
      goalCompletionStatus: "met-unverified",
      met: false,
    } as const;
    expect(UIEventSchema.safeParse(contradictory).success).toBeFalse();
    expect(isClientUIEvent(contradictory)).toBeFalse();
    expect(GoalRunInfoSchema.safeParse({
      active: false,
      phase: null,
      round: 1,
      max: 10,
      pausedReason: null,
      goalCompletionStatus: "verified",
      met: false,
    }).success).toBeFalse();
  });

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

  test("keeps dependency-free client guards aligned on renderer safety boundaries", () => {
    expect(isClientEngineSnapshot(snapshot)).toBeTrue();
    expect(
      isClientEngineSnapshot({
        ...snapshot,
        usage: { ...snapshot.usage, costUSD: -1 },
      }),
    ).toBeFalse();
    for (const unsafe of ["", "bad\0name"]) {
      const withUnsafeCapability = {
        ...snapshot,
        pendingCapabilities: [{
          id: "capability-1",
          integration: unsafe,
          toolName: "tool",
          arguments: {},
          approvalScope: "once",
          originatingTurn: "turn-1",
          status: "pending",
          createdAt: 1,
        }],
      };
      expect(EngineSnapshotSchema.safeParse(withUnsafeCapability).success).toBeFalse();
      expect(isClientEngineSnapshot(withUnsafeCapability)).toBeFalse();
      expect(
        EngineSnapshotSchema.safeParse({
          ...withUnsafeCapability,
          pendingCapabilities: [{
            ...withUnsafeCapability.pendingCapabilities[0],
            integration: "integration",
            toolName: unsafe,
          }],
        }).success,
      ).toBeFalse();
      expect(
        isClientEngineSnapshot({
          ...withUnsafeCapability,
          pendingCapabilities: [{
            ...withUnsafeCapability.pendingCapabilities[0],
            integration: "integration",
            toolName: unsafe,
          }],
        }),
      ).toBeFalse();
    }
    expect(
      isClientProjectSummaryArray([
        {
          cwd: "/repo",
          name: "repo",
          updatedAt: 1,
          sessions: [
            {
              id: "session-1",
              title: "Session",
              model: "test/model",
              mode: "execute",
              goal: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ]),
    ).toBeTrue();
    expect(
      isClientUIEvent({
        type: "tool-call-progress",
        sessionId: "session-1",
        toolCallId: "bad\0id",
        chunk: "data",
      }),
    ).toBeFalse();
  });

  test("accepts authoritative by-model usage while retaining legacy payload compatibility", () => {
    const bucket = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
      steps: 1,
      turns: 1,
      providerLatencyMs: 25,
      costUSD: 0.01,
      actualCostUSD: 0.01,
    };
    expect(
      EngineSnapshotSchema.safeParse({
        ...snapshot,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 4,
          cacheWriteTokens: 2,
          steps: 1,
          turns: 1,
          providerLatencyMs: 25,
          costUSD: 0.01,
          actualCostUSD: 0.01,
          byModel: { "test/model": bucket },
        },
      }).success,
    ).toBeTrue();
    expect(
      isClientEngineSnapshot({
        ...snapshot,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 4,
          cacheWriteTokens: 2,
          steps: 1,
          turns: 1,
          providerLatencyMs: 25,
          costUSD: 0.01,
          actualCostUSD: 0.01,
          byModel: { "test/model": bucket },
        },
      }),
    ).toBeTrue();
    // byModel remains optional for the one-release wire compatibility window.
    expect(EngineSnapshotSchema.safeParse(snapshot).success).toBeTrue();
    expect(
      EngineSnapshotSchema.safeParse({
        ...snapshot,
        usage: {
          ...snapshot.usage,
          byModel: { "test/model": { ...bucket, providerLatencyMs: -1 } },
        },
      }).success,
    ).toBeFalse();
    for (const malformedUsage of [
      { ...snapshot.usage, byModel: { "": { ...bucket, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, actualCostUSD: 0, cachedInputTokens: 0, cacheWriteTokens: 0, steps: 0, turns: 0, providerLatencyMs: 0 } } },
      { ...snapshot.usage, byModel: { "test/model": { ...bucket, totalTokens: 99 } } },
      { ...snapshot.usage, byModel: { "test/model": { ...bucket, actualCostUSD: 0.02 } } },
      { ...snapshot.usage, byModel: { "test/model": bucket } },
    ]) {
      const candidate = { ...snapshot, usage: malformedUsage };
      expect(EngineSnapshotSchema.safeParse(candidate).success).toBeFalse();
      expect(isClientEngineSnapshot(candidate)).toBeFalse();
    }
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

  test("centralizes renderer-safe numeric, identifier, catalog, and RPC bounds", () => {
    expect(
      EngineSnapshotSchema.safeParse({
        ...snapshot,
        usage: { ...snapshot.usage, costUSD: -0.01 },
      }).success,
    ).toBeFalse();
    expect(
      EngineSnapshotSchema.safeParse({
        ...snapshot,
        git: { branch: "main", dirty: -1, ahead: 0, behind: 0, worktree: false },
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({
        type: "context-updated",
        sessionId: "session-1",
        usedTokens: -1,
        contextWindow: 128_000,
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({
        type: "context-updated",
        sessionId: "session-1",
        usedTokens: 1,
        contextWindow: 0,
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({
        type: "file-changed",
        sessionId: "session-1",
        toolCallId: "tool-1",
        path: "a.ts",
        action: "edit",
        diff: "",
        added: -1,
        removed: 0,
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({ type: "loop-tick", loopId: "loop-1", iteration: -1 }).success,
    ).toBeFalse();

    expect(
      validateRpcResult("listModels", [{ id: "m", providerId: "p", contextWindow: 0 }]),
    ).toBeFalse();
    expect(validateRpcResult("listModels", [{ id: "", providerId: "p" }])).toBeFalse();
    expect(
      validateRpcResult(
        "listAgents",
        Array.from({ length: PROTOCOL_LIMITS_V1.catalogItems + 1 }, (_, index) => ({
          name: `agent-${index}`,
          description: "",
          model: null,
          mode: "execute",
        })),
      ),
    ).toBeFalse();
    expect(
      validateRpcResult("searchSessions", [
        {
          cwd: "/repo",
          sessionId: "session-1",
          role: "user",
          timestamp: 1,
          snippet: "x".repeat(PROTOCOL_LIMITS_V1.searchSnippetChars + 1),
          score: 1,
        },
      ]),
    ).toBeFalse();
    expect(validateRpcResult("recoverLostCloudOwnership", 0)).toBeFalse();

    const oversizedId = "x".repeat(PROTOCOL_LIMITS_V1.runtimeIdentifierChars + 1);
    expect(
      EngineSnapshotSchema.safeParse({ ...snapshot, sessionId: oversizedId }).success,
    ).toBeFalse();
    expect(
      EngineCommandSchema.safeParse({
        type: "resolve-permission",
        id: oversizedId,
        decision: "deny",
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({
        type: "tool-call-progress",
        sessionId: "session-1",
        toolCallId: oversizedId,
        chunk: "data",
      }).success,
    ).toBeFalse();
    expect(
      UIEventSchema.safeParse({
        type: "queue-changed",
        active: { id: oversizedId, label: "queued" },
        pending: [],
      }).success,
    ).toBeFalse();
    expect(
      decodeInbound(
        JSON.stringify({ op: "rpc", id: 1, method: "deleteSession", params: { id: oversizedId } }),
      ),
    ).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 1,
          method: "searchSessions",
          params: { query: "x".repeat(PROTOCOL_LIMITS_V1.queryChars + 1) },
        }),
      ),
    ).toBeNull();
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

  test("rejects unsafe identifiers and credentials in RPC results", () => {
    for (const method of ["deleteSession", "archiveSession"] as const) {
      expect(validateRpcResult(method, { id: "session-1" })).toBeTrue();
      expect(validateRpcResult(method, { id: "" })).toBeFalse();
      expect(validateRpcResult(method, { id: "bad\0id" })).toBeFalse();
    }
    expect(
      validateRpcResult("forkSession", {
        id: "session-2",
        cwd: "/repo",
        atTurnId: "turn-1",
      }),
    ).toBeTrue();
    expect(
      validateRpcResult("forkSession", { id: "", cwd: "/repo", atTurnId: "turn-1" }),
    ).toBeFalse();
    expect(
      validateRpcResult("forkSession", { id: "session-1", cwd: "/repo", atTurnId: "" }),
    ).toBeFalse();
    expect(validateRpcResult("importPortableSession", { sessionId: "" })).toBeFalse();
    expect(validateRpcResult("importPortableSession", { sessionId: "session-1" })).toBeTrue();
    expect(
      validateRpcResult("prepareHandoff", {
        sessionId: "session-1",
        ownershipGeneration: 2,
        previousGeneration: 1,
        nonce: "",
        target: { kind: "cloud", provider: "e2b" },
        preparedAt: 1,
      }),
    ).toBeFalse();
    expect(
      validateRpcResult("exportProviderAuth", { providerId: "openai-codex", access: "" }),
    ).toBeFalse();
    expect(
      validateRpcResult("exportProviderAuth", {
        providerId: "openai-codex",
        access: "credential",
      }),
    ).toBeTrue();
  });

  test("requires replayed event host identity to match its envelope", () => {
    const event = {
      type: "event",
      hostInstanceId: "host-1",
      seq: 1,
      event: { type: "notice", level: "info", message: "same host" },
    } as const;
    expect(
      validateRpcResult("replayEvents", {
        hostInstanceId: "host-1",
        events: [event],
        lastEventSeq: 1,
        truncated: false,
      }),
    ).toBeTrue();
    expect(
      validateRpcResult("replayEvents", {
        hostInstanceId: "host-1",
        events: [
          {
            ...event,
            hostInstanceId: "host-2",
          },
        ],
        lastEventSeq: 1,
        truncated: false,
      }),
    ).toBeFalse();
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
