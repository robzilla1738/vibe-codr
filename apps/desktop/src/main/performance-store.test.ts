import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerformanceStore, percentiles } from "./performance-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PerformanceStore", () => {
  it("persists only content-free fields and prunes expired records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-performance-"));
    roots.push(root);
    const directory = join(root, "performance");
    const path = join(directory, "turns.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ recordedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000, kind: "turn" })}\n`,
    );
    const store = new PerformanceStore(root);
    const now = Date.now();
    store.observeEngineEvent({ type: "user-message", sessionId: "ses-a", turnId: "turn-a", text: "secret prompt" });
    store.observeEngineEvent({ type: "assistant-text-delta", sessionId: "ses-a", delta: "secret output" });
    store.observeEngineEvent({
      type: "turn-performance",
      sessionId: "ses-a",
      sample: {
        turnId: "turn-a",
        sessionId: "ses-a",
        model: "xai/grok-4.5",
        serviceTier: "default",
        startedAt: now - 25,
        queueDelayMs: 1,
        hooksMs: 1,
        checkpointMs: 2,
        recallMs: 1,
        attachmentsMs: 1,
        modelResolveMs: 1,
        contextPrepareMs: 2,
        providerTtftMs: 4,
        firstVisibleTextMs: 5,
        generationMs: 10,
        toolMs: 0,
        toolSchemaTokens: 2_400,
        persistMs: 1,
        postTurnMs: 1,
        totalMs: 24,
        inputTokens: 10,
        outputTokens: 3,
        prompt: "must never persist",
      },
    });
    store.recordFirstPaint({ turnId: "turn-a", sessionId: "ses-a", paintedAt: Date.now() });
    await store.flush();

    const contents = await readFile(path, "utf8");
    const records = contents.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(contents).not.toContain("secret");
    expect(contents).not.toContain("must never persist");
    expect(records[0].sample).toMatchObject({ turnId: "turn-a", model: "xai/grok-4.5" });
    expect(records[1]).toMatchObject({ kind: "paint", turnId: "turn-a" });
  });

  it("summarizes phases accurately and tolerates malformed records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-performance-"));
    roots.push(root);
    const directory = join(root, "performance");
    const path = join(directory, "turns.jsonl");
    const now = 1_800_000_000_000;
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${[
      "not-json",
      JSON.stringify({ recordedAt: now - 1_000, kind: "phase", phase: "host-spawn", durationMs: 10, transport: "local" }),
      JSON.stringify({ recordedAt: now - 900, kind: "phase", phase: "host-spawn", durationMs: 30, transport: "local" }),
      JSON.stringify({
        recordedAt: now - 800,
        kind: "turn",
        bridgeDelayMs: 12,
        sample: {
          turnId: "turn-1", sessionId: "session-1", model: "model", serviceTier: "default",
          startedAt: now - 2_000, queueDelayMs: 0, hooksMs: 0, checkpointMs: 0,
          recallMs: 0, attachmentsMs: 0, modelResolveMs: 0, contextPrepareMs: 0,
          providerTtftMs: 100, generationMs: 400, toolMs: 40, toolSchemaTokens: 1_000,
          persistMs: 0, postTurnMs: 0, totalMs: 500,
        },
      }),
      JSON.stringify({ recordedAt: now - 700, kind: "paint", turnId: "turn-1", sessionId: "session-1", bridgeToPaintMs: 16 }),
    ].join("\n")}\n`);
    const store = new PerformanceStore(root, { now: () => now });
    const summary = await store.getPerformanceSummary({ days: 1 });
    expect(summary.turnCount).toBe(1);
    expect(summary.phases["host-spawn"]).toEqual({ count: 2, p50: 20, p95: 29 });
    expect(summary.phases["provider-ttft"]?.p95).toBe(100);
    expect(summary.phases["first-paint"]?.p50).toBe(16);
    expect(summary.toolSchemaTokens?.p50).toBe(1_000);
    expect(summary.dominantBottleneck).toEqual({ phase: "generation", p95Ms: 400 });
  });

  it("uses interpolated p50 and p95 percentiles", () => {
    expect(percentiles([1, 2, 3, 4])).toEqual({ count: 4, p50: 2.5, p95: 3.9 });
  });
});
