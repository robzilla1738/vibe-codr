import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerformanceStore } from "./performance-store";

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
    await writeFile(path, `${JSON.stringify({ recordedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 })}\n`);
    const store = new PerformanceStore(root);
    const now = Date.now();
    store.observeEngineEvent({ type: "user-message", sessionId: "ses-a", turnId: "turn-a", text: "secret prompt" });
    store.observeEngineEvent({ type: "assistant-text-delta", sessionId: "ses-a", delta: "secret output" });
    store.observeEngineEvent({
      type: "turn-performance",
      sessionId: "ses-a",
      sample: {
        turnId: "turn-a", sessionId: "ses-a", model: "xai/grok-4.5", serviceTier: "default",
        startedAt: now - 25, queueDelayMs: 1, hooksMs: 1, checkpointMs: 2, recallMs: 1,
        attachmentsMs: 1, modelResolveMs: 1, contextPrepareMs: 2, providerTtftMs: 4,
        firstVisibleTextMs: 5, generationMs: 10, toolMs: 0, persistMs: 1,
        postTurnMs: 1, totalMs: 24, inputTokens: 10, outputTokens: 3,
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
});
