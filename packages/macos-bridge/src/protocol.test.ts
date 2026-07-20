import { describe, expect, test } from "bun:test";
import {
  ENGINE_COMMAND_SCHEMAS,
  UI_EVENT_SCHEMAS,
  decodeInbound,
  decodeOutbound,
} from "@vibe/protocol/host-v2";
import { listedEngineCommandTypes, listedUIEventTypes } from "./protocol.ts";

const readyFrame = <T>(sessionId: T) => ({
  type: "ready" as const,
  protocolVersion: 2,
  engineRevision: "test",
  capabilities: ["event-replay"],
  hostInstanceId: "host-test",
  sessionId,
});

const eventFrame = (event: unknown) => ({
  type: "event",
  hostInstanceId: "host-test",
  seq: 1,
  event,
});

describe("macOS bridge protocol runtime validation", () => {
  test("accepts valid commands and rejects malformed inbound shapes", () => {
    expect(
      decodeInbound(JSON.stringify({ op: "bootstrap", cwd: "/tmp/project", mode: "plan" })),
    ).toMatchObject({ op: "bootstrap", cwd: "/tmp/project" });
    expect(
      decodeInbound(
        JSON.stringify({
          op: "bootstrap",
          cwd: "/tmp/project",
          resume: "ses_cloud",
          executionTarget: { kind: "cloud", provider: "e2b" },
        }),
      ),
    ).toMatchObject({ executionTarget: { kind: "cloud", provider: "e2b" } });
    expect(
      decodeInbound(
        JSON.stringify({
          op: "bootstrap",
          cwd: "/tmp/project",
          requiredModels: ["crof/glm-5.2"],
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "bootstrap",
          cwd: "/tmp/project",
          requiredModels: ["glm-5.2"],
        }),
      ),
    ).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "bootstrap",
          cwd: "/tmp/project",
          runtimeProfile: {
            schemaVersion: 1,
            theme: "light",
            accentColor: "#e6e6e6",
            details: "normal",
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "bootstrap",
          cwd: "/tmp/project",
          executionTarget: { kind: "cloud", provider: "unknown" },
        }),
      ),
    ).toBeNull();
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 1, method: "snapshot" }))).toEqual({
      op: "rpc",
      id: 1,
      method: "snapshot",
    });
    expect(decodeInbound(JSON.stringify({ op: "rpc", id: 4, method: "listPluginStatus" }))).toEqual(
      {
        op: "rpc",
        id: 4,
        method: "listPluginStatus",
      },
    );
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 2,
          method: "beginProviderAuth",
          params: { providerId: "xai-oauth", authMethod: "device" },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "rpc",
          id: 3,
          method: "beginProviderAuth",
          params: { providerId: "unknown", authMethod: "device" },
        }),
      ),
    ).toBeNull();
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

  test("validates question and activity commands field by field", () => {
    expect(
      decodeInbound(
        JSON.stringify({
          op: "send",
          command: {
            type: "resolve-question",
            id: "question-1",
            answers: ["Safe"],
            freeform: "note",
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "send",
          command: { type: "cancel-activity", id: "activity-1" },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "send",
          command: { type: "resolve-question", id: "question-1", answers: [7] },
        }),
      ),
    ).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "send",
          command: { type: "resolve-question", id: "", answers: [] },
        }),
      ),
    ).toBeNull();
    expect(
      decodeInbound(
        JSON.stringify({
          op: "send",
          command: { type: "cancel-activity", id: 7 },
        }),
      ),
    ).toBeNull();
  });

  test("accepts valid host messages and rejects malformed events and responses", () => {
    expect(JSON.stringify(decodeOutbound(JSON.stringify(readyFrame("ses_1"))))).toBe(
      JSON.stringify(readyFrame("ses_1")),
    );
    expect(
      decodeOutbound(JSON.stringify(eventFrame({ type: "notice", level: "info", message: "ok" }))),
    ).not.toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify(
          eventFrame({
            type: "usage-updated",
            sessionId: "ses_1",
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
              byModel: {
                "test/model": {
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
                },
              },
            },
          }),
        ),
      ),
    ).not.toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify(
          eventFrame({
            type: "user-message",
            sessionId: "ses_1",
            text: "Continue",
            origin: "engine",
            label: "Goal",
          }),
        ),
      ),
    ).not.toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify(
          eventFrame({
            type: "user-message",
            sessionId: "ses_1",
            text: "Continue",
            origin: "other",
          }),
        ),
      ),
    ).toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify(
          eventFrame({
            type: "user-message",
            sessionId: "ses_1",
            text: "Continue",
            label: { text: "Goal" },
          }),
        ),
      ),
    ).toBeNull();
    expect(
      decodeOutbound(JSON.stringify(eventFrame({ type: "notice", level: "info" }))),
    ).toBeNull();
    expect(
      decodeOutbound(
        JSON.stringify(eventFrame({ type: "tasks-updated", sessionId: "s", tasks: null })),
      ),
    ).toBeNull();
    expect(decodeOutbound(JSON.stringify({ type: "resp", id: 1, ok: false }))).toBeNull();
  });

  test("validates plan, question, and activity events field by field", () => {
    const events = [
      {
        type: "plan-state-changed",
        sessionId: "ses_1",
        state: {
          status: "pending",
          plan: "Ship it",
          sources: [{ url: "https://example.com", title: "Example" }],
          assumptions: ["Tests pass"],
          ungrounded: false,
          updatedAt: 1,
        },
      },
      {
        type: "question-request",
        sessionId: "ses_1",
        question: {
          id: "question-1",
          question: "Proceed?",
          header: "Decision",
          choices: [{ label: "Yes", description: "Continue" }],
          multiple: false,
          allowFreeform: true,
          createdAt: 1,
        },
      },
      { type: "question-settled", sessionId: "ses_1", id: "question-1", reason: "answered" },
      {
        type: "activities-changed",
        sessionId: "ses_1",
        activities: [
          {
            id: "activity-1",
            kind: "shell",
            label: "Tests",
            status: "running",
            startedAt: 1,
            metrics: { toolCalls: 2 },
          },
        ],
      },
    ];
    for (const event of events) {
      expect(decodeOutbound(JSON.stringify(eventFrame(event)))).not.toBeNull();
    }
    for (const sessionId of ["", "bad\0id", "x".repeat(1_025)]) {
      for (const event of events) {
        expect(decodeOutbound(JSON.stringify(eventFrame({ ...event, sessionId })))).toBeNull();
      }
    }

    const malformed = [
      {
        type: "plan-state-changed",
        sessionId: "ses_1",
        state: { status: "pending", updatedAt: "now" },
      },
      {
        type: "question-request",
        sessionId: "ses_1",
        question: {
          id: "question-1",
          question: "Proceed?",
          choices: ["yes"],
          multiple: false,
          allowFreeform: false,
          createdAt: 1,
        },
      },
      { type: "question-settled", sessionId: "ses_1", id: "question-1", reason: "unknown" },
      {
        type: "activities-changed",
        sessionId: "ses_1",
        activities: [
          {
            id: "activity-1",
            kind: "shell",
            label: "Tests",
            status: "running",
            metrics: { errors: -1 },
          },
        ],
      },
      { type: "activities-changed", activities: [] },
    ];
    for (const event of malformed) {
      expect(decodeOutbound(JSON.stringify(eventFrame(event)))).toBeNull();
    }
  });

  test("lists every current command and event discriminator once", () => {
    const commands = listedEngineCommandTypes();
    const events = listedUIEventTypes();
    expect(commands).toContain("resolve-question");
    expect(commands).toContain("cancel-activity");
    expect(events).toContain("plan-state-changed");
    expect(events).toContain("question-request");
    expect(events).toContain("question-settled");
    expect(events).toContain("activities-changed");
    expect(new Set(commands).size).toBe(commands.length);
    expect(new Set(events).size).toBe(events.length);
  });

  test("requires an explicit schema for every registered discriminator", () => {
    expect(Object.keys(ENGINE_COMMAND_SCHEMAS).sort()).toEqual(
      [...listedEngineCommandTypes()].sort(),
    );
    expect(Object.keys(UI_EVENT_SCHEMAS).sort()).toEqual([...listedUIEventTypes()].sort());
  });
});
