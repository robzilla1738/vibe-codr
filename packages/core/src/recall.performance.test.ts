import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Message } from "@vibe/shared";
import { globalStateDir } from "./state-dir.ts";
import { _resetRecallCache, searchSessions } from "./recall.ts";

process.env.VIBE_STATE_DIR ??= mkdtempSync(join(tmpdir(), "vibe-state-"));

test("cached BM25 searches 10,000 messages within the 150ms p95 desktop budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vibe-recall-perf-"));
  const dir = join(globalStateDir(cwd), "sessions", "ses_perf");
  await mkdir(dir, { recursive: true });
  const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `m_${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: index === 8_888 ? "unique flux capacitor decision" : `ordinary session message ${index}` }],
    createdAt: index,
  }));
  await writeFile(join(dir, "meta.json"), JSON.stringify({
    version: 2, id: "ses_perf", model: "m", mode: "execute", goal: null,
    createdAt: 1, updatedAt: 10_000, turns: [],
  }));
  await writeFile(join(dir, "messages.jsonl"), "");
  await writeFile(join(dir, "history.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n"));
  _resetRecallCache();
  await searchSessions(cwd, "flux capacitor", { limit: 5 });
  const samples: number[] = [];
  for (let run = 0; run < 12; run += 1) {
    const started = performance.now();
    const hits = await searchSessions(cwd, "flux capacitor", { limit: 5 });
    samples.push(performance.now() - started);
    expect(hits[0]?.snippet).toContain("flux capacitor");
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
  expect(p95).toBeLessThanOrEqual(150);
});
