import { expect, test } from "bun:test";
import {
  DEFAULT_TRACE_POLICY_V1,
  RUN_EVENT_V1_LIMITS,
  RunEventV1Schema,
  TraceListResultV1Schema,
  TracePageV1Schema,
  TraceRunIdV1Schema,
  TracePolicyV1Schema,
  contentFreeRunEventV1,
} from "./run-event.ts";

test("TracePolicyV1 fixes every retention and durability bound", () => {
  expect(TracePolicyV1Schema.parse(DEFAULT_TRACE_POLICY_V1)).toEqual({
    schemaVersion: 1,
    enabled: true,
    content: "none",
    retentionDays: 7,
    maxBytes: 50 * 1024 * 1024,
    segmentBytes: 1024 * 1024,
    crashTailEvents: 256,
  });
  expect(
    TracePolicyV1Schema.safeParse({ ...DEFAULT_TRACE_POLICY_V1, retentionDays: 30 }).success,
  ).toBe(false);
  expect(
    TracePolicyV1Schema.safeParse({ ...DEFAULT_TRACE_POLICY_V1, rawContent: true }).success,
  ).toBe(false);
});

test("trace inspection contracts bound ids, lists, pages, and traversal", () => {
  expect(TraceRunIdV1Schema.safeParse("run-123.segment").success).toBe(true);
  for (const unsafe of ["../run", "run/segment", "run\\segment", ".", "", "x".repeat(257)]) {
    expect(TraceRunIdV1Schema.safeParse(unsafe).success).toBe(false);
  }
  const summary = {
    schemaVersion: 1 as const,
    runId: "run-1",
    startedAt: 1,
    updatedAt: 2,
    firstSeq: 1,
    lastSeq: 2,
    eventCount: 2,
    segmentCount: 1,
    hasRedactedContent: false,
    corruptionCount: 0,
  };
  expect(TraceListResultV1Schema.parse({ schemaVersion: 1, traces: [summary], truncated: false }))
    .toMatchObject({ traces: [{ runId: "run-1" }] });
  expect(TracePageV1Schema.parse({
    schemaVersion: 1,
    runId: "run-1",
    events: [],
    corruptions: [],
    lastSeq: 2,
    nextAfterSeq: null,
    truncated: false,
    hasRedactedContent: false,
  }).runId).toBe("run-1");
});

test("RunEventV1 is strict and content-free conversion removes the only content slot", () => {
  const event = RunEventV1Schema.parse({
    schemaVersion: 1,
    runId: "run-1",
    seq: 1,
    at: 1,
    type: "notice",
    level: "warn",
    content: { message: "bounded" },
  });
  expect(contentFreeRunEventV1(event)).toEqual({
    schemaVersion: 1,
    runId: "run-1",
    seq: 1,
    at: 1,
    type: "notice",
    level: "warn",
  });
  expect(RunEventV1Schema.safeParse({ ...event, arbitrary: "no" }).success).toBe(false);
  expect(
    RunEventV1Schema.safeParse({
      ...event,
      content: { arbitrary: "no" },
    }).success,
  ).toBe(false);
  expect(RUN_EVENT_V1_LIMITS.crashTailEvents).toBe(256);
});
