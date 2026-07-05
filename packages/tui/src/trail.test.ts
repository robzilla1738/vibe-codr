import { test, expect } from "bun:test";
import { Trail, turnWindowStart, windowStartIndex } from "./trail.ts";

/** The OLD full-rebuild trail (what pushReasoning did per token before the
 * incremental Trail): re-split the whole buffer, trim, collapse blank runs,
 * drop the trailing spacer. The incremental version must match it exactly. */
function fullRebuild(buf: string): string[] {
  const out: string[] = [];
  for (const raw of buf.split("\n")) {
    const l = raw.trim();
    if (l) out.push(l);
    else if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

test("incremental append equals the full rebuild for arbitrary delta splits", () => {
  const text =
    "The user wants a comparison.\nI need current prices.\n\n\nPlan: fetch BTC first,\nthen SOL.\n\nGot BTC at $62,166. " +
    "Need Solana current price.\n  \nLet me fetch.\nfinal partial line without newline";
  // Slice the same text into deltas of varying sizes — token boundaries land
  // mid-word, mid-line, and ON newlines; every split must converge.
  for (const size of [1, 2, 3, 7, 16, 64, text.length]) {
    const t = new Trail();
    for (let i = 0; i < text.length; i += size) t.append(text.slice(i, i + size));
    expect(t.snapshot()).toEqual(fullRebuild(text));
  }
});

test("activity lines interleave chronologically and close a streaming line", () => {
  const t = new Trail();
  t.append("thinking about the fetch");
  t.pushLine('◈ search "World Cup"');
  t.append("got results\n");
  expect(t.snapshot()).toEqual(["thinking about the fetch", '◈ search "World Cup"', "got results"]);
});

test("consecutive activity lines are single-spaced (non-reasoning model)", () => {
  const t = new Trail();
  t.pushLine("→ read a.ts");
  t.pushLine("→ edit a.ts");
  t.pushLine("$ bun test");
  expect(t.snapshot()).toEqual(["→ read a.ts", "→ edit a.ts", "$ bun test"]);
});

test("a reasoning paragraph still gets its break before the next activity line", () => {
  const t = new Trail();
  t.append("thought about it\n");
  t.pushLine("→ read a.ts");
  t.pushLine("→ edit a.ts");
  t.append("more thinking\n");
  // The streamed newline's paragraph break survives; activity lines stay tight.
  expect(t.snapshot()).toEqual(["thought about it", "", "→ read a.ts", "→ edit a.ts", "more thinking"]);
});

test("the trail is capped at maxLines, keeping the tail", () => {
  const t = new Trail(8);
  for (let i = 0; i < 50; i++) t.append(`line ${i}\n`);
  const snap = t.snapshot();
  expect(snap.length).toBe(8);
  expect(snap[snap.length - 1]).toBe("line 49");
});

test("reset empties the trail including the open line", () => {
  const t = new Trail();
  t.append("half a line");
  t.reset();
  expect(t.snapshot()).toEqual([]);
});

test("windowStartIndex keeps the newest turns and never goes negative", () => {
  expect(windowStartIndex(0, 40, 0)).toBe(0);
  expect(windowStartIndex(40, 40, 0)).toBe(0);
  expect(windowStartIndex(41, 40, 0)).toBe(1);
  expect(windowStartIndex(120, 40, 0)).toBe(80);
  // Revealing pages the window upward, clamped at the top of history.
  expect(windowStartIndex(120, 40, 20)).toBe(60);
  expect(windowStartIndex(120, 40, 999)).toBe(0);
});

test("a 5k-block-scale transcript renders at most the window", () => {
  // 120 turns' worth of totals — the render slice is bounded by WINDOW+reveal
  // regardless of how many blocks each turn holds.
  const total = 120;
  const start = windowStartIndex(total, 40, 0);
  expect(total - start).toBe(40);
});

test("turnWindowStart: 0 under the cap, quantized + monotonic above it, visible bounded", () => {
  const MAX = 120;
  const STEP = 24;
  // At or under the cap → no windowing.
  expect(turnWindowStart(0, MAX, STEP)).toBe(0);
  expect(turnWindowStart(120, MAX, STEP)).toBe(0);
  // Just over the cap: the start jumps one step and stays there for a whole band.
  for (let n = 121; n <= 144; n++) expect(turnWindowStart(n, MAX, STEP)).toBe(24);
  for (let n = 145; n <= 168; n++) expect(turnWindowStart(n, MAX, STEP)).toBe(48);
  // Monotonic non-decreasing, and the visible count never exceeds max (≤ max+step).
  let prev = 0;
  for (let n = 0; n <= 1000; n++) {
    const start = turnWindowStart(n, MAX, STEP);
    expect(start).toBeGreaterThanOrEqual(prev);
    expect(n - start).toBeLessThanOrEqual(MAX + STEP);
    prev = start;
  }
});
