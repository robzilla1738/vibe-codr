import { test, expect } from "bun:test";
import type { Task } from "@vibe/shared";
import {
  contextFillPct,
  CTX_WARN_PCT,
  formatDiff,
  formatUsage,
  formatJsonResult,
  isHotContext,
  sessionMetricsTone,
  windowTasks,
} from "./headless.ts";

test("contextFillPct is 0 when unknown; clamps 0–100", () => {
  expect(contextFillPct(null)).toBe(0);
  expect(contextFillPct({ usedTokens: 0, contextWindow: 0 })).toBe(0);
  expect(contextFillPct({ usedTokens: 80_000, contextWindow: 100_000 })).toBe(80);
  expect(contextFillPct({ usedTokens: 200_000, contextWindow: 100_000 })).toBe(100);
});

test("isHotContext warns at CTX_WARN_PCT (80%) — used by footer AND session card", () => {
  expect(CTX_WARN_PCT).toBe(80);
  expect(isHotContext(79)).toBe(false);
  expect(isHotContext(80)).toBe(true);
  expect(isHotContext(100)).toBe(true);
});

test("sessionMetricsTone paints warn on hot ctx (sidebar owns metrics when wide)", () => {
  // Wide terminals drop metrics from the under-input strip — the session card
  // is the only place that shows ctx%, so hot fill must warn there.
  expect(sessionMetricsTone("ctx 42% · 1.5k tok · $0.01")).toEqual({ dim: true, warn: false });
  expect(sessionMetricsTone("ctx 80% · 1.5k tok · $0.01")).toEqual({ dim: false, warn: true });
  expect(sessionMetricsTone("ctx 95% · 12.3k tok")).toEqual({ dim: false, warn: true });
  expect(sessionMetricsTone("1.5k tok · $0.01")).toEqual({ dim: true, warn: false });
});

test("formatDiff prefixes additions, deletions, and context distinctly", () => {
  // ansi colors are disabled when stdout is not a TTY (test env), so the
  // output is the plain text — we assert the structure survives.
  const out = formatDiff(" a\n-b\n+B\n…");
  const lines = out.split("\n");
  expect(lines[1]).toContain("-b");
  expect(lines[2]).toContain("+B");
  expect(lines[3]).toContain("…");
});

test("formatDiff returns empty string for an empty diff", () => {
  expect(formatDiff("")).toBe("");
});

test("formatUsage always shows cost: $0.00 for free, $ for real, ~$ for estimates", () => {
  // Free/local model → an explicit $0.00 rather than a hidden cost.
  expect(formatUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0 })).toBe(
    "15 tok · $0.00",
  );
  // Real price.
  expect(
    formatUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 1500, costUSD: 0.042 }),
  ).toContain("$0.0420");
  // Estimated price (base-model fallback) → ~$ prefix.
  expect(
    formatUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 1500,
      costUSD: 0.042,
      costEstimated: true,
    }),
  ).toContain("~$0.0420");
});

test("formatUsage renders cached tokens compactly (k-suffix), matching the total", () => {
  const s = formatUsage({
    inputTokens: 5000,
    outputTokens: 100,
    totalTokens: 5100,
    costUSD: 0.03,
    cachedInputTokens: 1100,
  });
  // Both the total and the cached count use the compact `k` form — not `1100`.
  expect(s).toContain("5.1k tok");
  expect(s).toContain("1.1k cached");
  expect(s).not.toContain("1100 cached");
});

test("formatJsonResult emits a parseable result with the expected fields", () => {
  const json = formatJsonResult({
    sessionId: "ses_1",
    model: "anthropic/claude-opus-4-8",
    mode: "execute",
    text: "done",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01 },
  });
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed.sessionId).toBe("ses_1");
  expect(parsed.model).toBe("anthropic/claude-opus-4-8");
  expect(parsed.text).toBe("done");
  expect((parsed.usage as { totalTokens: number }).totalTokens).toBe(15);
  expect(parsed.error).toBeUndefined();
});

test("windowTasks collapses leading completed tasks so the ACTIVE task stays visible", () => {
  const t = (i: number, status: "completed" | "in_progress" | "pending") =>
    ({ title: `task ${i}`, status }) as Task;
  const many = [
    ...Array.from({ length: 12 }, (_, i) => t(i, "completed")),
    t(12, "in_progress"),
    ...Array.from({ length: 5 }, (_, i) => t(13 + i, "pending")),
  ];
  const w = windowTasks(many, 8);
  // The window BACKFILLS to stay full (8 rows): 10 completed collapse into the
  // lead count, two ride in the window above the active task — which is ON
  // SCREEN, the whole point.
  expect(w.lead).toBe(10);
  expect(w.visible).toHaveLength(8);
  expect(w.visible.some((x) => x.status === "in_progress")).toBe(true);
  expect(w.trailing).toBe(0);
  // No overflow → untouched.
  const few = windowTasks(many.slice(0, 5), 8);
  expect(few).toEqual({ lead: 0, visible: many.slice(0, 5), trailing: 0 });
  // All completed and overflowing → show the last `max`, count the rest as lead.
  const done = Array.from({ length: 10 }, (_, i) => t(i, "completed"));
  const dw = windowTasks(done, 8);
  expect(dw.lead).toBe(2);
  expect(dw.visible).toHaveLength(8);
  expect(dw.trailing).toBe(0);
});
