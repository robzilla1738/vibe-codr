import { expect, test } from "bun:test";
import {
  DEFAULT_TRACE_POLICY_V1,
  RUN_EVENT_V1_LIMITS,
  RunEventV1Schema,
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
