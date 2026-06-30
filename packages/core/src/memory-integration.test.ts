import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { UIEvent } from "@vibe/shared";
import { ProviderRegistry } from "@vibe/providers";
import { Toolset } from "@vibe/tools";
import { defaultConfig } from "@vibe/config";
import { EventBus } from "./event-bus.ts";
import { Session } from "./session.ts";
import { MemoryService } from "./memory-service.ts";

function mockRegistry(model: MockLanguageModelV2) {
  return new ProviderRegistry([
    { id: "mock", auth: { env: [], keyless: true }, create: () => model, listModels: async () => [] },
  ]);
}
function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

test("save_memory persists a fact that recall_memory then surfaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mem-int-"));
  // Lexical memory service (no embedder) — deterministic and offline.
  const config = { ...defaultConfig(), memory: { ...defaultConfig().memory, semantic: { enabled: false, model: "off" } } };
  const memory = await MemoryService.create(dir, config, new ProviderRegistry());

  // Turn 1: the model saves a durable fact.
  // Turn 2 (new run): the model recalls it.
  const steps = [
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "s1", toolName: "save_memory", input: JSON.stringify({ fact: "deploys to Fly.io via GitHub Actions" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "saved" },
      { type: "text-end", id: "a" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "r1", toolName: "recall_memory", input: JSON.stringify({ query: "Fly.io GitHub Actions deploy target" }) },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ]),
    stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "recalled" },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]),
  ];
  let call = 0;
  const model = new MockLanguageModelV2({ doStream: async () => steps[call++] as never });

  const bus = new EventBus();
  const events: UIEvent[] = [];
  const sub = bus.subscribe();
  const collector = (async () => {
    for await (const e of sub) events.push(e);
  })();

  const session = new Session({
    config: { ...config, approvalMode: "auto" }, // auto-allow the save_memory write
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus,
    cwd: dir,
    model: "mock/test",
    mode: "execute",
    memory,
  });

  await session.run("remember our deploy target");
  await session.run("where do we deploy?");
  bus.close();
  await collector;

  // The recall_memory tool result fed back to the model contains the saved fact.
  const recall = events.find(
    (e) => e.type === "tool-call-finished" && e.toolName === "recall_memory",
  );
  const out = recall && recall.type === "tool-call-finished" ? String(recall.output) : "";
  expect(out).toContain("Fly.io");
  memory.close();
});

test("setRecalledContext is injected into the system prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mem-rc-"));
  const systems: string[] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      systems.push(JSON.stringify(options.prompt));
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        { type: "text-delta", id: "p", delta: "ok" },
        { type: "text-end", id: "p" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: dir,
    model: "mock/test",
    mode: "execute",
  });
  session.setRecalledContext("RECALL-MARKER-123 we chose Postgres");
  await session.run("hi");
  expect(systems[0]).toContain("RECALL-MARKER-123");
  expect(systems[0]).toContain("RELEVANT PAST CONTEXT");
});

test("buildDigest summarizes a worked session and skips an empty one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mem-dg-"));
  const model = new MockLanguageModelV2({
    doStream: async () =>
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "built the loader" },
        { type: "text-end", id: "a" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never,
    doGenerate: async () => ({
      content: [{ type: "text", text: "Built the JSONC config loader; chose comment-stripping; gotcha: trailing commas." }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
  const session = new Session({
    config: defaultConfig(),
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: dir,
    model: "mock/test",
    mode: "execute",
  });
  // Nothing worked yet → no digest.
  expect(await session.buildDigest()).toBeUndefined();
  await session.run("build the config loader");
  const digest = await session.buildDigest();
  expect(digest).toBeDefined();
  expect(digest).toContain("config loader");
  // Single compact line (no markdown headings / newlines).
  expect(digest).not.toContain("\n");
});

test("save_memory is not offered in plan mode (read-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mem-plan-"));
  const config = { ...defaultConfig(), memory: { ...defaultConfig().memory, semantic: { enabled: false, model: "off" } } };
  const memory = await MemoryService.create(dir, config, new ProviderRegistry());
  const toolNames: string[][] = [];
  const model = new MockLanguageModelV2({
    doStream: async (options) => {
      const tools = (options as { tools?: { name: string }[] }).tools ?? [];
      toolNames.push(tools.map((t) => t.name));
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p" },
        { type: "text-delta", id: "p", delta: "planning" },
        { type: "text-end", id: "p" },
        { type: "finish", finishReason: "stop", usage: USAGE },
      ]) as never;
    },
  });
  const session = new Session({
    config,
    registry: mockRegistry(model),
    toolset: new Toolset([]),
    bus: new EventBus(),
    cwd: dir,
    model: "mock/test",
    mode: "plan",
    memory,
  });
  await session.run("plan something");
  // recall_memory (read-only) is available while planning; save_memory (a write) is not.
  expect(toolNames[0]).toContain("recall_memory");
  expect(toolNames[0]).not.toContain("save_memory");
  memory.close();
});
