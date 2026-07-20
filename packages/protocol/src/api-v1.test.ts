import { describe, expect, test } from "bun:test";
import {
  ApiV1CommandRequestSchema,
  ApiV1DecisionRequestSchema,
  ApiV1SseFrameSchema,
  decodeApiV1Cursor,
  encodeApiV1Cursor,
} from "./api-v1.ts";

describe("API v1 protocol", () => {
  test("cursor round-trips with a server epoch", () => {
    const cursor = { epoch: "epoch-1", sequence: 42 };
    expect(decodeApiV1Cursor(encodeApiV1Cursor(cursor))).toEqual(cursor);
    expect(decodeApiV1Cursor("epoch:nope")).toBeUndefined();
    expect(decodeApiV1Cursor("epoch:-1")).toBeUndefined();
  });

  test("requests are exact and reject unsupported engine commands", () => {
    expect(ApiV1CommandRequestSchema.safeParse({ command: { type: "abort" } }).success).toBe(true);
    expect(ApiV1CommandRequestSchema.safeParse({ command: { type: "shutdown" } }).success).toBe(
      false,
    );
    expect(
      ApiV1CommandRequestSchema.safeParse({ command: { type: "request-runtime-handoff" } }).success,
    ).toBe(false);
    expect(
      ApiV1CommandRequestSchema.safeParse({ command: { type: "abort" }, extra: true }).success,
    ).toBe(false);
  });

  test("decision and SSE shapes are runtime validated", () => {
    expect(
      ApiV1DecisionRequestSchema.safeParse({
        idempotencyKey: "key-1",
        decision: { kind: "permission", id: "permission-1", decision: "once" },
      }).success,
    ).toBe(true);
    expect(
      ApiV1DecisionRequestSchema.safeParse({
        idempotencyKey: "key-1",
        decision: { kind: "permission", id: "permission-1", decision: "invented" },
      }).success,
    ).toBe(false);
    expect(
      ApiV1SseFrameSchema.safeParse({
        type: "event",
        cursor: { epoch: "epoch-1", sequence: 1 },
        event: { type: "notice", level: "info", message: "ready" },
      }).success,
    ).toBe(true);
    expect(
      ApiV1SseFrameSchema.safeParse({
        type: "event",
        cursor: { epoch: "epoch-1", sequence: 1 },
        event: { type: "made-up" },
      }).success,
    ).toBe(false);
  });
});
