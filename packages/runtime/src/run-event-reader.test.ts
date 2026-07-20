import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventV1Schema } from "@vibe/protocol";
import { redactTraceValue } from "./run-event-recorder.ts";
import { listRunTraces, readRunTrace, renderRunTraceHtml } from "./run-event-reader.ts";

function row(runId: string, seq: number, content?: unknown) {
  return RunEventV1Schema.parse({
    schemaVersion: 1,
    runId,
    seq,
    at: 1_700_000_000_000 + seq,
    type: "notice",
    level: "info",
    ...(content === undefined ? {} : { content: { message: content } }),
  });
}

function writeRows(dir: string, file: string, rows: unknown[], tail = "") {
  writeFileSync(join(dir, file), `${rows.map((value) => JSON.stringify(value)).join("\n")}\n${tail}`);
}

test("lists grouped segments, repairs torn tails, pages, and strips content by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-trace-reader-"));
  writeRows(dir, "run-a-000001.jsonl", [row("run-a", 1, "private"), row("run-a", 2)], '{"torn"');
  writeRows(dir, "run-a-000002.jsonl", [row("run-a", 3)]);
  writeRows(dir, "run-b-000001.jsonl", [row("run-b", 1)]);
  writeFileSync(join(dir, "../not-a-segment"), "");

  const listed = await listRunTraces(dir, { limit: 1 });
  expect(listed.traces).toHaveLength(1);
  expect(listed.truncated).toBe(true);
  expect(readFileSync(join(dir, "run-a-000001.jsonl"), "utf8")).not.toContain("torn");

  const page = await readRunTrace(dir, "run-a", { limit: 2 });
  expect(page.events.map((event) => event.seq)).toEqual([1, 2]);
  expect(page.events[0]?.content).toBeUndefined();
  expect(page.nextAfterSeq).toBe(2);
  const final = await readRunTrace(dir, "run-a", { afterSeq: page.nextAfterSeq!, includeRedacted: true });
  expect(final.events.map((event) => event.seq)).toEqual([3]);
});

test("reports non-monotonic rows without sorting or hiding the duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-trace-corrupt-"));
  writeRows(dir, "run-dup-000001.jsonl", [row("run-dup", 1), row("run-dup", 1), row("run-dup", 2)]);
  const page = await readRunTrace(dir, "run-dup");
  expect(page.events.map((event) => event.seq)).toEqual([1]);
  expect(page.corruptions[0]).toMatchObject({ reason: "non-monotonic-sequence", line: 2 });
});

test("static HTML escapes content and default export cannot contain recorded paths or scripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-trace-html-"));
  const sentinel = '</script><img src=x onerror="alert(1)"> /Users/private/project';
  writeRows(dir, "run-html-000001.jsonl", [row("run-html", 1, sentinel)]);
  const safe = await renderRunTraceHtml(dir, "run-html");
  expect(safe).not.toContain("/Users/private/project");
  expect(safe).not.toContain("<script");
  expect(safe).not.toContain("<img");
  expect(safe).not.toContain("http://");
  expect(safe).not.toContain("https://");
  const optedIn = await renderRunTraceHtml(dir, "run-html", { includeRedacted: true });
  expect(optedIn).toContain("&lt;/script&gt;&lt;img");
  expect(optedIn).not.toContain("<script");
});

test("deterministic randomized redaction handles paths, secrets, binary, cycles, and bounds", () => {
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let index = 0; index < 64; index += 1) {
    const secret = `sk-${next().toString(36)}ABCDEFGHIJK`;
    const value: Record<string, unknown> = {
      path: `/Users/private/${next().toString(36)}/file.ts`,
      authorization: `Bearer ${secret}`,
      [`apiKey${index}`]: secret,
      bytes: new Uint8Array([index, index + 1]),
      oversized: Array.from({ length: 80 }, (_, item) => ({ item, password: secret })),
      nested: { a: { b: { c: { d: { e: { f: { g: secret } } } } } } },
    };
    value.self = value;
    const serialized = JSON.stringify(redactTraceValue(value));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).toContain("[Binary 2 bytes]");
    expect(serialized).toContain("[Circular]");
    expect(serialized.length).toBeLessThan(20_000);
  }
});
