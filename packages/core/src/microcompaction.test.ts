import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  classifyToolResults,
  planOffloads,
  applyOffloads,
  pruneArtifacts,
  resultText,
  type OffloadRecord,
} from "./microcompaction.ts";

const call = (id: string, toolName: string, input: unknown): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const result = (id: string, toolName: string, text: string): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: text } }],
});

const BIG = "x".repeat(20_000);

test("classifyToolResults correlates results with their originating call inputs", () => {
  const messages = [
    { role: "user", content: "go" } as ModelMessage,
    call("c1", "read", { path: "src/a.ts" }),
    result("c1", "read", BIG),
  ];
  const refs = classifyToolResults(messages);
  expect(refs).toHaveLength(1);
  expect(refs[0]?.toolName).toBe("read");
  expect((refs[0]?.input as { path: string }).path).toBe("src/a.ts");
  expect(refs[0]?.chars).toBe(20_000);
});

test("planOffloads prefers superseded reads, then oldest; respects keepLiveResults", () => {
  const messages = [
    call("old-read", "read", { path: "src/a.ts" }),
    result("old-read", "read", BIG),
    call("other", "grep", { pattern: "x" }),
    result("other", "grep", BIG),
    call("edit-a", "edit", { path: "src/a.ts", oldString: "x", newString: "y" }),
    result("edit-a", "edit", "Edited src/a.ts"),
    call("fresh", "read", { path: "src/b.ts" }),
    result("fresh", "read", BIG),
  ];
  const picked = planOffloads(messages, {
    maxResultBytes: 16_000,
    keepLiveResults: 1, // protects the trailing fresh read
    targetChars: 25_000,
    existing: new Set(),
  });
  // The superseded read of src/a.ts (later edited) goes first, then the oldest
  // remaining bulky result (the grep); the fresh read is protected.
  expect(picked.map((p) => p.callId)).toEqual(["old-read", "other"]);
});

test("planOffloads skips already-offloaded ids and stops at the target", () => {
  const messages = [
    call("a", "read", { path: "a" }),
    result("a", "read", BIG),
    call("b", "read", { path: "b" }),
    result("b", "read", BIG),
    call("c", "read", { path: "c" }),
    result("c", "read", "tiny"),
  ];
  const picked = planOffloads(messages, {
    maxResultBytes: 16_000,
    keepLiveResults: 0,
    targetChars: 1, // one victim suffices
    existing: new Set(["a"]),
  });
  expect(picked.map((p) => p.callId)).toEqual(["b"]);
});

test("applyOffloads replaces only offloaded results, keeps other messages by reference", () => {
  const user: ModelMessage = { role: "user", content: "go" };
  const kept = result("keep", "read", BIG);
  const victim = result("gone", "read", BIG);
  const messages = [user, call("keep", "read", { path: "k" }), kept, call("gone", "read", { path: "g" }), victim];
  const offloaded = new Map<string, OffloadRecord>([
    ["gone", { path: ".vibe/sessions/s/tool-results/gone.txt", toolName: "read", fullChars: 20_000 }],
  ]);
  const next = applyOffloads(messages, offloaded, 2_000);
  // Identity preserved for untouched messages (the rollback check depends on it).
  expect(next[0]).toBe(user);
  expect(next[2]).toBe(kept);
  // The victim's output is now a preview + retrieval note.
  const text = resultText(
    (next[4] as { content: { output: { type: string; value: string } }[] }).content[0]!.output,
  );
  expect(text).toContain("saved to");
  expect(text).toContain(".vibe/sessions/s/tool-results/gone.txt");
  expect(text.length).toBeLessThan(2_600);
  // Idempotent: applying again changes nothing further (already a small preview).
  const again = applyOffloads(next, offloaded, 2_000);
  expect(resultText((again[4] as typeof next[4] as never as { content: { output: never }[] }).content[0]!.output)).toBe(text);
});

test("resultText handles text, json, and content-array outputs", () => {
  expect(resultText({ type: "text", value: "plain" })).toBe("plain");
  expect(resultText({ type: "json", value: { a: 1 } })).toBe('{"a":1}');
  expect(resultText({ type: "content", value: [{ type: "text", text: "x" }, { type: "text", text: "y" }] })).toBe(
    "x\ny",
  );
});

test("planOffloads canonicalizes paths so an abs read is superseded by a relative edit of the same file", () => {
  const messages = [
    call("abs-read", "read", { path: "/repo/src/a.ts" }),
    result("abs-read", "read", BIG),
    call("rel-edit", "edit", { path: "src/a.ts", oldString: "x", newString: "y" }),
    result("rel-edit", "edit", "Edited"),
    call("keep", "read", { path: "src/b.ts" }),
    result("keep", "read", BIG),
  ];
  const canonicalize = (p: string) => (p.startsWith("/") ? p : `/repo/${p}`);
  // Without canonicalize the abs read is NOT seen as superseded (different string).
  const naive = planOffloads(messages, { maxResultBytes: 16_000, keepLiveResults: 1, targetChars: 1, existing: new Set() });
  expect(naive.find((r) => r.callId === "abs-read")?.callId).toBe("abs-read"); // picked as oldest, not as superseded
  // With canonicalize, the abs read is recognized as superseded by the relative
  // edit and prioritized as the first victim.
  const canon = planOffloads(messages, {
    maxResultBytes: 16_000,
    keepLiveResults: 1,
    targetChars: 1,
    existing: new Set(),
    canonicalize,
  });
  expect(canon[0]?.callId).toBe("abs-read");
});

test("applyOffloads preview never splits a surrogate pair at the cut", () => {
  // An emoji (surrogate pair) straddling the preview boundary must not leave a
  // lone surrogate in the output (some providers 400 on invalid UTF-16).
  const body = `${"a".repeat(9)}😀${"b".repeat(20_000)}`; // 😀 spans positions 9–10
  const messages = [call("c", "read", { path: "f" }), result("c", "read", body)];
  const offloaded = new Map<string, OffloadRecord>([
    ["c", { path: ".vibe/x.txt", toolName: "read", fullChars: body.length }],
  ]);
  const next = applyOffloads(messages, offloaded, 10); // cut lands mid-emoji
  const text = resultText((next[1] as { content: { output: { value: string } }[] }).content[0]!.output);
  // No unpaired surrogate anywhere in the preview.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) expect(text.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
    if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = text.charCodeAt(i - 1);
      expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
    }
  }
});

test("planOffloads credits only the NET reduction (result minus retained preview)", () => {
  // Two 20k-char victims; target 30k. Whole-result credit stops after one (20k
  // >= 30k is false, so it'd pick two anyway) — pick a target where the preview
  // subtraction changes the count: target 19k, preview 5k.
  const messages: ModelMessage[] = [
    call("a", "read", { path: "a.ts" }),
    result("a", "read", "x".repeat(20_000)),
    call("b", "grep", { pattern: "y" }),
    result("b", "grep", "y".repeat(20_000)),
  ];
  // With preview subtracted: net per victim = 20k - 5k = 15k < 19k target, so it
  // must pick BOTH. Whole-result credit (20k >= 19k) would stop after ONE.
  const withPreview = planOffloads(messages, {
    maxResultBytes: 1_000,
    keepLiveResults: 0,
    targetChars: 19_000,
    existing: new Set(),
    previewChars: 5_000,
  });
  expect(withPreview).toHaveLength(2);
  // Whole-result credit (no preview subtraction) stops after one.
  const wholeCredit = planOffloads(messages, {
    maxResultBytes: 1_000,
    keepLiveResults: 0,
    targetChars: 19_000,
    existing: new Set(),
  });
  expect(wholeCredit).toHaveLength(1);
});

test("pruneArtifacts evicts oldest-first over the cap, never the live working set", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-artifacts-"));
  const write = (name: string, bytes: number, ageSecAgo: number) => {
    const p = join(dir, name);
    writeFileSync(p, "x".repeat(bytes));
    const t = Date.now() / 1000 - ageSecAgo;
    utimesSync(p, t, t);
    return p;
  };
  const oldLive = write("a.txt", 1000, 300); // oldest, but LIVE → must survive
  const oldDead = write("b.txt", 1000, 200); // old + dead → first to go
  const midDead = write("c.txt", 1000, 100); // dead → next
  const newDead = write("d.txt", 1000, 10); // newest dead → kept if possible

  // Cap 2500: total 4000 → must evict 1500+ worth of DEAD files, oldest first.
  const removed = pruneArtifacts(dir, 2500, new Set([oldLive]));
  expect(removed).toBe(2); // b then c
  expect(existsSync(oldLive)).toBe(true); // live never evicted
  expect(existsSync(oldDead)).toBe(false);
  expect(existsSync(midDead)).toBe(false);
  expect(existsSync(newDead)).toBe(true); // newest dead kept, under cap now

  // Under cap → no-op.
  expect(pruneArtifacts(dir, 10_000, new Set())).toBe(0);
  // Disabled (cap 0) → no-op.
  expect(pruneArtifacts(dir, 0, new Set())).toBe(0);
});
