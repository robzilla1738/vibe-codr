import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { Block } from "../shared/reducer";
import { groupIntoTurns, updateGroupedTurns } from "../shared/reducer";
import { EngineBridge } from "./engine-bridge";
import { EngineEventCoalescer } from "./event-coalescer";
import type { HostLaunch } from "./host-resolver";

const perf = process.env.VIBE_PERF_BENCH === "1" ? describe : describe.skip;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

const hostSource = String.raw`
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.op === "rpc" && msg.method === "listProjects") {
      process.stdout.write(JSON.stringify({ type: "resp", id: msg.id, ok: true, value: [] }) + "\n");
    } else if (msg.op === "bootstrap") {
      process.stdout.write(JSON.stringify({ type: "ready", sessionId: "bench" }) + "\n");
    } else if (msg.op === "shutdown") process.exit(0);
  });
`;

function launch(): HostLaunch {
  return {
    executable: process.execPath,
    arguments: ["-e", hostSource],
    workingDirectory: process.cwd(),
    description: "performance fixture",
  };
}

function bridge(): EngineBridge {
  return new EngineBridge({
    resolveLaunch: launch,
    readyTimeoutMs: 5_000,
    rpcTimeoutMs: 5_000,
    stopTimeoutMs: 800,
  });
}

perf("desktop performance budgets", () => {
  it("records deterministic startup, stream, and 2,500-block transcript results", async () => {
    const cold: number[] = [];
    const prewarmed: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const coldBridge = bridge();
      let started = performance.now();
      await coldBridge.start({ cwd: process.cwd() });
      cold.push(performance.now() - started);
      await coldBridge.stop();

      const warmBridge = bridge();
      await warmBridge.listProjectsForIndex();
      started = performance.now();
      await warmBridge.start({ cwd: process.cwd() });
      prewarmed.push(performance.now() - started);
      await warmBridge.stop();
    }

    const delivered: unknown[] = [];
    const coalescer = new EngineEventCoalescer((event) => delivered.push(event), { windowMs: 60_000 });
    const streamStarted = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      coalescer.push({ type: "assistant-text-delta", sessionId: "bench", delta: "x" });
    }
    coalescer.flush();
    const streamMs = performance.now() - streamStarted;

    const blocks: Block[] = [];
    for (let index = 0; index < 1_250; index += 1) {
      blocks.push({ kind: "user", id: index * 2, text: "prompt", timestamp: index });
      blocks.push({ kind: "assistant", id: index * 2 + 1, text: "answer", streaming: false, gap: true, timestamp: index });
    }
    let previousBlocks = blocks;
    let turns = groupIntoTurns(previousBlocks);
    const flushes: number[] = [];
    for (let run = 0; run < 500; run += 1) {
      const next = previousBlocks.slice();
      const tail = next.at(-1)! as Extract<Block, { kind: "assistant" }>;
      next[next.length - 1] = { ...tail, text: `${tail.text}x`, streaming: true };
      const started = performance.now();
      turns = updateGroupedTurns(previousBlocks, turns, next);
      flushes.push(performance.now() - started);
      previousBlocks = next;
    }

    const result = {
      startupColdMedianMs: median(cold),
      startupPrewarmedMedianMs: median(prewarmed),
      startupReduction: 1 - median(prewarmed) / median(cold),
      streamInputEvents: 10_000,
      streamDeliveredEvents: delivered.length,
      streamReduction: 1 - delivered.length / 10_000,
      streamProcessingMs: streamMs,
      transcriptFlushP95Ms: percentile(flushes, 0.95),
      transcriptFlushMaxMs: Math.max(...flushes),
    };
    console.info("VIBE_PERFORMANCE_RESULT", JSON.stringify(result));
    expect(result.startupReduction).toBeGreaterThanOrEqual(0.25);
    expect(result.streamReduction).toBeGreaterThanOrEqual(0.6);
    expect(result.transcriptFlushP95Ms).toBeLessThan(16.7);
    expect(result.transcriptFlushMaxMs).toBeLessThan(50);
  }, 60_000);
});

