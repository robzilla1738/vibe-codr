import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TRACE_POLICY_V1, RunEventV1Schema, type RunEventV1 } from "@vibe/protocol";
import type { UIEvent } from "@vibe/shared";
import {
  RunEventRecorder,
  projectRunEventV1,
  recoverRunEventLedger,
  redactTraceValue,
} from "./run-event-recorder.ts";

test("redacted content is immutable, idempotent, secret-aware, and serialization-safe", () => {
  const cyclic: Record<string, unknown> = {
    apiKey: "sk-ABCDEFGHIJ1234567890",
    nested: { authorization: "Bearer secret", keep: "value" },
    bytes: new Uint8Array([1, 2, 3]),
    huge: 12345678901234567890n,
  };
  cyclic.self = cyclic;
  const before = cyclic.nested;
  const once = redactTraceValue(cyclic);
  const twice = redactTraceValue(once);
  expect(twice).toEqual(once);
  expect(cyclic.nested).toBe(before);
  expect(JSON.stringify(once)).not.toContain("ABCDEFGHIJ1234567890");
  expect(JSON.stringify(once)).not.toContain("Bearer secret");
  expect(JSON.stringify(once)).toContain("[Circular]");
  expect(JSON.stringify(once)).toContain("[Binary 3 bytes]");
  expect(() => JSON.stringify(once)).not.toThrow();
});

test("default projection excludes raw content while redacted opt-in uses named slots", () => {
  const sentinel = "SENSITIVE_SENTINEL sk-ABCDEFGHIJ1234567890";
  const event = {
    type: "tool-call-finished",
    sessionId: "session-1",
    toolCallId: "tool-1",
    toolName: "bash",
    output: { stdout: sentinel, password: sentinel },
    isError: false,
  } as UIEvent;
  const base = projectRunEventV1(event, {
    runId: "run-1",
    seq: 1,
    at: 10,
    content: "none",
  });
  expect(JSON.stringify(base)).not.toContain("SENSITIVE_SENTINEL");
  expect(base.content).toBeUndefined();
  const optIn = projectRunEventV1(event, {
    runId: "run-1",
    seq: 1,
    at: 10,
    content: "redacted",
  });
  expect(optIn.content).toBeDefined();
  expect(JSON.stringify(optIn)).not.toContain("ABCDEFGHIJ1234567890");
  expect(JSON.stringify(optIn)).toContain("SENSITIVE_SENTINEL");
});

test("recorder keeps exactly the newest 256 content-free rows and close drains JSONL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vibe-run-events-"));
  let now = 0;
  const recorder = new RunEventRecorder({
    directory,
    policy: { ...DEFAULT_TRACE_POLICY_V1, content: "redacted" },
    runId: "run-tail",
    now: () => ++now,
  });
  for (let index = 0; index < 300; index += 1) {
    recorder.observe({ type: "notice", level: "info", message: `secret-${index}` } as UIEvent);
  }
  expect(recorder.crashTail()).toHaveLength(256);
  expect(recorder.crashTail()[0]?.seq).toBe(45);
  expect(recorder.crashTail().at(-1)?.seq).toBe(300);
  expect(recorder.crashTail().every((event) => event.content === undefined)).toBe(true);
  await recorder.close();
  const files = Array.from(new Bun.Glob("*.jsonl").scanSync(directory));
  expect(files.length).toBeGreaterThan(0);
  const rows = files.flatMap((file) =>
    readFileSync(join(directory, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => RunEventV1Schema.parse(JSON.parse(line)) as RunEventV1),
  );
  expect(rows).toHaveLength(300);
  expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 300 }, (_, index) => index + 1));
  expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
});

test("recovery preserves the schema-valid prefix of a torn segment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vibe-run-recovery-"));
  const path = join(directory, "torn.jsonl");
  const valid = JSON.stringify({
    schemaVersion: 1,
    runId: "run-1",
    seq: 1,
    at: 1,
    type: "notice",
  });
  writeFileSync(path, `${valid}\n{"schemaVersion":1`);
  await recoverRunEventLedger(directory);
  expect(readFileSync(path, "utf8")).toBe(`${valid}\n`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
